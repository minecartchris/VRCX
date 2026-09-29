import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';

const mocks = vi.hoisted(() => ({
    database: {
        lookupFeedDatabase: vi.fn(),
        searchFeedDatabase: vi.fn(),
        lookupPluginFeedDatabase: vi.fn(),
        countFeedHistory: vi.fn(),
        deleteFeedHistory: vi.fn(),
        vacuum: vi.fn()
    },
    favorites: new Set(),
    vrcx: { maxTableSize: 3, searchLimit: 10 },
    // Stored rows the fake database answers from.
    stored: { friend: [], plugin: [] },
    // While set, every query waits for it, so a test can act while a page is loading.
    gate: null
}));

vi.mock('../../services/database', () => ({ database: mocks.database }));
vi.mock('../friend', () => ({
    useFriendStore: () => ({ localFavoriteFriends: mocks.favorites })
}));
vi.mock('../vrcx', () => ({ useVrcxStore: () => mocks.vrcx }));
vi.mock('../../services/watchState', () => ({
    watchState: reactive({ isLoggedIn: false, isFavoritesLoaded: false })
}));
vi.mock('../../services/config', () => ({
    default: {
        getString: async (_key, fallback) => fallback,
        getBool: async (_key, fallback) => fallback,
        setString: vi.fn(async () => {}),
        setBool: vi.fn(async () => {})
    }
}));

import { feedRowContentKey } from '../../shared/utils/feedPaging';
import { useFeedStore } from '../feed';

