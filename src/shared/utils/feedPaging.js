/**
 * Paging for the Feed page's "Load older entries".
 *
 * The feed is read from two sources: the friend-event tables (one UNION query) and the plugin table. Each is paged on
 * its own created_at cursor, asking for its newest rows at or before it. Keeping the cursors separate means a busy
 * source never holds back or skips rows from the other one.
 */

/**
 * @param {object} row
 * @returns {string}
 */
function createdAtOf(row) {
    return String(row?.created_at ?? '');
}

/**
 * Oldest created_at among the rows, ignoring rows that have none.
 *
 * @param {object[]} rows
 * @returns {string} '' when no row has a timestamp
 */
export function oldestCreatedAt(rows) {
    let oldest = '';
    for (const row of rows) {
        const createdAt = createdAtOf(row);
        if (createdAt && (!oldest || createdAt < oldest)) {
            oldest = createdAt;
        }
    }
    return oldest;
}

/**
 * What a row says, ignoring where it is stored. Rows pushed live by addFeedEntry have no table id, so this is how one
 * is recognised when the same entry is read back from the database.
 *
 * @param {object} row
 * @returns {string}
 */
export function feedRowContentKey(row) {
    const extra = row?.type === 'Plugin' ? `${row.pluginId ?? ''}:${row.message ?? ''}` : '';
    return `at:${row?.type}:${createdAtOf(row)}:${row?.userId ?? ''}:${extra}`;
}

/**
 * Identity of a row: its table id when it has one. The type is part of the key because each type has its own table
 * (Online and Offline share one, but never an id).
 *
 * @param {object} row
 * @returns {string}
 */
export function feedRowKey(row) {
    return row?.rowId != null ? `id:${row.type}:${row.rowId}` : feedRowContentKey(row);
}

/**
 * What is on screen, for telling which rows of a page are new.
 *
 * @param {object[]} rows
 * @returns {Map<string, number>} How many shown rows have each identity (see feedRowKey). Stored rows are unique;
 *   several live rows can say the same thing.
 */
export function feedRowKeys(rows) {
    const keys = new Map();
    for (const row of rows) {
        const key = feedRowKey(row);
        keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    return keys;
}

/**
 * @param {object[]} rows
 * @returns {object[]} A newest-first copy; rows with the same timestamp keep their order
 */
export function sortFeedRows(rows) {
    return rows.slice().sort((a, b) => {
        const left = createdAtOf(a);
        const right = createdAtOf(b);
        return left < right ? 1 : left > right ? -1 : 0;
    });
}

/**
 * Turns one page read from a source into the rows to show and that source's next cursor.
 *
 * @param {object[]} rows What the query returned: at most `limit` rows at or before `cursor`, newest first
 * @param {{ limit: number; cursor?: string; known?: Map<string, number> }} options `cursor` is '' for the newest
 *   page; `known` describes the rows already shown, see feedRowKeys
 * @returns {{ rows: object[]; cursor: string; hasMore: boolean; stuck: boolean }} `stuck` means the whole page shared
 *   the cursor's timestamp, so the same query cannot get past it; ask again with a bigger page
 */
export function takeFeedPage(rows, { limit, cursor = '', known = new Map() }) {
    // Hold the page to its cursor even if a query lets a newer row through.
    const inRange = cursor ? rows.filter((row) => createdAtOf(row) <= cursor) : rows;
    const shown = new Map(known);
    const fresh = [];
    for (const row of inRange) {
        const key = feedRowKey(row);
        if (row?.rowId != null && shown.has(key)) {
            continue;
        }
        // Each entry shown live stands for exactly one stored row. Matching it off one at a time keeps a second
        // stored row that happens to say the same thing.
        const contentKey = feedRowContentKey(row);
        const live = shown.get(contentKey) ?? 0;
        if (live > 0) {
            shown.set(contentKey, live - 1);
            continue;
        }
        if (row?.rowId != null) {
            shown.set(key, 1);
        }
        fresh.push(row);
    }
    const full = rows.length >= limit;
    const next = oldestCreatedAt(inRange) || cursor;
    return { rows: fresh, cursor: next, hasMore: full, stuck: full && Boolean(cursor) && next === cursor };
}
