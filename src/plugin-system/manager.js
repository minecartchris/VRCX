import { reactive } from 'vue';

import configRepository from '../services/config';
import { createPluginContext } from './context';
import {
    getAllPlugins,
    getPlugin,
    resolveDependencies,
    resolveDependents
} from './registry';
import { normalizeSettings } from './settingsSchema';

const ENABLED_CONFIG_KEY = 'VRCX_enabledPlugins';
const SETTINGS_CONFIG_KEY_PREFIX = 'VRCX_pluginSettings_';

/**
 * @typedef {'inactive'|'starting'|'active'|'error'} PluginRunState
 */

/**
 * Reactive view of every registered plugin's runtime state. Keyed by plugin id.
 *
 * @type {Record<string, {enabled: boolean, runState: PluginRunState, status: string, statusState: 'ok'|'warning'|'error', settings: Record<string, *>}>}
 */
export const pluginState = reactive({});

/** @type {Map<string, ReturnType<typeof createPluginContext>>} */
const contexts = new Map();

/** Serialises activate/deactivate per plugin so rapid toggling cannot race. */
/** @type {Map<string, Promise<void>>} */
const transitions = new Map();

let initialised = false;

/**
 * @param {string} id
 * @returns {string}
 */
function settingsConfigKey(id) {
    return `${SETTINGS_CONFIG_KEY_PREFIX}${id}`;
}

/**
 * @param {string} id
 */
function ensureState(id) {
    if (!pluginState[id]) {
        pluginState[id] = {
            enabled: false,
            runState: 'inactive',
            status: '',
            statusState: 'ok',
            settings: {}
        };
    }
    return pluginState[id];
}

/**
 * Loads persisted enable flags and settings for every registered plugin.
 * Safe to call more than once; subsequent calls are no-ops.
 *
 * @returns {Promise<void>}
 */
export async function initPluginManager() {
    if (initialised) {
        return;
    }
    initialised = true;

    const plugins = getAllPlugins();
    let enabledIds = [];
    try {
        enabledIds = await configRepository.getArray(ENABLED_CONFIG_KEY, null);
    } catch (err) {
        console.error('[plugins] failed to read enabled plugin list', err);
    }
    const isFirstRun = !Array.isArray(enabledIds);
    const enabledSet = new Set(Array.isArray(enabledIds) ? enabledIds : []);

    await Promise.all(
        plugins.map(async (manifest) => {
            const state = ensureState(manifest.id);
            let stored = null;
            try {
                stored = await configRepository.getObject(
                    settingsConfigKey(manifest.id),
                    null
                );
            } catch (err) {
                console.error(
                    `[plugins] failed to read settings for "${manifest.id}"`,
                    err
                );
            }
            state.settings = normalizeSettings(manifest.settingsSchema, stored);
            state.enabled = isFirstRun
                ? Boolean(manifest.enabledByDefault)
                : enabledSet.has(manifest.id);
        })
    );

    if (isFirstRun) {
        await persistEnabled();
    }

    // Start everything that should already be running.
    await Promise.all(
        plugins
            .filter((manifest) => pluginState[manifest.id].enabled)
            .map((manifest) => activatePlugin(manifest.id, { persist: false }))
    );
}

/**
 * @returns {Promise<void>}
 */
async function persistEnabled() {
    const enabled = Object.keys(pluginState).filter(
        (id) => pluginState[id].enabled
    );
    await configRepository.setArray(ENABLED_CONFIG_KEY, enabled);
}

/**
 * @param {string} id
 * @param {() => Promise<void>} run
 * @returns {Promise<void>}
 */
function queueTransition(id, run) {
    const previous = transitions.get(id) ?? Promise.resolve();
    // Run on both settle paths: a failed transition must not stall the queue.
    const next = previous.then(run, run).catch((err) => {
        console.error(`[plugins] transition for "${id}" failed`, err);
    });
    transitions.set(id, next);
    return next;
}

/**
 * @param {string} id
 * @param {{persist?: boolean}} [options]
 * @returns {Promise<void>}
 */