const at = (minute) =>
    `2026-09-01T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;
let nextId = 1;
const gps = (minute, userId = 'usr_a') => ({ rowId: nextId++, type: 'GPS', created_at: at(minute), userId });
const plugin = (minute, userId = '') => ({
    rowId: nextId++,
    type: 'Plugin',
    created_at: at(minute),
    pluginId: 'p',
    message: `m${nextId}`,
    userId
});
const keyOf = (row) => `${row.type}:${row.rowId}`;

/**
 * Newest first, like the real queries (created_at DESC, id DESC).
 *
 * @param {object[]} rows
 */
function newestFirst(rows) {
    return [...rows].sort((a, b) =>
        a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.rowId - a.rowId
    );
}

/**
 * @param {object} row
 * @param {{ dateFrom?: string; dateTo?: string; vipList?: string[] }} options
 */
function matches(row, { dateFrom = '', dateTo = '', vipList = [] }) {
    if (dateFrom && row.created_at < dateFrom) return false;
    if (dateTo && row.created_at > dateTo) return false;
    if (vipList.length && !vipList.includes(row.userId)) return false;
    return true;
}

async function waitForGate() {
    if (mocks.gate) {
        await mocks.gate;
    }
}

function useFakeDatabase() {
    // Like the real query: each table's newest ids, then ordered by time. Paging must not rely on it.
    mocks.database.lookupFeedDatabase.mockImplementation(async (filters, vipList, limit) => {
        await waitForGate();
        const byId = mocks.stored.friend
            .filter((row) => matches(row, { vipList }))
            .sort((a, b) => b.rowId - a.rowId)
            .slice(0, limit);
        return newestFirst(byId);
    });
    mocks.database.searchFeedDatabase.mockImplementation(async (search, filters, vipList, limit, dateFrom, dateTo) => {
        await waitForGate();
        return newestFirst(mocks.stored.friend.filter((row) => matches(row, { dateFrom, dateTo, vipList }))).slice(
            0,
            limit
        );
    });
    mocks.database.lookupPluginFeedDatabase.mockImplementation(async (search, dateFrom, dateTo, limit, vipList) => {
        await waitForGate();
        return newestFirst(mocks.stored.plugin.filter((row) => matches(row, { dateFrom, dateTo, vipList }))).slice(
            0,
            limit
        );
    });
}

/**
 * @param {ReturnType<typeof useFeedStore>} store
 */
async function pageToEnd(store) {
    for (let i = 0; i < 5000 && store.feedHasOlder; i++) {
        await store.loadOlderFeed();
    }
    expect(store.feedHasOlder).toBe(false);
    return store.feedTableData;
}

/**
 * Every expected stored row is on screen exactly once, newest first.
 *
 * @param {object[]} shown
 * @param {object[]} expected
 */
function expectEachOnce(shown, expected) {
    // A live row stays on screen as the copy that was pushed without an id. Match each one to a different stored row
    // that says the same thing and is not shown by id.
    const keys = shown.filter((row) => row.rowId != null).map(keyOf);
    const used = new Set(keys);
    for (const row of shown.filter((shownRow) => shownRow.rowId == null)) {
        const match = expected.find(
            (candidate) => !used.has(keyOf(candidate)) && feedRowContentKey(candidate) === feedRowContentKey(row)
        );
        const key = match ? keyOf(match) : `unmatched:${feedRowContentKey(row)}`;
        used.add(key);
        keys.push(key);
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(expected.map(keyOf).sort());
    // Live entries go on top as they arrive (as upstream does), so only rows read from the database are in order.
    const times = shown.filter((row) => row.rowId != null).map((row) => row.created_at);
    expect(times).toEqual([...times].sort().reverse());
}

/**
 * @returns {{ promise: Promise<any>; resolve: (value?: any) => void }}
 */
function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('feed store history', () => {
    let store;

    beforeEach(() => {
        setActivePinia(createPinia());
        Object.values(mocks.database).forEach((fn) => fn.mockReset());
        mocks.favorites.clear();
        mocks.vrcx.maxTableSize = 3;
        mocks.vrcx.searchLimit = 10;
        mocks.stored.friend = [];
        mocks.stored.plugin = [];
        mocks.gate = null;
        nextId = 1;
        useFakeDatabase();
        store = useFeedStore();
    });

    describe('first load', () => {
        test('loads the newest page and offers older entries', async () => {
            mocks.stored.friend = [gps(50), gps(40), gps(30), gps(20)];

            await store.feedTableLookup();

            expect(mocks.database.searchFeedDatabase).toHaveBeenCalledWith('', [], [], 3, '', '');
            expect(store.feedTableData.map((row) => row.created_at)).toEqual([at(50), at(40), at(30)]);
            expect(store.feedHasOlder).toBe(true);
            expect(store.feedTableLimit).toBe(3);
        });

        test('knows when everything is already loaded', async () => {
            mocks.stored.friend = [gps(30)];

            await store.feedTableLookup();

            expect(store.feedHasOlder).toBe(false);
        });

        test('keeps every fetched friend row even when plugin entries fill their page', async () => {
            // What the Dashboard feed widget shows comes straight from here, and it has no "load older".
            mocks.stored.friend = [gps(20), gps(10)];
            mocks.stored.plugin = [plugin(50), plugin(48), plugin(46), plugin(44)];

            await store.feedTableLookup();

            expect(store.feedTableData.filter((row) => row.type === 'GPS')).toHaveLength(2);
            expect(store.feedHasOlder).toBe(true);
        });

        test('uses the search limit for friend and plugin rows alike when searching', async () => {
            store.feedTable.search = 'bob';

            await store.feedTableLookup();

            expect(mocks.database.searchFeedDatabase).toHaveBeenCalledWith('bob', [], [], 10, '', '');
            expect(mocks.database.lookupPluginFeedDatabase).toHaveBeenCalledWith('bob', '', '', 10, []);
        });

        test('keeps the newest lookup when an older one finishes last', async () => {
            const slow = deferred();
            mocks.database.searchFeedDatabase.mockReturnValueOnce(slow.promise);
            mocks.stored.friend = [gps(59)];

            const first = store.feedTableLookup();
            await store.feedTableLookup();
            slow.resolve([gps(1)]);
            await first;

            expect(store.feedTableData.map((row) => row.created_at)).toEqual([at(59)]);
            expect(store.feedTable.loading).toBe(false);
        });
    });

    describe('paging to the end', () => {
        test('shows every stored row exactly once', async () => {
            mocks.stored.friend = [7, 9, 13, 14, 21, 22, 23, 35, 36, 40, 41, 58].map((minute) => gps(minute));
            mocks.stored.plugin = [1, 2, 3, 4, 5, 6, 30, 31, 55, 56, 57].map((minute) => plugin(minute));

            await store.feedTableLookup();
            const shown = await pageToEnd(store);

            expectEachOnce(shown, [...mocks.stored.friend, ...mocks.stored.plugin]);
        });

        test('reaches every row after the clock was wrong for a while', async () => {
            // Ids 11 and 12 were written while the clock said 2020, so id order and time order disagree.
            mocks.vrcx.maxTableSize = 5;
            const early = Array.from({ length: 10 }, (_, i) => gps(i + 1));
            const skewed = [gps(0), gps(0)].map((row, i) => ({ ...row, created_at: `2020-01-01T00:00:0${i}.000Z` }));
            mocks.stored.friend = [...early, ...skewed, gps(30), gps(31)];

            await store.feedTableLookup();
            const shown = await pageToEnd(store);

            expectEachOnce(shown, mocks.stored.friend);
        });

        test('handles rows that share a timestamp across a page boundary', async () => {
            mocks.stored.friend = [gps(30), gps(20), gps(20), gps(20), gps(10)];

            await store.feedTableLookup();
            const shown = await pageToEnd(store);

            expectEachOnce(shown, mocks.stored.friend);
        });

        test('favourites: plugin entries about other people cannot hide the favourites', async () => {
            store.feedTable.vip = true;
            mocks.favorites.add('usr_fav');
            const favourites = [gps(57, 'usr_fav'), gps(20, 'usr_fav'), gps(5, 'usr_fav'), plugin(3, 'usr_fav')];
            const others = Array.from({ length: 20 }, (_, i) => plugin(40 + i));
            mocks.stored.friend = [favourites[0], favourites[1], favourites[2], gps(58, 'usr_other')];
            mocks.stored.plugin = [...others, favourites[3]];

            await store.feedTableLookup();
            expect(store.feedTableData.length).toBeGreaterThan(0);
            const shown = await pageToEnd(store);

            expectEachOnce(shown, favourites);
        });

        test('a backdated live plugin entry does not make paging skip history', async () => {
            mocks.stored.friend = [gps(59), gps(58), gps(57), gps(30), gps(20), gps(5)];
            await store.feedTableLookup();

            // A plugin logs something with an old timestamp; it is stored and shown live.
            const backdated = plugin(1);
            mocks.stored.plugin.push(backdated);
            store.addFeedEntry({ ...backdated, rowId: undefined });
            const shown = await pageToEnd(store);

            expectEachOnce(shown, mocks.stored.friend.concat(backdated));
        });

        test('rows trimmed by live entries come back', async () => {
            mocks.stored.friend = Array.from({ length: 10 }, (_, i) => gps(i));
            await store.feedTableLookup();

            for (let i = 0; i < 60; i++) {
                const row = gps(100 + i);
                mocks.stored.friend.push(row);
                store.addFeedEntry({ ...row, rowId: undefined });
            }
            expect(store.feedTableData.length).toBeLessThanOrEqual(3 + 50);
            expect(store.feedHasOlder).toBe(true);
            const shown = await pageToEnd(store);

            expectEachOnce(shown, mocks.stored.friend);
        });

        test('live entries arriving while a page loads do not leave a gap', async () => {
            mocks.stored.friend = Array.from({ length: 10 }, (_, i) => gps(i));
            await store.feedTableLookup();
            for (let i = 0; i < 50; i++) {
                const row = gps(100 + i);
                mocks.stored.friend.push(row);
                store.addFeedEntry({ ...row, rowId: undefined });
            }

            const gate = deferred();
            mocks.gate = gate.promise;
            const loading = store.loadOlderFeed();
            for (let i = 0; i < 5; i++) {
                const row = gps(200 + i);
                mocks.stored.friend.push(row);
                store.addFeedEntry({ ...row, rowId: undefined });
            }
            mocks.gate = null;
            gate.resolve();
            await loading;
            const shown = await pageToEnd(store);

            expectEachOnce(shown, mocks.stored.friend);
        });

        test('keeps the date range while paging a search', async () => {
            store.feedTable.dateFrom = at(10);
            store.feedTable.dateTo = at(40);
            mocks.vrcx.searchLimit = 3;
            mocks.stored.friend = [5, 10, 12, 15, 20, 25, 30, 35, 40, 45].map((minute) => gps(minute));
            mocks.stored.plugin = [11, 39, 41].map((minute) => plugin(minute));

            await store.feedTableLookup();
            const shown = await pageToEnd(store);

            expectEachOnce(
                shown,
                [...mocks.stored.friend, ...mocks.stored.plugin].filter(
                    (row) => row.created_at >= at(10) && row.created_at <= at(40)
                )
            );
        });

        test('never pages friend rows for an instance id search', async () => {
            store.feedTable.search = 'wrld_123';
            mocks.vrcx.searchLimit = 2;
            mocks.stored.friend = [gps(30), gps(20), gps(10)];

            await store.feedTableLookup();
            mocks.database.searchFeedDatabase.mockClear();
            await pageToEnd(store);

            expect(mocks.database.searchFeedDatabase).not.toHaveBeenCalled();
        });
    });

    describe('randomized paging', () => {
        /**
         * Small seeded generator so a failure can be replayed.
         *
         * @param {number} seed
         */
        function random(seed) {
            let state = seed;
            return () => {
                state = (state + 0x6d2b79f5) | 0;
                let t = Math.imul(state ^ (state >>> 15), 1 | state);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        test.each(Array.from({ length: 60 }, (_, i) => i + 1))('seed %i shows every stored row once', async (seed) => {
            const next = random(seed);
            const pick = (n) => Math.floor(next() * n);
            mocks.vrcx.maxTableSize = 2 + pick(5);
            const users = ['usr_a', 'usr_b', 'usr_fav'];
            const vip = next() < 0.3;
            if (vip) {
                store.feedTable.vip = true;
                mocks.favorites.add('usr_fav');
            }
            // Coarse minutes so plenty of rows share a timestamp.
            mocks.stored.friend = Array.from({ length: pick(40) }, () => gps(pick(120), users[pick(3)]));
            mocks.stored.plugin = Array.from({ length: pick(40) }, () =>
                plugin(pick(120), next() < 0.3 ? 'usr_fav' : '')
            );

            let clock = 200;
            const addLive = () => {
                const minute = next() < 0.15 ? pick(120) : clock++;
                const row = next() < 0.5 ? gps(minute, users[pick(3)]) : plugin(minute, next() < 0.3 ? 'usr_fav' : '');
                mocks.stored[row.type === 'Plugin' ? 'plugin' : 'friend'].push(row);
                store.addFeedEntry({ ...row, rowId: undefined });
            };

            await store.feedTableLookup();
            for (let step = 0; step < 25; step++) {
                const action = next();
                if (action < 0.4) {
                    await store.loadOlderFeed();
                } else if (action < 0.8) {
                    for (let i = pick(60); i >= 0; i--) {
                        addLive();
                    }
                } else {
                    const gate = deferred();
                    mocks.gate = gate.promise;
                    const loading = store.loadOlderFeed();
                    for (let i = pick(4); i >= 0; i--) {
                        addLive();
                    }
                    mocks.gate = null;
                    gate.resolve();
                    await loading;
                }
            }
            const shown = await pageToEnd(store);

            const expected = [...mocks.stored.friend, ...mocks.stored.plugin].filter(
                (row) => !vip || row.userId === 'usr_fav'
            );
            expectEachOnce(shown, expected);
        });
    });

    describe('loadOlderFeed', () => {
        test('throws a page away when the filters changed while it loaded', async () => {
            mocks.stored.friend = [gps(50), gps(40), gps(30), gps(20)];
            await store.feedTableLookup();

            const gate = deferred();
            mocks.gate = gate.promise;
            const loading = store.loadOlderFeed();
            mocks.gate = null;
            mocks.stored.friend = [gps(58)];
            await store.feedTableLookup();
            gate.resolve();
            await loading;

            expect(store.feedTableData.map((row) => row.created_at)).toEqual([at(58)]);
            expect(store.feedLoadingOlder).toBe(false);
        });

        test('grows the limit so loaded history is not pushed straight back out', async () => {
            mocks.stored.friend = [gps(50), gps(40), gps(30), gps(20), gps(10)];
            await store.feedTableLookup();
            await store.loadOlderFeed();
            expect(store.feedTableLimit).toBe(5);

            for (let i = 0; i < 50; i++) {
                store.addFeedEntry({ type: 'GPS', created_at: at(100 + i), userId: `usr_${i}` });
            }

            expect(store.feedTableData).toHaveLength(55);
            expect(store.feedTableData.slice(-2).map((row) => row.created_at)).toEqual([at(20), at(10)]);
        });
    });

    describe('deleteFeedHistory', () => {
        test('deletes, reclaims space and reloads the page', async () => {
            mocks.database.deleteFeedHistory.mockResolvedValue(42);

            const deleted = await store.deleteFeedHistory(['GPS'], at(0));

            expect(deleted).toBe(42);
            expect(mocks.database.deleteFeedHistory).toHaveBeenCalledWith(['GPS'], at(0));
            expect(mocks.database.vacuum).toHaveBeenCalledTimes(1);
            expect(mocks.database.searchFeedDatabase).toHaveBeenCalledTimes(1);
        });

        test('still reports the deleted entries when reclaiming space fails', async () => {
            mocks.database.deleteFeedHistory.mockResolvedValue(9);
            mocks.database.vacuum.mockRejectedValue(new Error('cannot VACUUM from within a transaction'));

            await expect(store.deleteFeedHistory(['GPS'], null)).resolves.toBe(9);
            expect(mocks.database.searchFeedDatabase).toHaveBeenCalledTimes(1);
        });

        test('reloads the page but does not reclaim space when the delete fails part way', async () => {
            const failure = Object.assign(new Error('database or disk is full'), { deletedSoFar: 12 });
            mocks.database.deleteFeedHistory.mockRejectedValue(failure);

            await expect(store.deleteFeedHistory(['GPS', 'Bio'], null)).rejects.toBe(failure);
            expect(mocks.database.vacuum).not.toHaveBeenCalled();
            expect(mocks.database.searchFeedDatabase).toHaveBeenCalledTimes(1);
        });

        test('counts through the database', async () => {
            mocks.database.countFeedHistory.mockResolvedValue({ GPS: 1 });

            await expect(store.countFeedHistory(['GPS'], null)).resolves.toEqual({ GPS: 1 });
        });
    });
});
