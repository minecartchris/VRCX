import { dbVars } from '../database';

import sqliteService from '../sqlite.js';

/**
 * Where each Feed type is stored. Online and Offline share one table and are told apart by its type column.
 *
 * Table names are only ever taken from this map, never from the caller, because they are interpolated into the SQL.
 */
const FEED_TYPE_TABLES = {
    GPS: { table: 'feed_gps' },
    Online: { table: 'feed_online_offline', type: 'Online' },
    Offline: { table: 'feed_online_offline', type: 'Offline' },
    Status: { table: 'feed_status' },
    Avatar: { table: 'feed_avatar' },
    Bio: { table: 'feed_bio' },
    Plugin: { table: 'feed_plugin' }
};

export const FEED_HISTORY_TYPES = Object.keys(FEED_TYPE_TABLES);

/**
 * @param {string[]} types
 * @returns {string[]} The known types among them, each once
 */
function knownTypes(types) {
    return [...new Set(types)].filter((type) => Object.hasOwn(FEED_TYPE_TABLES, type));
}

/**
 * @param {string} feedType
 * @param {string | null} cutoffDate
 * @returns {{ from: string; args: object | null }}
 */
function feedTypeQuery(feedType, cutoffDate) {
    const target = FEED_TYPE_TABLES[feedType];
    const conditions = [];
    const args = {};
    if (target.type) {
        conditions.push('type = @type');
        args['@type'] = target.type;
    }
    if (cutoffDate) {
        conditions.push('created_at < @cutoff');
        args['@cutoff'] = cutoffDate;
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    return {
        from: `${dbVars.userPrefix}_${target.table}${where}`,
        args: conditions.length ? args : null
    };
}

const feedHistory = {
    /**
     * Indexes the friend-event feed tables by created_at. Kept forever, these tables only grow, and "Load older
     * entries", date searches and Delete Feed Data all walk them by time; without the index every one of those is a
     * full scan and sort that blocks the database for seconds on a large history. The plugin table has its own.
     */
    async createFeedHistoryIndexes() {
        const tables = [...new Set(FEED_HISTORY_TYPES.map((type) => FEED_TYPE_TABLES[type].table))].filter(
            (table) => table !== 'feed_plugin'
        );
        for (const table of tables) {
            // Only a speed-up: failing to build one (a full disk, say) must not stop the user logging in.
            try {
                await sqliteService.executeNonQuery(
                    `CREATE INDEX IF NOT EXISTS ${dbVars.userPrefix}_${table}_created_idx ON ${dbVars.userPrefix}_${table} (created_at)`
                );
            } catch (err) {
                console.error(`[feed] could not index ${table} by time`, err);
            }
        }
    },

    /**
     * Counts stored feed entries per type.
     *
     * @param {string[]} types Feed types, e.g. ['GPS', 'Online']; unknown ones are ignored
     * @param {string | null} cutoffDate ISO date; only entries created before it are counted. null counts every entry.
     * @returns {Promise<Record<string, number>>}
     */
    async countFeedHistory(types, cutoffDate) {
        /** @type {Record<string, number>} */
        const counts = {};
        for (const feedType of knownTypes(types)) {
            const { from, args } = feedTypeQuery(feedType, cutoffDate);
            let count = 0;
            await sqliteService.execute(
                (dbRow) => {
                    count = Number(dbRow[0]) || 0;
                },
                `SELECT COUNT(*) FROM ${from}`,
                args
            );
            counts[feedType] = count;
        }
        return counts;
    },

    /**
     * Permanently deletes stored feed entries. Only called when the user confirms the Delete Feed Data dialog.
     *
     * @param {string[]} types Feed types to delete; unknown ones are ignored
     * @param {string | null} cutoffDate ISO date; only entries created before it are deleted. null deletes every entry
     *   of those types.
     * @returns {Promise<number>} Number of entries deleted. If a statement fails, rejects with its error carrying
     *   `deletedSoFar`, the entries the earlier statements already deleted.
     */
    async deleteFeedHistory(types, cutoffDate) {
        let deleted = 0;
        for (const feedType of knownTypes(types)) {
            const { from, args } = feedTypeQuery(feedType, cutoffDate);
            try {
                const changes = await sqliteService.executeNonQuery(`DELETE FROM ${from}`, args);
                deleted += Number(changes) || 0;
            } catch (err) {
                // Each type is its own statement, so the ones before this are already gone. Say how many, rather than
                // reporting a clean failure.
                throw Object.assign(err instanceof Error ? err : new Error(String(err)), { deletedSoFar: deleted });
            }
        }
        return deleted;
    }
};

export { feedHistory };
