/**
 * Lets plugins write into the Feed tab's "Plugin" category.
 *
 * Entries are persisted to their own table and, when the currently applied feed
 * filters allow it, appended to the live table so they show up without a
 * refresh. The store is imported lazily for the same reason `stores.js` does it:
 * plugin modules load eagerly for the settings screen and must stay out of the
 * store graph.
 */

const LEVELS = new Set(['info', 'success', 'warning', 'error']);

/**
 * @param {string} [level]
 * @returns {'info'|'success'|'warning'|'error'}
 */
export function normalizeLevel(level) {
    const value = String(level ?? '').toLowerCase();
    return LEVELS.has(value) ? value : 'info';
}

/**
 * Builds the row written to the database and pushed onto the feed table.
 *
 * @param {object} input
 * @param {string} input.pluginId
 * @param {string} [input.pluginName]
 * @param {string} input.message
 * @param {object} [options]
 * @param {string} [options.detail]
 * @param {string} [options.level]
 * @param {string} [options.userId]
 * @param {string} [options.displayName]
 * @param {string} [options.createdAt] ISO string, defaults to now
 * @returns {object | null} null when there is no message to show
 */
export function buildPluginFeedEntry(
    { pluginId, pluginName, message },
    options = {}
) {
    const text = String(message ?? '').trim();
    if (!text) {
        return null;
    }
    return {
        created_at: options.createdAt || new Date().toJSON(),
        type: 'Plugin',
        pluginId: String(pluginId ?? ''),
        pluginName: String(pluginName || pluginId || ''),
        level: normalizeLevel(options.level),
        message: text,
        detail: String(options.detail ?? ''),
        userId: String(options.userId ?? ''),
        displayName: String(options.displayName ?? '')
    };
}

/**
 * Persists a plugin feed entry and shows it live.
 *
 * Failures are swallowed on purpose: a plugin logging something must never take
 * down the plugin itself.
 *
 * @param {object} input see `buildPluginFeedEntry`
 * @param {object} [options]
 * @returns {Promise<object | null>} the entry that was written, if any
 */
export async function writePluginFeed(input, options = {}) {
    const entry = buildPluginFeedEntry(input, options);
    if (!entry) {
        return null;
    }
    try {
        const { database } = await import('../services/database');
        database.addPluginFeedToDatabase(entry);
    } catch (err) {
        console.error('[plugins] failed to persist feed entry', err);
    }
    try {
        const { useFeedStore } = await import('../stores/feed');
        useFeedStore().addFeedEntry(entry);
    } catch (err) {
        console.error('[plugins] failed to append feed entry', err);
    }
    return entry;
}
