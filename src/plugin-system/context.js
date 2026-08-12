import { readonly, watch } from 'vue';
import * as workerTimers from 'worker-timers';

import configRepository from '../services/config';
import { oscService } from '../services/osc';
import { pluginBus, PluginEvents } from './eventBus';
import {
    emptyInstanceSnapshot,
    getFriendSnapshot,
    getInstanceSnapshot
} from './sources';
import { registerChatboxSource } from './chatbox';
import { writePluginFeed } from './feed';

/**
 * Per-plugin runtime context.
 *
 * Everything a plugin registers through the context (event handlers, timers,
 * watchers, arbitrary disposers) is tracked so the manager can tear a plugin
 * down completely when it is disabled — plugins never have to bookkeep their
 * own cleanup.
 *
 * @typedef {object} PluginContext
 * @property {string} id
 * @property {typeof PluginEvents} events
 * @property {Readonly<Record<string, *>>} settings
 * @property {(event: string, handler: Function) => () => void} on
 * @property {(event: string, payload?: *) => void} emit
 * @property {(handler: Function, ms: number) => number} interval
 * @property {(handler: Function, ms: number) => number} timeout
 * @property {(source: *, cb: Function, options?: object) => void} watch
 * @property {(dispose: Function) => void} onDispose
 * @property {(endpoint: string, options?: {method?: string, params?: object}) => Promise<*>} api
 * @property {(groupId: string, userId: string) => Promise<*>} inviteToGroup
 * @property {() => object[]} friends
 * @property {() => object} instance
 * @property {(render: () => (string|null|undefined), options?: {label?: string, order?: number}) => (() => void)} chatbox
 * @property {(handler: (message: {address: string, args: any[]}) => void, config?: {host?: string, sendPort?: number, receivePort?: number}) => Promise<boolean>} oscListen
 * @property {(message: string, options?: {detail?: string, level?: string, userId?: string, displayName?: string}) => Promise<object|null>} feed
 * @property {{get: (key: string, fallback?: *) => Promise<*>, set: (key: string, value: *) => Promise<void>}} storage
 * @property {(message: string, detail?: string) => void} log
 * @property {(message: string, detail?: *) => void} warn
 * @property {(message: string, detail?: *) => void} error
 * @property {(detail: string, state?: 'ok'|'warning'|'error') => void} setStatus
 */

/**
 * @param {string} pluginId
 * @param {string} key
 * @returns {string}
 */
function storageKey(pluginId, key) {
    return `VRCX_plugin_${pluginId}_${key}`;
}

/**
 * Minimum gap between VRChat API calls made by plugins, in milliseconds.
 *
 * Plugin code is frequently a loop over a friend list, which without a queue
 * would fire hundreds of requests as fast as the event loop allows. That trips
 * VRChat's rate limiter and, for anything invite-shaped, looks exactly like
 * spam. Every plugin shares this queue so several plugins cannot gang up.
 */
const API_MIN_INTERVAL_MS = 1200;

/** @type {Promise<void>} */
let apiQueue = Promise.resolve();
let lastApiCallAt = 0;

/**
 * Serialises an API call behind the shared throttle.
 *
 * @param {() => Promise<*>} run
 * @returns {Promise<*>}
 */
function enqueueApiCall(run) {
    const next = apiQueue.then(async () => {
        const wait = Math.max(
            0,
            API_MIN_INTERVAL_MS - (Date.now() - lastApiCallAt)
        );
        if (wait > 0) {
            await new Promise((resolve) => {
                workerTimers.setTimeout(resolve, wait);
            });
        }
        lastApiCallAt = Date.now();
        return run();
    });
    // Keep the chain alive after a rejection, or one failed call would wedge
    // every later call from every plugin.
    apiQueue = next.then(
        () => undefined,
        () => undefined
    );
    return next;
}

/** Test helper. */
export function resetApiThrottle() {
    apiQueue = Promise.resolve();
    lastApiCallAt = 0;
}

