import { readonly, watch } from 'vue';
import * as workerTimers from 'worker-timers';

import configRepository from '../services/config';
import { pluginBus, PluginEvents } from './eventBus';

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
 * @param {object} options
 * @param {string} options.id plugin id
 * @param {import('vue').Ref<Record<string, *>> | object} options.settings reactive settings object
 * @param {(status: {state?: string, detail?: string}) => void} [options.onStatus]
 * @returns {PluginContext & {dispose: () => Promise<void>}}
 */
export function createPluginContext({ id, settings, onStatus }) {
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
