/**
 * Persistence and lifecycle for plugins imported from GitHub.
 *
 * An import is stored with its fetched source pinned. Nothing is re-fetched on
 * startup, so a repository changing upstream cannot silently change what runs
 * on the user's machine — updating is an explicit action.
 */

import { reactive } from 'vue';

import configRepository from '../services/config';
import { disablePlugin, pluginState } from './manager';
import { fetchRemotePlugin, toPluginManifest } from './remote';
import { getPlugin, registerPlugin, unregisterPlugin } from './registry';

const CONFIG_KEY = 'VRCX_externalPlugins';

/**
 * @typedef {object} InstalledPlugin
 * @property {string} code canonical import code
 * @property {object} manifest validated `vrcx-plugin.json`
 * @property {string} source pinned entry source
 * @property {string} sourceUrl
 * @property {string} installedAt ISO string
 */

/**
 * Reactive list of installed imports, so the settings screen can render them.
 *
 * @type {InstalledPlugin[]}
 */
export const externalPlugins = reactive([]);

/**
 * Compile errors keyed by plugin id, surfaced in the UI.
 *
 * @type {Record<string, string>}
 */
export const externalPluginErrors = reactive({});

/**
 * @returns {Promise<void>}
 */
async function persist() {
    await configRepository.setArray(
        CONFIG_KEY,
        externalPlugins.map((entry) => ({ ...entry }))
    );
}

/**
 * @param {InstalledPlugin} installed
 * @returns {boolean} whether it was registered
 */
function register(installed) {
    const id = installed.manifest?.id;
    if (!id) {
        return false;
    }
    if (getPlugin(id)) {
        externalPluginErrors[id] =
            `A plugin with the id "${id}" is already registered.`;
        return false;
    }
    try {
        registerPlugin(toPluginManifest(installed));
        delete externalPluginErrors[id];
        return true;
    } catch (err) {
        externalPluginErrors[id] =
            err instanceof Error ? err.message : String(err);
        console.error(`[plugins] failed to register imported "${id}"`, err);
        return false;
    }
}

/**
 * Loads previously imported plugins into the registry. Call before
 * `initPluginManager` so their enabled state is picked up with everything else.
 *
 * @returns {Promise<void>}
 */
export async function loadExternalPlugins() {
    let stored = null;
    try {
        stored = await configRepository.getArray(CONFIG_KEY, null);
    } catch (err) {
        console.error('[plugins] failed to read imported plugins', err);
    }
    if (!Array.isArray(stored)) {
        return;
    }
    externalPlugins.splice(0, externalPlugins.length);
    for (const entry of stored) {
        if (!entry?.manifest?.id || typeof entry.source !== 'string') {
            continue;
        }
        externalPlugins.push(entry);
        register(entry);
    }
}

/**
 * Fetches a code without installing it, for the confirmation step.
 *
 * @param {string} code
 * @returns {Promise<object>}
 */
export function previewExternalPlugin(code) {
    return fetchRemotePlugin(code);
}

/**
 * Installs a previewed plugin. It is registered but left disabled — the user
 * turns it on deliberately, after it is visible in the list.
 *
 * @param {{code: string, manifest: object, source: string, sourceUrl: string}} fetched
 * @returns {Promise<InstalledPlugin>}
 */
export async function installExternalPlugin(fetched) {
    const id = fetched.manifest.id;
    const existing = externalPlugins.findIndex(
        (entry) => entry.manifest.id === id
    );
    if (existing === -1 && getPlugin(id)) {
        throw new Error(
            `"${id}" clashes with a plugin that ships with VRCX. Ask the author to change its id.`
        );
    }

    /** @type {InstalledPlugin} */
    const installed = {
        code: fetched.code,
        manifest: fetched.manifest,
        source: fetched.source,
        sourceUrl: fetched.sourceUrl,
        installedAt: new Date().toJSON()
    };

    if (existing === -1) {
        externalPlugins.push(installed);
    } else {
        // Reinstalling the same id is an update: stop the running copy first so
        // the new source is what starts next.
        await disablePlugin(id);
        unregisterPlugin(id);
        externalPlugins.splice(existing, 1, installed);
    }
    register(installed);
    await persist();
    return installed;
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function uninstallExternalPlugin(id) {
    const index = externalPlugins.findIndex(
        (entry) => entry.manifest.id === id
    );
    if (index === -1) {
        return;
    }
    await disablePlugin(id);
    unregisterPlugin(id);
    delete pluginState[id];
    delete externalPluginErrors[id];
    externalPlugins.splice(index, 1);
    await persist();
}

/**
 * Re-fetches an installed plugin's code and reinstalls it.
 *
 * @param {string} id
 * @returns {Promise<InstalledPlugin>}
 */
export async function updateExternalPlugin(id) {
    const entry = externalPlugins.find((item) => item.manifest.id === id);
    if (!entry) {
        throw new Error(`"${id}" is not an imported plugin`);
    }
    const fetched = await fetchRemotePlugin(entry.code);
    if (fetched.manifest.id !== id) {
        throw new Error(
            `The plugin at ${entry.code} now declares the id "${fetched.manifest.id}"`
        );
    }
    return installExternalPlugin(fetched);
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isExternalPlugin(id) {
    return externalPlugins.some((entry) => entry.manifest.id === id);
}

/** Test helper. */
export function resetExternalPlugins() {
    externalPlugins.splice(0, externalPlugins.length);
    for (const key of Object.keys(externalPluginErrors)) {
        delete externalPluginErrors[key];
    }
}
