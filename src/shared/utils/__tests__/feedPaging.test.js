import { describe, expect, test } from 'vitest';

import { feedRowContentKey, feedRowKey, feedRowKeys, oldestCreatedAt, sortFeedRows, takeFeedPage } from '../feedPaging';

const at = (minute) => `2026-09-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
const gps = (id, minute, userId = 'usr_a') => ({ rowId: id, type: 'GPS', created_at: at(minute), userId });
const plugin = (id, minute, message = `m${id}`) => ({
    rowId: id,
    type: 'Plugin',
    created_at: at(minute),
    pluginId: 'p',
    message,
    userId: ''
});
const ids = (rows) => rows.map((row) => row.rowId);

describe('oldestCreatedAt', () => {
    test('returns the smallest timestamp and skips rows without one', () => {
        expect(oldestCreatedAt([gps(1, 30), { type: 'GPS' }, gps(2, 10), gps(3, 20)])).toBe(at(10));
    });

    test('is empty for no rows', () => {
        expect(oldestCreatedAt([])).toBe('');
    });
});

describe('row identity', () => {
    test('uses the table id when there is one', () => {
        expect(feedRowKey(gps(7, 1))).toBe('id:GPS:7');
    });

    test('keeps the same id from different tables apart', () => {
        expect(feedRowKey(gps(1, 1))).not.toBe(feedRowKey({ ...gps(1, 1), type: 'Status' }));
    });

    test('a live row is known by what it says', () => {
        const live = { type: 'GPS', created_at: at(1), userId: 'usr_a' };
        expect(feedRowKey(live)).toBe(feedRowContentKey(gps(7, 1)));
    });

    test('two plugin messages at the same moment stay distinct', () => {
        expect(feedRowContentKey(plugin(1, 1, 'one'))).not.toBe(feedRowContentKey(plugin(2, 1, 'two')));
    });
});

describe('sortFeedRows', () => {
    test('sorts newest first and keeps ties in order', () => {
        const sorted = sortFeedRows([gps(1, 10), gps(2, 30), gps(3, 30), gps(4, 20)]);
        expect(ids(sorted)).toEqual([2, 3, 4, 1]);
    });
});

describe('takeFeedPage', () => {
    test('a short newest page has nothing more', () => {
        const page = takeFeedPage([gps(2, 30), gps(1, 20)], { limit: 3 });
        expect(ids(page.rows)).toEqual([2, 1]);
        expect(page.cursor).toBe(at(20));
        expect(page.hasMore).toBe(false);
    });

    test('a full page continues from its oldest row', () => {
        const page = takeFeedPage([gps(3, 30), gps(2, 20), gps(1, 10)], { limit: 3 });
        expect(page.cursor).toBe(at(10));
        expect(page.hasMore).toBe(true);
    });

    test('skips rows already on screen', () => {
        const known = feedRowKeys([gps(5, 20)]);
        const page = takeFeedPage([gps(5, 20), gps(4, 19)], { limit: 3, cursor: at(20), known });
        expect(ids(page.rows)).toEqual([4]);
    });

    test('recognises a live row coming back from the database with an id', () => {
        const known = feedRowKeys([{ type: 'GPS', created_at: at(20), userId: 'usr_a' }]);
        const page = takeFeedPage([gps(9, 20), gps(8, 19)], { limit: 3, cursor: at(20), known });
        expect(ids(page.rows)).toEqual([8]);
    });

    test('keeps two stored rows that happen to say the same thing', () => {
        const page = takeFeedPage([gps(2, 20), gps(1, 20)], { limit: 3 });
        expect(ids(page.rows)).toEqual([2, 1]);
    });

    test('drops rows newer than the cursor and does not let them move it', () => {
        const page = takeFeedPage([gps(9, 55), gps(1, 20)], { limit: 2, cursor: at(30) });
        expect(ids(page.rows)).toEqual([1]);
        expect(page.cursor).toBe(at(20));
    });

    test('reports a full page that all shares the cursor timestamp as stuck', () => {
        const page = takeFeedPage([gps(3, 20), gps(2, 20)], { limit: 2, cursor: at(20), known: new Map() });
        expect(page.hasMore).toBe(true);
        expect(page.stuck).toBe(true);
        expect(page.cursor).toBe(at(20));
    });

    test('is not stuck once the page reaches past the cursor', () => {
        const page = takeFeedPage([gps(3, 20), gps(2, 19)], { limit: 2, cursor: at(20) });
        expect(page.stuck).toBe(false);
        expect(page.cursor).toBe(at(19));
    });

    test('matches each live row to only one stored row that says the same thing', () => {
        const live = { type: 'GPS', created_at: at(20), userId: 'usr_a' };
        const page = takeFeedPage([gps(9, 20), gps(8, 20)], { limit: 5, cursor: at(20), known: feedRowKeys([live]) });
        expect(ids(page.rows)).toEqual([8]);
    });

    test('keeps the cursor when a page comes back empty', () => {
        const page = takeFeedPage([], { limit: 2, cursor: at(20) });
        expect(page.cursor).toBe(at(20));
        expect(page.hasMore).toBe(false);
    });
});