export function activatePlugin(id, { persist = true } = {}) {
    return queueTransition(id, async () => {
        const manifest = getPlugin(id);
        if (!manifest) {
            console.warn(`[plugins] cannot activate unknown plugin "${id}"`);
            return;
        }
        const state = ensureState(id);
        state.enabled = true;
        if (persist) {
            await persistEnabled();
        }
        if (state.runState === 'active' || state.runState === 'starting') {
            return;
        }

        state.runState = 'starting';
        state.status = '';
        state.statusState = 'ok';

        const context = createPluginContext({
            id,
            settings: state.settings,
            /**
             * @param {{state?: 'ok'|'warning'|'error', detail?: string}} status
             */
            onStatus: ({ state: statusState, detail }) => {
                const current = pluginState[id];
                if (!current) {
                    return;
                }
                current.status = detail ?? '';
                current.statusState = statusState ?? 'ok';
            }
        });
        contexts.set(id, context);

        try {
            await manifest.setup?.(context);
            state.runState = 'active';
        } catch (err) {
            console.error(`[plugins] "${id}" failed to start`, err);
            state.runState = 'error';
            state.statusState = 'error';
            state.status = err instanceof Error ? err.message : String(err);
            contexts.delete(id);
            await context.dispose();
        }
    });
}

/**
 * @param {string} id
 * @param {{persist?: boolean}} [options]
 * @returns {Promise<void>}
 */
export function deactivatePlugin(id, { persist = true } = {}) {
    return queueTransition(id, async () => {
        const state = ensureState(id);
        state.enabled = false;
        if (persist) {
            await persistEnabled();
        }
        const context = contexts.get(id);
        contexts.delete(id);
        if (!context) {
            state.runState = 'inactive';
            return;
        }
        try {
            await getPlugin(id)?.teardown?.(context);
        } catch (err) {
            console.error(`[plugins] "${id}" teardown threw`, err);
        }
        await context.dispose();
        state.runState = 'inactive';
        state.status = '';
        state.statusState = 'ok';
    });
}

/**
 * Enables a plugin along with anything it depends on.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function enablePlugin(id) {
    for (const dependency of resolveDependencies(id)) {
        if (!pluginState[dependency]?.enabled) {
            await activatePlugin(dependency);
        }
    }
    await activatePlugin(id);
}

/**
 * Disables a plugin and anything that depends on it, so the tree never ends up
 * with a dependent running against a dead dependency.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function disablePlugin(id) {
    for (const dependent of resolveDependents(id)) {
        if (pluginState[dependent]?.enabled) {
            await deactivatePlugin(dependent);
        }
    }
    await deactivatePlugin(id);
}

/**
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
export function setPluginEnabled(id, enabled) {
    return enabled ? enablePlugin(id) : disablePlugin(id);
}

/**
 * Applies a settings patch, persists it, and restarts the plugin so `setup`
 * observes the new values.
 *
 * @param {string} id
 * @param {Record<string, *>} patch
 * @returns {Promise<void>}
 */
export async function updatePluginSettings(id, patch) {
    const manifest = getPlugin(id);
    if (!manifest) {
        return;
    }
    const state = ensureState(id);
    const merged = normalizeSettings(manifest.settingsSchema, {
        ...state.settings,
        ...patch
    });
    // Mutate in place: plugin contexts hold a readonly proxy of this object.
    for (const key of Object.keys(state.settings)) {
        if (!(key in merged)) {
            delete state.settings[key];
        }
    }
    Object.assign(state.settings, merged);
    await configRepository.setObject(settingsConfigKey(id), merged);

    if (state.enabled && state.runState !== 'inactive') {
        await deactivatePlugin(id, { persist: false });
        await activatePlugin(id, { persist: false });
    }
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function resetPluginSettings(id) {
    const manifest = getPlugin(id);
    if (!manifest) {
        return;
    }
    await updatePluginSettings(
        id,
        normalizeSettings(manifest.settingsSchema, null)
    );
}

/**
 * @param {string} id
 * @returns {Record<string, *>}
 */
export function getPluginSettings(id) {
    return pluginState[id]?.settings ?? {};
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isPluginActive(id) {
    return pluginState[id]?.runState === 'active';
}

/**
 * Stops every running plugin. Used on logout/teardown.
 *
 * @returns {Promise<void>}
 */
export async function shutdownPlugins() {
    await Promise.all(
        Array.from(contexts.keys()).map((id) =>
            deactivatePlugin(id, { persist: false })
        )
    );
}

/** Test helper. */
export function resetPluginManager() {
    initialised = false;
    contexts.clear();
    transitions.clear();
    for (const key of Object.keys(pluginState)) {
        delete pluginState[key];
    }
}