/**
 * @param {object} options
 * @param {string} options.id plugin id
 * @param {import('vue').Ref<Record<string, *>> | object} options.settings reactive settings object
 * @param {(status: {state?: string, detail?: string}) => void} [options.onStatus]
 * @returns {PluginContext & {dispose: () => Promise<void>}}
 */
export function createPluginContext({ id, name, settings, onStatus }) {
    /** @type {Function[]} */
    const disposers = [];
    let disposed = false;

    /**
     * @param {Function} dispose
     */
    function onDispose(dispose) {
        if (typeof dispose !== 'function') {
            return;
        }
        if (disposed) {
            // Registering after teardown means the resource would leak.
            try {
                dispose();
            } catch (err) {
                console.error(`[plugin:${id}] late disposer threw`, err);
            }
            return;
        }
        disposers.push(dispose);
    }

    const context = {
        id,
        events: PluginEvents,
        settings: readonly(settings),

        on(event, handler) {
            const off = pluginBus.on(event, (payload) => {
                try {
                    handler(payload);
                } catch (err) {
                    console.error(`[plugin:${id}] "${event}" handler`, err);
                }
            });
            onDispose(off);
            return off;
        },

        emit(event, payload) {
            pluginBus.emit(event, payload);
        },

        interval(handler, ms) {
            const safeMs = Math.max(50, Math.floor(Number(ms) || 0));
            const handle = workerTimers.setInterval(() => {
                try {
                    handler();
                } catch (err) {
                    console.error(`[plugin:${id}] interval`, err);
                }
            }, safeMs);
            onDispose(() => {
                try {
                    workerTimers.clearInterval(handle);
                } catch {
                    /* already cleared */
                }
            });
            return handle;
        },

        timeout(handler, ms) {
            const safeMs = Math.max(0, Math.floor(Number(ms) || 0));
            const handle = workerTimers.setTimeout(() => {
                try {
                    handler();
                } catch (err) {
                    console.error(`[plugin:${id}] timeout`, err);
                }
            }, safeMs);
            onDispose(() => {
                try {
                    workerTimers.clearTimeout(handle);
                } catch {
                    /* already fired */
                }
            });
            return handle;
        },

        watch(source, callback, options) {
            const stop = watch(source, callback, options);
            onDispose(stop);
            return stop;
        },

        storage: {
            async get(key, fallback = null) {
                const raw = await configRepository.getString(
                    storageKey(id, key),
                    null
                );
                if (raw === null) {
                    return fallback;
                }
                try {
                    return JSON.parse(raw);
                } catch {
                    return fallback;
                }
            },
            async set(key, value) {
                await configRepository.setString(
                    storageKey(id, key),
                    JSON.stringify(value ?? null)
                );
            }
        },

        onDispose,

        /**
         * Calls the VRChat API through VRCX's own request layer, so the call
         * inherits its authentication, error handling and logging.
         *
         * Every call goes through a shared throttle — see API_MIN_INTERVAL_MS.
         * Endpoints are relative, e.g. `groups/grp_x/invites`.
         *
         * @param {string} endpoint
         * @param {{method?: string, params?: object}} [options]
         * @returns {Promise<*>} the decoded response body
         */
        api(endpoint, options = {}) {
            const path = String(endpoint ?? '')
                .trim()
                .replace(/^\/+/, '');
            if (!path) {
                return Promise.reject(new Error('api() needs an endpoint'));
            }
            const method = String(options.method ?? 'GET').toUpperCase();
            // Imported lazily: `services/request` pulls in the store and
            // coordinator graph, which the plugin context must not force to
            // load just to exist.
            return enqueueApiCall(async () => {
                const { request } = await import('../services/request');
                return request(path, { method, params: options.params ?? {} });
            });
        },

        /**
         * Invites a user to a group.
         *
         * Thin wrapper over the API call so the common case does not require
         * knowing the endpoint shape.
         *
         * @param {string} groupId
         * @param {string} userId
         * @returns {Promise<*>}
         */
        inviteToGroup(groupId, userId) {
            const group = String(groupId ?? '').trim();
            const user = String(userId ?? '').trim();
            if (!group || !user) {
                return Promise.reject(
                    new Error('inviteToGroup needs a group id and a user id')
                );
            }
            return context.api(`groups/${group}/invites`, {
                method: 'POST',
                params: { userId: user }
            });
        },

        /**
         * The local user's friends, as plain values.
         *
         * @returns {Array<{userId: string, displayName: string, state: string, status: string, location: string, isOnline: boolean, isFavorite: boolean}>}
         */
        friends() {
            try {
                return getFriendSnapshot();
            } catch (err) {
                console.error(`[plugin:${id}] friend snapshot failed`, err);
                return [];
            }
        },

        /**
         * A snapshot of the instance the local user is in.
         *
         * Read fresh on every call, so a plugin holding onto the result gets a
         * point-in-time value rather than a live view of the store.
         *
         * @returns {ReturnType<typeof getInstanceSnapshot>}
         */
        instance() {
            try {
                return getInstanceSnapshot();
            } catch (err) {
                console.error(`[plugin:${id}] instance snapshot failed`, err);
                return emptyInstanceSnapshot();
            }
        },

        /**
         * Contributes a line to the OSC chatbox.
         *
         * Imported plugins cannot import VRCX modules, so this is their only
         * route to the chatbox. The source is torn down with the plugin.
         *
         * @param {() => (string | null | undefined)} render
         * @param {{label?: string, order?: number}} [options]
         * @returns {() => void} unregister
         */
        chatbox(render, options = {}) {
            if (typeof render !== 'function') {
                throw new TypeError('chatbox(render) needs a function');
            }
            const unregister = registerChatboxSource({
                id,
                label: options.label || name || id,
                order: Number.isFinite(Number(options.order))
                    ? Number(options.order)
                    : 100,
                render
            });
            onDispose(unregister);
            return unregister;
        },

        /**
         * Receives OSC messages.
         *
         * The transport is shared and reference counted, so passing a
         * `receivePort` different from the one already in use re-opens it for
         * every plugin. Only override it when listening to something other
         * than VRChat.
         *
         * @param {(message: {address: string, args: any[]}) => void} handler
         * @param {{host?: string, sendPort?: number, receivePort?: number}} [config]
         * @returns {Promise<boolean>} whether the transport opened
         */
        async oscListen(handler, config = {}) {
            if (typeof handler !== 'function') {
                throw new TypeError('oscListen(handler) needs a function');
            }
            const off = oscService.onMessage((message) => {
                try {
                    handler(message);
                } catch (err) {
                    console.error(`[plugin:${id}] osc handler`, err);
                }
            });
            onDispose(off);
            const opened = await oscService.acquire(id, config);
            onDispose(() => oscService.release(id));
            return opened;
        },

        /**
         * Writes a line into the Feed tab's "Plugin" category.
         *
         * @param {string} message
         * @param {{detail?: string, level?: 'info'|'success'|'warning'|'error', userId?: string, displayName?: string, createdAt?: string}} [options]
         * @returns {Promise<object | null>}
         */
        feed(message, options) {
            return writePluginFeed(
                { pluginId: id, pluginName: name, message },
                options
            ).catch((err) => {
                console.error(`[plugin:${id}] feed write failed`, err);
                return null;
            });
        },

        log(message, detail) {
            console.log(`[plugin:${id}] ${message}`, detail ?? '');
        },
        warn(message, detail) {
            console.warn(`[plugin:${id}] ${message}`, detail ?? '');
        },
        error(message, detail) {
            console.error(`[plugin:${id}] ${message}`, detail ?? '');
        },

        /**
         * Surfaces a short status line in the plugin manager UI.
         *
         * @param {string} detail
         * @param {'ok'|'warning'|'error'} [state]
         */
        setStatus(detail, state = 'ok') {
            onStatus?.({ state, detail });
        },

        async dispose() {
            disposed = true;
            // Dispose in reverse registration order so dependent resources
            // (e.g. a timer started by a listener) go first.
            while (disposers.length > 0) {
                const dispose = disposers.pop();
                try {
                    await dispose?.();
                } catch (err) {
                    console.error(`[plugin:${id}] disposer threw`, err);
                }
            }
        }
    };

    return context;
}
