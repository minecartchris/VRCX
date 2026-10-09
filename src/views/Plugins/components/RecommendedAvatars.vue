<template>
    <div class="flex flex-col gap-10 py-2">
        <!-- Keyword search over everything VRCX knows about -->
        <SettingsGroup :title="t('view.plugins.avatars.search.header')">
            <template #description>
                <p class="m-0">{{ t('view.plugins.avatars.search.description') }}</p>
            </template>

            <Input
                v-model="query"
                class="w-full"
                :placeholder="t('view.plugins.avatars.search.placeholder')"
                :aria-label="t('view.plugins.avatars.search.header')" />

            <details class="text-xs text-muted-foreground">
                <summary class="cursor-pointer select-none">{{ t('view.plugins.avatars.search.syntax') }}</summary>
                <ul class="mt-2 ml-4 list-disc space-y-0.5">
                    <li v-for="example in syntaxExamples" :key="example.query">
                        <code class="rounded bg-muted px-1 py-0.5">{{ example.query }}</code>
                        — {{ example.hint }}
                    </li>
                </ul>
            </details>

            <p class="m-0 text-xs text-muted-foreground">
                {{ t('view.plugins.avatars.search.pool', { count: searchPool.length }) }}
            </p>

            <div v-if="query.trim() && searchResults.length === 0" class="py-4 text-sm text-muted-foreground">
                {{ t('view.plugins.avatars.search.empty') }}
            </div>
            <div v-else-if="query.trim()" class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 pt-2">
                <AvatarSuggestionCard
                    v-for="avatar in searchResults"
                    :key="avatar.id"
                    :avatar="avatar"
                    :caption="avatar.authorName || ''"
                    @click="openAvatar(avatar.id)" />
            </div>
        </SettingsGroup>

        <!-- From the avatar database: explicit opt-in, since it leaves the machine -->
        <SettingsGroup :title="t('view.plugins.avatars.database.header')">
            <template #description>
                <p class="m-0">{{ t('view.plugins.avatars.database.description') }}</p>
            </template>

            <SettingsItem :label="t('view.plugins.avatars.database.action')" :description="providerDescription">
                <Button size="sm" :disabled="!hasProvider || loadingDatabase || loadingHistory" @click="startDatabaseRecommendations">
                    <i v-if="loadingDatabase" class="ri-loader-4-line animate-spin" />
                    {{
                        loadingDatabase
                            ? t('view.plugins.avatars.loading')
                            : hasSearchedDatabase
                              ? t('view.plugins.avatars.database.start_over')
                              : t('view.plugins.avatars.database.fetch')
                    }}
                </Button>
            </SettingsItem>

            <p v-if="databaseError" class="m-0 text-sm text-destructive">{{ databaseError }}</p>

            <div v-if="databaseResults.length > 0" class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 pt-2">
                <AvatarSuggestionCard
                    v-for="avatar in databaseResults"
                    :key="avatar.id"
                    :avatar="avatar"
                    :caption="avatar.authorName || ''"
                    :hide-label="t('view.plugins.avatars.database.hide')"
                    @click="openAvatar(avatar.id)"
                    @hide="hideAvatar(avatar.id)" />
            </div>
            <p
                v-else-if="hasSearchedDatabase && !loadingDatabase && !databaseError"
                class="m-0 py-2 text-sm text-muted-foreground">
                {{ t('view.plugins.avatars.database.empty') }}
            </p>

            <div v-if="databaseResults.length > 0" class="flex flex-wrap items-center gap-2">
                <template v-if="databaseHasMore">
                    <Button size="sm" variant="outline" :disabled="loadingDatabase" @click="showMoreFromDatabase">
                        {{ t('view.plugins.avatars.show_more') }}
                    </Button>
                    <Button size="sm" variant="outline" :disabled="loadingDatabase" @click="newDatabaseRecommendations">
                        <i class="ri-refresh-line" />
                        {{ t('view.plugins.avatars.database.new') }}
                    </Button>
                </template>
                <span class="text-xs text-muted-foreground">
                    {{
                        databaseHasMore
                            ? t('view.plugins.avatars.database.progress', { count: databaseShownTotal })
                            : t('view.plugins.avatars.database.exhausted', { count: databaseShownTotal })
                    }}
                </span>
            </div>
        </SettingsGroup>
    </div>
