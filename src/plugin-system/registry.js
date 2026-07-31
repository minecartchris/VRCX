/**
 * Plugin registry.
 *
 * Plugins are plain objects (a "manifest") that describe themselves and expose
 * optional `setup` / `teardown` hooks. They are registered here at module load
 * time; enabling/disabling and lifecycle are handled by the manager.
 */

/**
 * @typedef {object} PluginManifest
 * @property {string} id stable, kebab-case, unique
 * @property {string} name human readable name (fallback when no i18n key)
 * @property {string} [nameKey] i18n key for the name
 * @property {string} [description]
 * @property {string} [descriptionKey]
 * @property {string} [icon] remixicon class, e.g. `ri-chat-3-line`
 * @property {string} [category] see `pluginCategories`
 * @property {string[]} [tags]
 * @property {string[]} [requires] ids of plugins that must be enabled too
 * @property {boolean} [enabledByDefault]
 * @property {boolean} [experimental]
 * @property {'windows'|'linux'|'any'} [platform]
 * @property {import('./settingsSchema').PluginSettingField[]} [settingsSchema]
 * @property {(ctx: import('./context').PluginContext) => (void | Promise<void>)} [setup]
 * @property {(ctx: import('./context').PluginContext) => (void | Promise<void>)} [teardown]
 */

export const pluginCategories = Object.freeze([
    { key: 'chatbox', labelKey: 'view.plugins.category.chatbox' },
    { key: 'osc', labelKey: 'view.plugins.category.osc' },
    { key: 'social', labelKey: 'view.plugins.category.social' },
    { key: 'automation', labelKey: 'view.plugins.category.automation' },
    { key: 'insights', labelKey: 'view.plugins.category.insights' },
    { key: 'integration', labelKey: 'view.plugins.category.integration' }
]);

const CATEGORY_KEYS = new Set(pluginCategories.map((c) => c.key));

/** @type {Map<string, PluginManifest>} */
const registry = new Map();

/**
 * Validates a manifest, throwing on programmer error.
 *
 * @param {PluginManifest} manifest
 */
export function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new TypeError('plugin manifest must be an object');
    }
    if (typeof manifest.id !== 'string' || !/^[a-z0-9-]+$/.test(manifest.id)) {
        throw new TypeError(
            `plugin id must be kebab-case, got "${manifest.id}"`
        );
    }
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new TypeError(`plugin "${manifest.id}" is missing a name`);
    }
    if (manifest.category && !CATEGORY_KEYS.has(manifest.category)) {
        throw new TypeError(
            `plugin "${manifest.id}" has unknown category "${manifest.category}"`
        );
    }
    if (manifest.setup && typeof manifest.setup !== 'function') {
        throw new TypeError(`plugin "${manifest.id}" setup must be a function`);
    }
    if (manifest.teardown && typeof manifest.teardown !== 'function') {
        throw new TypeError(
            `plugin "${manifest.id}" teardown must be a function`
        );
    }
}

/**
 * @param {PluginManifest} manifest
 * @returns {PluginManifest}
 */
export function registerPlugin(manifest) {
    validateManifest(manifest);
    if (registry.has(manifest.id)) {
        throw new Error(`plugin "${manifest.id}" is already registered`);
    }
    registry.set(manifest.id, manifest);
    return manifest;
}

/**
 * @param {PluginManifest[]} manifests
 */
export function registerPlugins(manifests) {
    for (const manifest of manifests) {
        registerPlugin(manifest);
    }
}

/**
 * Removes a plugin from the registry. Only imported plugins are removable —
 * the built-ins are part of the app.
 *
 * @param {string} id
 * @returns {boolean} whether anything was removed
 */
export function unregisterPlugin(id) {
    const manifest = registry.get(id);
    if (!manifest?.external) {
        return false;
    }
    return registry.delete(id);
}

/**
 * @param {string} id
 * @returns {PluginManifest | undefined}
 */
export function getPlugin(id) {
    return registry.get(id);
}

/**
 * @returns {PluginManifest[]}
 */
export function getAllPlugins() {
    return Array.from(registry.values());
}

/**
 * @param {string} category
 * @returns {PluginManifest[]}
 */
export function getPluginsByCategory(category) {
    return getAllPlugins().filter((plugin) => plugin.category === category);
}

/**
 * Resolves the transitive `requires` closure of a plugin, dependencies first.
 *
 * @param {string} id
 * @param {Set<string>} [seen]
 * @returns {string[]}
 */
export function resolveDependencies(id, seen = new Set()) {
    if (seen.has(id)) {
        return [];
    }
    seen.add(id);
    const manifest = registry.get(id);
    if (!manifest?.requires?.length) {
        return [];
    }
    const result = [];
    for (const dependency of manifest.requires) {
        if (!registry.has(dependency)) {
            console.warn(
                `[plugins] "${id}" requires unknown plugin "${dependency}"`
            );
            continue;
        }
        result.push(...resolveDependencies(dependency, seen), dependency);
    }
    return Array.from(new Set(result));
}

/**
 * Plugins that declare `id` in their `requires`, transitively.
 *
 * @param {string} id
 * @returns {string[]}
 */
export function resolveDependents(id) {
    return getAllPlugins()
        .filter(
            (plugin) =>
                plugin.id !== id && resolveDependencies(plugin.id).includes(id)
        )
        .map((plugin) => plugin.id);
}

/** Test helper. */
export function clearRegistry() {
    registry.clear();
}
