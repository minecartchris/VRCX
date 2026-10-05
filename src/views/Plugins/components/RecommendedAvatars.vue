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

        <!-- Rediscover: local only, no network -->
        <SettingsGroup :title="t('view.plugins.avatars.rediscover.header')">
            <template #description>
                <p class="m-0">{{ t('view.plugins.avatars.rediscover.description') }}</p>
            </template>

            <div v-if="loadingHistory" class="py-6 text-center text-sm text-muted-foreground">
                {{ t('view.plugins.avatars.loading') }}
            </div>
            <div v-else-if="rediscoveries.length === 0" class="py-6 text-center text-sm text-muted-foreground">
                {{ t('view.plugins.avatars.rediscover.empty') }}
            </div>
            <div v-else class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                <AvatarSuggestionCard
                    v-for="avatar in visibleRediscoveries"
                    :key="avatar.id"
                    :avatar="avatar"
                    :caption="
                        t('view.plugins.avatars.rediscover.caption', {
                            age: formatAge(avatar.daysSinceWorn),
                            minutes: Math.round(avatar.minutesWorn)
                        })
                    "
                    @click="openAvatar(avatar.id)" />
            </div>
            <div v-if="rediscoveries.length > PAGE_SIZE" class="flex flex-wrap items-center gap-2">
                <Button v-if="canShowMoreRediscoveries" size="sm" variant="outline" @click="showMoreRediscoveries">
                    {{ t('view.plugins.avatars.show_more') }}
                </Button>
                <Button size="sm" variant="outline" @click="showDifferentRediscoveries">
                    <i class="ri-refresh-line" />
                    {{ t('view.plugins.avatars.rediscover.different') }}
                </Button>
                <span class="text-xs text-muted-foreground">
                    {{
                        t('view.plugins.avatars.showing', {
                            shown: visibleRediscoveries.length,
                            total: rediscoveries.length
                        })
                    }}
                </span>
            </div>
        </SettingsGroup>

        <!-- From the avatar database: explicit opt-in, since it leaves the machine -->
        <SettingsGroup :title="t('view.plugins.avatars.database.header')">
            <template #description>
                <p class="m-0">{{ t('view.plugins.avatars.database.description') }}</p>
            </template>

            <SettingsItem :label="t('view.plugins.avatars.database.action')" :description="providerDescription">
                <Button size="sm" :disabled="!hasProvider || loadingDatabase" @click="startDatabaseRecommendations">
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
                    @click="openAvatar(avatar.id)" />
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
    import { database } from '@/services/database';
    import { lookupAvatars, showAvatarDialog } from '@/coordinators/avatarCoordinator';
    import { useAvatarProviderStore, useFavoriteStore, useUserStore } from '@/stores';
    import {
        filterNewAvatars,
        formatAge,
        interleaveByAuthor,
        pickKeywords,
        pickTopAuthors,
        rankRediscoveries
    } from '../recommendations';
    import { searchAvatars } from '../avatarQuery';

    /** Cards per page, in both recommendation sections. */
    const PAGE_SIZE = 24;
    /** How many authors or keywords to look up per network round. */
    const SOURCES_PER_ROUND = 3;
    /** Keyword searches to fall back on once your known creators run dry. */
    const KEYWORD_LIMIT = 15;

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

    // Rediscover: a window over the full local ranking.

    const rediscoveries = computed(() =>
        rankRediscoveries(history.value, {
            excludeIds: [userStore.currentUser?.currentAvatar].filter(Boolean),
            limit: 0
        })
    );
    const rediscoverOffset = ref(0);
    const rediscoverCount = ref(PAGE_SIZE);

    const visibleRediscoveries = computed(() => {
        const all = rediscoveries.value;
        const count = Math.min(rediscoverCount.value, all.length);
        // Wraps around, so "show different ones" keeps cycling instead of
        // landing on an empty page.
        return Array.from({ length: count }, (_, i) => all[(rediscoverOffset.value + i) % all.length]);
    });

    const canShowMoreRediscoveries = computed(() => rediscoverCount.value < rediscoveries.value.length);

    function showMoreRediscoveries() {
        rediscoverCount.value += PAGE_SIZE;
    }

    function showDifferentRediscoveries() {
        const total = rediscoveries.value.length;
        if (total === 0) {
            return;
        }
        rediscoverOffset.value = (rediscoverOffset.value + visibleRediscoveries.value.length) % total;
        rediscoverCount.value = PAGE_SIZE;
    }

    // Avatar database: creators you already know first, then keyword searches
    // built from what you wear, so it keeps finding new creators.

    const loadingDatabase = ref(false);
    const hasSearchedDatabase = ref(false);
    const databaseError = ref('');
    /** Cards on screen. */
    const databaseResults = ref([]);
    /** Fetched and filtered, waiting to be shown. */
    const databasePool = ref([]);
    /** Every avatar any lookup returned, for the keyword search above. */
    const databaseFetched = ref([]);
    const databaseShownTotal = ref(0);
    const databaseSourcesLeft = ref(false);

    /** Authors, then keywords, still to look up. */
    let databaseSources = [];
    let databaseCursor = 0;
    /** Ids already shown or queued, so new recommendations never repeat one. */
    let databaseSeen = new Set();

    const databaseHasMore = computed(() => databasePool.value.length > 0 || databaseSourcesLeft.value);

    /** @returns {Set<string>} Ids already in your history or favorites */
    function knownAvatarIds() {
        const known = new Set(history.value.map((entry) => entry.id));
        for (const favorite of favoriteStore.favoriteAvatars ?? []) {
            const id = favorite?.id ?? favorite?.ref?.id;
            if (id) {
                known.add(id);
            }
        }
        return known;
    }

    /**
     * Looks up sources until the queue holds at least `needed` avatars, or
     * there is nothing left to look up.
     *
     * @param {number} needed
     */
    async function fillDatabasePool(needed) {
        const known = knownAvatarIds();
        while (databasePool.value.length < needed && databaseCursor < databaseSources.length) {
            const round = databaseSources.slice(databaseCursor, databaseCursor + SOURCES_PER_ROUND);
            databaseCursor += round.length;

            const found = [];
            for (const source of round) {
                const avatars = await lookupAvatars(source.type, source.value);
                found.push(...avatars.values());
            }
            databaseFetched.value = [...databaseFetched.value, ...found];

            const fresh = interleaveByAuthor(
                filterNewAvatars(found, new Set([...known, ...databaseSeen]), { limit: 0 })
            );
            for (const avatar of fresh) {
                databaseSeen.add(avatar.id);
            }
            databasePool.value = [...databasePool.value, ...fresh];
        }
        databaseSourcesLeft.value = databaseCursor < databaseSources.length;
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
            await fillDatabasePool(PAGE_SIZE);
            const page = databasePool.value.slice(0, PAGE_SIZE);
            databasePool.value = databasePool.value.slice(PAGE_SIZE);
            databaseShownTotal.value += page.length;
            apply(page);
        } catch (err) {
            console.error('Avatar database lookup failed', err);
            databaseError.value = err instanceof Error ? err.message : String(err);
        } finally {
            loadingDatabase.value = false;
        }
    }

    async function startDatabaseRecommendations() {
        hasSearchedDatabase.value = true;
        const authors = pickTopAuthors(history.value, favoriteStore.favoriteAvatars, {
            limit: 0,
            excludeAuthorId: userStore.currentUser?.id ?? ''
        });
        const keywords = pickKeywords(history.value, favoriteAvatarRefs.value, { limit: KEYWORD_LIMIT });
        databaseSources = [
            ...authors.map((value) => ({ type: 'authorId', value })),
            ...keywords.map((value) => ({ type: 'search', value }))
        ];
        databaseCursor = 0;
        databaseSeen = new Set();
        databasePool.value = [];
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