</template>

<script setup>
    import { computed, onMounted, ref } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Button } from '@/components/ui/button';
    import { Input } from '@/components/ui/input';
    import AvatarSuggestionCard from './AvatarSuggestionCard.vue';
    import SettingsGroup from '@/views/Settings/components/SettingsGroup.vue';
    import SettingsItem from '@/views/Settings/components/SettingsItem.vue';
    import configRepository from '@/services/config';
    import { database } from '@/services/database';
    import { lookupAvatars, showAvatarDialog } from '@/coordinators/avatarCoordinator';
    import { useAvatarProviderStore, useFavoriteStore, useUserStore } from '@/stores';
    import {
        buildMixedPage,
        filterNewAvatars,
        interleaveByAuthor,
        pickKeywords,
        pickTopAuthors,
        pruneSeen,
        sortByRecent
    } from '../recommendations';
    import { searchAvatars } from '../avatarQuery';

    /** Cards per page. */
    const PAGE_SIZE = 24;
    /** How many authors or keywords to look up per network round. */
    const SOURCES_PER_ROUND = 3;
    /** Keyword searches used to find creators you have not worn yet. */
    const KEYWORD_LIMIT = 15;
    /** Days before an avatar you were already shown can be suggested again. */
    const SEEN_DAYS = 30;
    const SEEN_KEY = 'VRCX_avatarRecommendationsSeen';
    const HIDDEN_KEY = 'VRCX_avatarRecommendationsHidden';

    const { t } = useI18n();

    const userStore = useUserStore();
    const favoriteStore = useFavoriteStore();
    const avatarProviderStore = useAvatarProviderStore();

    const history = ref([]);
    const loadingHistory = ref(false);
    const query = ref('');

    const syntaxExamples = computed(() => [
        { query: 'cat ears', hint: t('view.plugins.avatars.search.hint_text') },
        { query: '-nsfw cute', hint: t('view.plugins.avatars.search.hint_exclude') },
        { query: 'author:somecreator', hint: t('view.plugins.avatars.search.hint_author') },
        { query: 'tag:any(kemono, fox)', hint: t('view.plugins.avatars.search.hint_any') },
        { query: 'fuzzy:0.6 protogen', hint: t('view.plugins.avatars.search.hint_fuzzy') },
        { query: 'sort:name(asc)', hint: t('view.plugins.avatars.search.hint_sort') }
    ]);

    /**
     * Everything searchable: your history, your favorites, and anything the
     * avatar database lookup has pulled in this session, shown or not.
     */
    const searchPool = computed(() => {
        const byId = new Map();
        for (const list of [history.value, favoriteAvatarRefs.value, databaseFetched.value]) {
            for (const avatar of list) {
                if (avatar?.id && !byId.has(avatar.id)) {
                    byId.set(avatar.id, avatar);
                }
            }
        }
        return Array.from(byId.values());
    });

    const favoriteAvatarRefs = computed(() =>
        (favoriteStore.favoriteAvatars ?? []).map((favorite) => favorite?.ref ?? favorite).filter((a) => a?.id)
    );

    const searchResults = computed(() => searchAvatars(searchPool.value, query.value).slice(0, 60));

    const hasProvider = computed(() => Boolean(avatarProviderStore.avatarRemoteDatabaseProvider));

    const providerDescription = computed(() =>
        hasProvider.value
            ? avatarProviderStore.avatarRemoteDatabaseProvider
            : t('view.plugins.avatars.database.no_provider')
    );

    function openAvatar(avatarId) {
        showAvatarDialog(avatarId);
    }

    // Avatar database: half from creators you already wear or favorite, half
    // from keyword searches with those creators filtered out, so every page
    // also introduces people you have never worn. Newest uploads first, and
    // nothing you have worn, favorited, hidden or been shown in the last
    // SEEN_DAYS days.

    const loadingDatabase = ref(false);
    const hasSearchedDatabase = ref(false);
    const databaseError = ref('');
    /** Cards on screen. */
    const databaseResults = ref([]);
    /** Every avatar any lookup returned, for the keyword search above. */
    const databaseFetched = ref([]);
    const databaseShownTotal = ref(0);
    const databaseSourcesLeft = ref(false);
    const databaseQueued = ref(0);

    /**
     * One half of the recommendations: what to look up, how far through it
     * we are, and what came back but has not been shown yet.
     *
     * @typedef {object} RecommendationSide
     * @property {{ type: string; value: string }[]} sources
     * @property {number} cursor
     * @property {object[]} pool
     * @property {Set<string>} excludeAuthorIds
     */

    /** @returns {RecommendationSide} */
    function emptySide() {
        return { sources: [], cursor: 0, pool: [], excludeAuthorIds: new Set() };
    }

    let familiar = emptySide();
    let discovery = emptySide();
    /** Ids queued or shown this session, so nothing repeats. */
    let databaseQueuedIds = new Set();
    /** @type {Record<string, number>} Avatar id to when it was shown */
    let seenAt = {};
    /** @type {Set<string>} */
    let hiddenIds = new Set();

    const databaseHasMore = computed(() => databaseQueued.value > 0 || databaseSourcesLeft.value);

    /** @returns {Set<string>} Ids that should never be suggested */
    function excludedAvatarIds() {
        const excluded = new Set(history.value.map((entry) => entry.id));
        for (const favorite of favoriteStore.favoriteAvatars ?? []) {
            const id = favorite?.id ?? favorite?.ref?.id;
            if (id) {
                excluded.add(id);
            }
        }
        for (const id of Object.keys(seenAt)) {
            excluded.add(id);
        }
        for (const id of hiddenIds) {
            excluded.add(id);
        }
        for (const id of databaseQueuedIds) {
            excluded.add(id);
        }
        return excluded;
    }

    /**
     * @param {string} key
     * @param {unknown} fallback
     * @returns {Promise<any>}
     */
    async function readJson(key, fallback) {
        try {
            return JSON.parse(await configRepository.getString(key, '')) ?? fallback;
        } catch {
            return fallback;
        }
    }

    async function loadSeenAndHidden() {
        seenAt = pruneSeen(await readJson(SEEN_KEY, {}), { maxAgeDays: SEEN_DAYS });
        const hidden = await readJson(HIDDEN_KEY, []);
        hiddenIds = new Set(Array.isArray(hidden) ? hidden : []);
    }

    /** @param {object[]} page */
    async function markSeen(page) {
        const now = Date.now();
        for (const avatar of page) {
            seenAt[avatar.id] = now;
        }
        await configRepository.setString(SEEN_KEY, JSON.stringify(seenAt));
    }

    /** @param {string} avatarId */
    async function hideAvatar(avatarId) {
        hiddenIds.add(avatarId);
        databaseResults.value = databaseResults.value.filter((avatar) => avatar.id !== avatarId);
        await configRepository.setString(HIDDEN_KEY, JSON.stringify(Array.from(hiddenIds)));
    }

    /**
     * Looks up a side's sources until its pool holds at least `needed`
     * avatars, or there is nothing left to look up.
     *
     * @param {RecommendationSide} side
     * @param {number} needed
     */
    async function fillSide(side, needed) {
        while (side.pool.length < needed && side.cursor < side.sources.length) {
            const round = side.sources.slice(side.cursor, side.cursor + SOURCES_PER_ROUND);
            side.cursor += round.length;

            const found = [];
            for (const source of round) {
                const avatars = await lookupAvatars(source.type, source.value);
                found.push(...avatars.values());
            }
            databaseFetched.value = [...databaseFetched.value, ...found];

            const fresh = interleaveByAuthor(
                sortByRecent(
                    filterNewAvatars(found, excludedAvatarIds(), {
                        limit: 0,
                        excludeAuthorIds: side.excludeAuthorIds
                    })
                )
            );
            for (const avatar of fresh) {
                databaseQueuedIds.add(avatar.id);
            }
            side.pool = [...side.pool, ...fresh];
        }
    }

    /**
     * Fills both sides for a page: half each, then whichever still has
     * sources makes up for the other running out.
     */
    async function fillPools() {
        const half = Math.ceil(PAGE_SIZE / 2);
        await fillSide(familiar, half);
        await fillSide(discovery, half);
        await fillSide(familiar, PAGE_SIZE - Math.min(discovery.pool.length, half));
        await fillSide(discovery, PAGE_SIZE - Math.min(familiar.pool.length, half));
    }

    function updateDatabaseCounts() {
        databaseQueued.value = familiar.pool.length + discovery.pool.length;
        databaseSourcesLeft.value =
            familiar.cursor < familiar.sources.length || discovery.cursor < discovery.sources.length;
    }

    /**
     * Fetches as needed, then hands the next page to `apply`.
     *
     * @param {(page: object[]) => void} apply
     */
    async function runDatabaseStep(apply) {
        loadingDatabase.value = true;
        databaseError.value = '';
        try {
            await fillPools();
            const result = buildMixedPage(familiar.pool, discovery.pool, { size: PAGE_SIZE });
            familiar.pool = result.familiar;
            discovery.pool = result.discovery;
            updateDatabaseCounts();
            databaseShownTotal.value += result.page.length;
            apply(result.page);
            await markSeen(result.page);
        } catch (err) {
            console.error('Avatar database lookup failed', err);
            databaseError.value = err instanceof Error ? err.message : String(err);
        } finally {
            loadingDatabase.value = false;
        }
    }

    async function startDatabaseRecommendations() {
        hasSearchedDatabase.value = true;
        await loadSeenAndHidden();
        const ownId = userStore.currentUser?.id ?? '';
        const authors = pickTopAuthors(history.value, favoriteStore.favoriteAvatars, {
            limit: 0,
            excludeAuthorId: ownId
        });
        const keywords = pickKeywords(history.value, favoriteAvatarRefs.value, { limit: KEYWORD_LIMIT });

        familiar = emptySide();
        familiar.sources = authors.map((value) => ({ type: 'authorId', value }));
        discovery = emptySide();
        discovery.sources = keywords.map((value) => ({ type: 'search', value }));
        discovery.excludeAuthorIds = new Set([...authors, ownId].filter(Boolean));

        databaseQueuedIds = new Set();
        databaseResults.value = [];
        databaseShownTotal.value = 0;
        await runDatabaseStep((page) => {
            databaseResults.value = page;
        });
    }

    /** Keeps what is on screen and adds the next page below it. */
    function showMoreFromDatabase() {
        return runDatabaseStep((page) => {
            databaseResults.value = [...databaseResults.value, ...page];
        });
    }

    /** Swaps what is on screen for a page you have not seen yet. */
    function newDatabaseRecommendations() {
        return runDatabaseStep((page) => {
            if (page.length > 0) {
                databaseResults.value = page;
            }
        });
    }

    async function loadHistory() {
        loadingHistory.value = true;
        try {
            history.value = await database.getAvatarHistory(userStore.currentUser?.id ?? '', 500);
        } catch (err) {
            console.error('Failed to load avatar history', err);
            history.value = [];
        } finally {
            loadingHistory.value = false;
        }
    }

    onMounted(loadHistory);
</script>
