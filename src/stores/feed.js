import { ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';

import { database } from '../services/database';
import { feedRowKeys, sortFeedRows, takeFeedPage } from '../shared/utils/feedPaging';
import { useFriendStore } from './friend';
import { useVrcxStore } from './vrcx';
import { watchState } from '../services/watchState';

import configRepository from '../services/config';

export const useFeedStore = defineStore('Feed', () => {
    const friendStore = useFriendStore();
    const vrcxStore = useVrcxStore();

    const feedTableData = shallowRef([]);
    const feedTable = ref({
        search: '',
        dateFrom: '',
        dateTo: '',
        vip: false,
        loading: false,
        filter: [],
        pageSize: 20,
        pageSizeLinked: true
    });
    // How many rows the Feed page keeps. It starts at the table size setting and grows as older entries are loaded,
    // so new live entries do not push loaded history straight back out.
    const feedTableLimit = ref(vrcxStore.maxTableSize);
    // Whether the database may hold entries that are not shown yet.
    const feedHasOlder = ref(false);
    const feedLoadingOlder = ref(false);
    // Where "Load older entries" continues from, per source. Only set from what was read from the database, so a
    // live entry with an odd timestamp cannot move it.
    let paging = newPaging();
    // Bumped by every lookup so a page that arrives after the filters changed is thrown away.
    let lookupGeneration = 0;

    watch(
        () => watchState.isLoggedIn,
        (isLoggedIn) => {
            feedTableData.value = [];
            if (isLoggedIn) {
                initFeedTable();
            }
        },
        { flush: 'sync' }
    );

    watch(
        () => watchState.isFavoritesLoaded,
        (isFavoritesLoaded) => {
            if (isFavoritesLoaded && feedTable.value.vip) {
                feedTableLookup(); // re-apply VIP filter after friends are loaded
            }
        }
    );

    async function init() {
        feedTable.value.filter = JSON.parse(await configRepository.getString('VRCX_feedTableFilters', '[]'));
        feedTable.value.vip = await configRepository.getBool('VRCX_feedTableVIPFilter', false);
    }

    init();

    function feedSearch(row) {
        const value = feedTable.value.search.trim().toUpperCase();
        if (!value) {
            return true;
        }
        if (
            (value.startsWith('wrld_') || value.startsWith('grp_')) &&
            String(row.location).toUpperCase().includes(value)
        ) {
            return true;
        }
        switch (row.type) {
            case 'GPS':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.worldName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Online':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.worldName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Offline':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.worldName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Status':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.status).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.statusDescription).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Avatar':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.avatarName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Bio':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.bio).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.previousBio).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Plugin':
                if (String(row.message).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.detail).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.pluginName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
        }
        return true;
    }

    /**
     * `limit` is 0 for the usual page size, or bigger while rows sharing one timestamp fill whole pages.
     *
     * @returns {Record<'friend' | 'plugin', { cursor: string; more: boolean; limit: number }>}
     */
    function newPaging() {
        return {
            friend: { cursor: '', more: false, limit: 0 },
            plugin: { cursor: '', more: false, limit: 0 }
        };
    }

    /**
     * @param {object} row
     * @returns {'friend' | 'plugin'} Which query the row comes from
     */
    function sourceOf(row) {
        return row?.type === 'Plugin' ? 'plugin' : 'friend';
    }

    /**
     * The current filters, as the page queries need them.
     */
    function feedQuery() {
        let vipList = [];
        if (feedTable.value.vip) {
            vipList = Array.from(friendStore.localFavoriteFriends.values());
        }
        const search = feedTable.value.search.trim();
        const { dateFrom, dateTo } = feedTable.value;
        const searching = Boolean(search || dateFrom || dateTo);
        return {
            vipList,
            search,
            dateFrom,
            dateTo,
            searching,
            // An instance id search returns every match at once and ignores dates, so it has no cursor to page with.
            instanceSearch: search.startsWith('wrld_') || search.startsWith('grp_'),
            limit: searching ? vrcxStore.searchLimit : vrcxStore.maxTableSize
        };
    }

    /**
     * @param {string} cursor
     * @param {string} dateTo
     * @returns {string} The upper created_at bound for a page
     */
    function upperBound(cursor, dateTo) {
        return cursor && (!dateTo || cursor < dateTo) ? cursor : dateTo;
    }

    /**
     * Friend events: the newest page, or with a cursor, the newest rows at or before it.
     *
     * @param {ReturnType<typeof feedQuery>} query
     * @param {string} cursor
     * @param {number} [limit]
     * @returns {Promise<object[]>}
     */
    function readFriendRows(query, cursor, limit = query.limit) {
        const { search, vipList, dateFrom, dateTo } = query;
        // Every page, the first one included, is picked newest created_at first. lookupFeedDatabase picks each
        // table's newest ids instead, and once a wrong clock has made ids and times disagree, a cursor taken from that
        // page would step over rows it never read.
        return database.searchFeedDatabase(
            search,
            feedTable.value.filter,
            vipList,
            limit,
            dateFrom,
            upperBound(cursor, dateTo)
        );
    }

    /**
     * Plugin entries are stored separately from the friend-event feed tables,
     * so they are fetched on their own and merged into the same table.
     *
     * @param {ReturnType<typeof feedQuery>} query
     * @param {string} cursor
     * @param {number} [limit]
     * @returns {Promise<object[]>}
     */
    async function readPluginRows(query, cursor, limit = query.limit) {
        const filter = feedTable.value.filter;
        if (filter.length > 0 && !filter.includes('Plugin')) {
            return [];
        }
        try {
            return await database.lookupPluginFeedDatabase(
                query.search,
                query.dateFrom,
                upperBound(cursor, query.dateTo),
                limit,
                query.vipList
            );
        } catch (err) {
            console.error('[feed] plugin feed lookup failed', err);
            return [];
        }
    }

    function updateHasOlder() {
        feedHasOlder.value = paging.friend.more || paging.plugin.more;
    }

    async function feedTableLookup() {
        await configRepository.setString('VRCX_feedTableFilters', JSON.stringify(feedTable.value.filter));
        await configRepository.setBool('VRCX_feedTableVIPFilter', feedTable.value.vip);
        const generation = ++lookupGeneration;
        feedTable.value.loading = true;
        try {
            const query = feedQuery();
            const [friendRows, pluginRows] = await Promise.all([readFriendRows(query, ''), readPluginRows(query, '')]);
            if (generation !== lookupGeneration) {
                return;
            }
            const friend = takeFeedPage(friendRows, { limit: query.limit });
            const plugin = takeFeedPage(pluginRows, { limit: query.limit });
            paging = {
                friend: { cursor: friend.cursor, more: friend.hasMore && !query.instanceSearch, limit: 0 },
                plugin: { cursor: plugin.cursor, more: plugin.hasMore, limit: 0 }
            };
            feedTableData.value = plugin.rows.length ? sortFeedRows([...friend.rows, ...plugin.rows]) : friend.rows;
            feedTableLimit.value = Math.max(vrcxStore.maxTableSize, feedTableData.value.length);
            updateHasOlder();
        } finally {
            if (generation === lookupGeneration) {
                feedTable.value.loading = false;
            }
        }
    }

    /**
     * Adds the next page of older entries to the Feed page. Nothing is ever deleted to make room: entries only leave
     * the database through deleteFeedHistory.
     *
     * @returns {Promise<void>}
     */
    async function loadOlderFeed() {
        if (feedLoadingOlder.value || feedTable.value.loading || !feedHasOlder.value) {
            return;
        }
        const generation = lookupGeneration;
        const query = feedQuery();
        feedLoadingOlder.value = true;
        try {
            // A page can come back holding only rows already on screen; keep going a few times so one click shows
            // something whenever there is something left.
            for (let attempt = 0; attempt < 5 && feedHasOlder.value; attempt++) {
                const reading = ['friend', 'plugin'].filter(
                    (source) => paging[source].more && !(source === 'friend' && query.instanceSearch)
                );
                const cursors = reading.map((source) => paging[source].cursor);
                const limits = reading.map((source) => paging[source].limit || query.limit);
                const results = await Promise.all(
                    reading.map((source, i) =>
                        source === 'friend'
                            ? readFriendRows(query, cursors[i], limits[i])
                            : readPluginRows(query, cursors[i], limits[i])
                    )
                );
                if (generation !== lookupGeneration) {
                    return;
                }
                if (query.instanceSearch) {
                    paging.friend.more = false;
                }
                // Compared with the table as it is now, since live entries may have arrived while the page loaded.
                const known = feedRowKeys(feedTableData.value);
                const fresh = [];
                reading.forEach((source, i) => {
                    const page = takeFeedPage(results[i], { limit: limits[i], cursor: cursors[i], known });
                    paging[source] = {
                        cursor: page.cursor,
                        more: page.hasMore,
                        // Rows sharing one timestamp filled the whole page; read more at once to get past them.
                        limit: page.stuck ? limits[i] * 2 : 0
                    };
                    fresh.push(...page.rows);
                });
                updateHasOlder();
                if (fresh.length) {
                    feedTableData.value = sortFeedRows([...feedTableData.value, ...fresh]);
                    feedTableLimit.value = Math.max(feedTableLimit.value, feedTableData.value.length);
                    return;
                }
            }
        } finally {
            feedLoadingOlder.value = false;
        }
    }

    /**
     * @param {string[]} types Feed types, e.g. ['GPS', 'Plugin']
     * @param {string | null} cutoffDate ISO date; entries created before it. null means every entry.
     * @returns {Promise<Record<string, number>>} Stored entries per type
     */
    function countFeedHistory(types, cutoffDate) {
        return database.countFeedHistory(types, cutoffDate);
    }

    /**
     * Permanently deletes feed entries the user picked, reclaims the disk space and reloads the Feed page.
     *
     * @param {string[]} types Feed types, e.g. ['GPS', 'Plugin']
     * @param {string | null} cutoffDate ISO date; entries created before it. null deletes every entry of those types.
     * @returns {Promise<number>} Entries deleted. A failure part way through rejects with an error whose
     *   `deletedSoFar` says how many entries had already gone.
     */
    async function deleteFeedHistory(types, cutoffDate) {
        let deleted;
        try {
            deleted = await database.deleteFeedHistory(types, cutoffDate);
        } catch (err) {
            // Some types may already be gone, so the page is reloaded either way.
            await reloadAfterDelete();
            throw err;
        }
        // The entries are gone at this point; failing to tidy up afterwards must not be reported as a failed delete.
        try {
            await database.vacuum();
        } catch (err) {
            console.error('[feed] could not reclaim space after deleting feed history', err);
        }
        await reloadAfterDelete();
        return deleted;
    }

    async function reloadAfterDelete() {
        try {
            await feedTableLookup();
        } catch (err) {
            console.error('[feed] could not reload the feed after deleting feed history', err);
        }
    }

    /**
     * Appends a feed entry to the local table if it passes filters.
     * Does NOT trigger notifications or shared feed — that is the caller's responsibility.
     *
     * @param {object} feed The feed entry to add.
     */
    function addFeedEntry(feed) {
        if (feedTable.value.filter.length > 0 && !feedTable.value.filter.includes(feed.type)) {
            return;
        }
        if (feedTable.value.vip && !friendStore.localFavoriteFriends.has(feed.userId)) {
            return;
        }
        if (!feedSearch(feed)) {
            return;
        }
        if (feedTable.value.dateFrom && feed.created_at < feedTable.value.dateFrom) {
            return;
        }
        if (feedTable.value.dateTo && feed.created_at > feedTable.value.dateTo) {
            return;
        }
        feedTableData.value = [feed, ...feedTableData.value];
        sweepFeed();
    }

    function sweepFeed() {
        // A page is being read from the current cursors; trimming now would leave a gap behind it.
        if (feedLoadingOlder.value) {
            return;
        }
        const j = feedTableData.value.length;
        if (j > feedTableLimit.value + 50) {
            const dropped = feedTableData.value.slice(-50);
            feedTableData.value = feedTableData.value.slice(0, -50);
            // The dropped rows are still in the database. Move each cursor back up over them so "Load older entries"
            // reads them again; rows still on screen are skipped when they come back.
            for (const row of dropped) {
                const state = paging[sourceOf(row)];
                const createdAt = String(row.created_at ?? '');
                if (createdAt > state.cursor) {
                    state.cursor = createdAt;
                }
                state.more = true;
            }
            updateHasOlder();
        }
    }

    async function initFeedTable() {
        feedTable.value.loading = true;
        await feedTableLookup();
        feedTable.value.loading = false;
    }

    return {
        feedTable,
        feedTableData,
        feedTableLimit,
        feedHasOlder,
        feedLoadingOlder,
        initFeedTable,
        feedTableLookup,
        loadOlderFeed,
        countFeedHistory,
        deleteFeedHistory,
        addFeedEntry
    };
});
