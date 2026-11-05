<template>
    <div class="flex flex-col gap-10 py-2">
        <!-- avtr.zip connection. Device code: no secret to ship, no redirect
             listener, and the same flow in the Electron and CefSharp builds. -->
        <SettingsGroup :title="t('view.plugins.avatars.avtr.header')">
            <template #description>
                <p class="m-0">{{ t('view.plugins.avatars.avtr.description') }}</p>
            </template>

            <SettingsItem
                :label="t('view.plugins.avatars.avtr.client_id')"
                :description="t('view.plugins.avatars.avtr.client_id_hint')">
                <Input
                    v-model="clientId"
                    class="min-w-64"
                    placeholder="avtc_..."
                    :aria-label="t('view.plugins.avatars.avtr.client_id')"
                    @change="saveClientId" />
            </SettingsItem>

            <SettingsItem
                :label="t('view.plugins.avatars.avtr.client_secret')"
                :description="t('view.plugins.avatars.avtr.client_secret_hint')">
                <Input
                    v-model="clientSecret"
                    type="password"
                    class="min-w-64"
                    placeholder="avts_..."
                    :aria-label="t('view.plugins.avatars.avtr.client_secret')"
                    @change="saveClientSecret" />
            </SettingsItem>

            <!-- Only once a secret is actually set: a public client needs no
                 warning, and this one should not read as routine. -->
            <p v-if="clientSecret.trim()" class="m-0 text-xs text-amber-600 dark:text-amber-500">
                <i class="ri-alert-line" />
                {{ t('view.plugins.avatars.avtr.secret_warning') }}
            </p>

            <SettingsItem
                v-if="avtrConnected"
                :label="t('view.plugins.avatars.avtr.connected')"
                :description="connectionDescription">
                <Button size="sm" variant="outline" :disabled="avtrBusy" @click="disconnectAvtr">
                    {{ t('view.plugins.avatars.avtr.disconnect') }}
                </Button>
            </SettingsItem>

            <!-- Waiting for the user to approve the code at avtr.zip/activate -->
            <div v-else-if="pendingAuthorization" class="flex flex-col gap-3 rounded-lg border bg-card p-4">
                <p class="m-0 text-sm">{{ t('view.plugins.avatars.avtr.activate_hint') }}</p>
                <code class="rounded bg-muted px-3 py-2 text-center text-2xl font-semibold tracking-widest">
                    {{ pendingAuthorization.userCode }}
                </code>
                <div class="flex flex-wrap items-center gap-2">
                    <Button size="sm" @click="openActivatePage">
                        <i class="ri-external-link-line" />
                        {{ t('view.plugins.avatars.avtr.open_activate') }}
                    </Button>
                    <Button size="sm" variant="outline" @click="copyUserCode">
                        <i class="ri-file-copy-line" />
                        {{ t('view.plugins.avatars.avtr.copy_code') }}
                    </Button>
                    <Button size="sm" variant="ghost" @click="cancelConnect">
                        {{ t('view.plugins.avatars.avtr.cancel') }}
                    </Button>
                    <span class="text-xs text-muted-foreground">
                        <i class="ri-loader-4-line animate-spin" />
                        {{ t('view.plugins.avatars.avtr.waiting') }}
                    </span>
                </div>
            </div>

            <SettingsItem
                v-else
                :label="t('view.plugins.avatars.avtr.connect')"
                :description="t('view.plugins.avatars.avtr.connect_hint')">
                <Button size="sm" :disabled="!clientId.trim() || avtrBusy" @click="connectAvtr">
                    <i v-if="avtrBusy" class="ri-loader-4-line animate-spin" />
                    {{ t('view.plugins.avatars.avtr.connect') }}
                </Button>
            </SettingsItem>

            <p v-if="avtrError" class="m-0 text-sm text-destructive">{{ avtrError }}</p>
        </SettingsGroup>

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

            <details class="text-xs text-muted-foreground">
                <summary class="cursor-pointer select-none">
                    {{ t('view.plugins.avatars.features.header') }}
                    <span v-if="selectedFeatures.length > 0">({{ selectedFeatures.length }})</span>
                </summary>
                <div class="mt-2">
                    <p class="mt-0 mb-2">{{ t('view.plugins.avatars.features.description') }}</p>
                    <AvatarFeatureFilter v-model="selectedFeatures" v-model:mode="featureMode" />
                </div>
            </details>

            <!-- Searches avtr.zip itself when connected, so one button covers
                 both that and the custom endpoint below. -->
            <div class="flex flex-wrap items-center gap-2">
                <Button :disabled="!effectiveQuery || liveLoading || !hasLiveProvider" @click="runLiveSearch">
                    <i v-if="liveLoading" class="ri-loader-4-line animate-spin" />
                    <i v-else class="ri-search-line" />
                    {{ t('view.plugins.avatars.live.search') }}
                </Button>
                <Button v-if="liveHasMore" size="sm" variant="outline" :disabled="liveLoading" @click="loadMoreLive">
                    {{ t('view.plugins.avatars.show_more') }}
                </Button>
                <span v-if="!hasLiveProvider" class="text-xs text-muted-foreground">
                    {{ t('view.plugins.avatars.live.not_connected') }}
                </span>
                <span v-else-if="liveTotalLabel" class="text-xs text-muted-foreground">{{ liveTotalLabel }}</span>
            </div>

            <p v-if="liveError" class="m-0 text-sm text-destructive">{{ liveError }}</p>

            <!-- The API drops unknown facets and sorts instead of failing, so
                 these have to be shown or a typo silently narrows the query. -->
            <p v-for="warning in liveWarnings" :key="warning" class="m-0 text-xs text-amber-600 dark:text-amber-500">
                <i class="ri-alert-line" />
                {{ warning }}
            </p>

            <details class="text-xs text-muted-foreground">
                <summary class="cursor-pointer select-none">{{ t('view.plugins.avatars.live.header') }}</summary>
                <div class="mt-2 flex flex-col gap-2">
                    <p class="m-0">{{ t('view.plugins.avatars.live.description') }}</p>
                    <Input
                        v-model="liveSearchUrl"
                        class="min-w-64 flex-1"
                        :placeholder="t('view.plugins.avatars.live.placeholder')"
                        :aria-label="t('view.plugins.avatars.live.header')"
                        @change="saveLiveSearchUrl" />
                </div>
            </details>

            <p class="m-0 text-xs text-muted-foreground">
                {{ t('view.plugins.avatars.search.pool', { count: searchPool.length }) }}
            </p>

            <p v-if="featureQuery" class="m-0 text-xs text-muted-foreground">
                {{ t('view.plugins.avatars.features.applied') }}
                <code class="rounded bg-muted px-1 py-0.5">{{ featureQuery }}</code>
            </p>

            <div v-if="effectiveQuery && searchResults.length === 0" class="py-4 text-sm text-muted-foreground">
                {{ t('view.plugins.avatars.search.empty') }}
            </div>
            <div v-else-if="effectiveQuery" class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 pt-2">
                <AvatarSuggestionCard
                    v-for="avatar in searchResults"
                    :key="avatar.id"
                    :avatar="avatar"
                    :caption="avatar.authorName || ''"
                    :liked="avatar.liked"
                    :like-label="likeLabel(avatar)"
                    @click="openAvatar(avatar.id)"
                    @like="toggleLike(avatar)" />
            </div>
        </SettingsGroup>

        <!-- avtr.zip's own recommendations, from the user's likes and recent use -->
        <SettingsGroup v-if="canReadLikes" :title="t('view.plugins.avatars.recommended.header')">
            <template #description>
                <p class="m-0">{{ t('view.plugins.avatars.recommended.description') }}</p>
            </template>

            <SettingsItem
                :label="t('view.plugins.avatars.recommended.action')"
                :description="t('view.plugins.avatars.recommended.hint')">
                <Button size="sm" :disabled="recommendedLoading" @click="loadAvtrRecommendations">
                    <i v-if="recommendedLoading" class="ri-loader-4-line animate-spin" />
                    <i v-else class="ri-refresh-line" />
                    {{
                        recommendedAvatars.length > 0
                            ? t('view.plugins.avatars.recommended.refresh')
                            : t('view.plugins.avatars.recommended.fetch')
                    }}
                </Button>
            </SettingsItem>

            <p v-if="recommendedError" class="m-0 text-sm text-destructive">{{ recommendedError }}</p>

            <div v-if="recommendedAvatars.length > 0" class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 pt-2">
                <AvatarSuggestionCard
                    v-for="avatar in recommendedAvatars"
                    :key="avatar.id"
                    :avatar="avatar"
                    :caption="avatar.authorName || ''"
                    :liked="avatar.liked"
                    :like-label="likeLabel(avatar)"
                    @click="openAvatar(avatar.id)"
                    @like="toggleLike(avatar)" />
            </div>
            <p
                v-else-if="hasFetchedRecommended && !recommendedLoading && !recommendedError"
                class="m-0 py-2 text-sm text-muted-foreground">
                {{ t('view.plugins.avatars.recommended.empty') }}
            </p>
        </SettingsGroup>

        <!-- From the avatar database: explicit opt-in, since it leaves the machine -->
        <SettingsGroup :title="t('view.plugins.avatars.database.header')">
            <template #description>
                <p class="m-0">{{ t('view.plugins.avatars.database.description') }}</p>
            </template>

            <SettingsItem :label="t('view.plugins.avatars.database.action')" :description="providerDescription">
                <Button
                    size="sm"
                    :disabled="!hasProvider || loadingDatabase || loadingHistory"
                    @click="startDatabaseRecommendations">
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
    import AvatarFeatureFilter from './AvatarFeatureFilter.vue';
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
    import { copyToClipboard, openExternalLink } from '@/shared/utils';
    import { searchAvatars } from '../avatarQuery';
    import { getAvatar, getRecommendations, getUserInfo, setAvatarLiked } from '../avtrApi';
    import {
        AVTR_SCOPES,
        disconnect as disconnectAvtrZip,
        getClientId,
        getClientSecret,
        getStoredAccount,
        getStoredTokens,
        pollDeviceToken,
        setClientId,
        setClientSecret,
        setStoredAccount,
        startDeviceAuthorization
    } from '../avtrAuth';
    import { buildFeatureQuery } from '../avtrFeatures';
    import { getLiveSearchUrl, searchLive, setLiveSearchUrl } from '../avtrLiveSearch';

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
    /** Feature ids picked in the filter panel, kept out of the text box. */
    const selectedFeatures = ref([]);
    const featureMode = ref(/** @type {'any' | 'all'} */ ('all'));

    const syntaxExamples = computed(() => [
        { query: 'cat ears', hint: t('view.plugins.avatars.search.hint_text') },
        { query: '-nsfw cute', hint: t('view.plugins.avatars.search.hint_exclude') },
        { query: 'author:somecreator', hint: t('view.plugins.avatars.search.hint_author') },
        { query: 'tag:any(kemono, fox)', hint: t('view.plugins.avatars.search.hint_any') },
        { query: 'feature:gogoloco', hint: t('view.plugins.avatars.search.hint_feature') },
        { query: 'quest:>=Good', hint: t('view.plugins.avatars.search.hint_performance') },
        { query: 'paid:false', hint: t('view.plugins.avatars.search.hint_paid') },
        { query: 'price:100-500', hint: t('view.plugins.avatars.search.hint_price') },
        { query: 'impostor:true', hint: t('view.plugins.avatars.search.hint_impostor') },
        { query: 'fuzzy:0.6 protogen', hint: t('view.plugins.avatars.search.hint_fuzzy') },
        { query: 'sort:likes', hint: t('view.plugins.avatars.search.hint_sort') }
    ]);

    // avtr.zip connection, over the device-code grant: VRCX shows a nine-letter
    // code, the user approves it at avtr.zip/activate, and polling turns it
    // into a token. See `avtrAuth`.

    const clientId = ref('');
    /** Set only for a confidential app; '' means a public client. */
    const clientSecret = ref('');
    const avtrConnected = ref(false);
    const avtrAccount = ref(/** @type {object | null} */ (null));
    const avtrScopes = ref(/** @type {string[]} */ ([]));
    const avtrBusy = ref(false);
    const avtrError = ref('');
    const pendingAuthorization = ref(/** @type {Awaited<ReturnType<typeof startDeviceAuthorization>> | null} */ (null));
    /** Lets Cancel stop the polling loop. */
    let authorizationAbort = /** @type {AbortController | null} */ (null);

    const canReadLikes = computed(() => avtrConnected.value && avtrScopes.value.includes(AVTR_SCOPES.likesRead));
    const canWriteLikes = computed(() => avtrConnected.value && avtrScopes.value.includes(AVTR_SCOPES.likesWrite));

    const connectionDescription = computed(() => {
        const name = avtrAccount.value?.vrchatDisplayName || avtrAccount.value?.discordDisplayName;
        const scopes = avtrScopes.value.join(', ');
        return [name, scopes].filter(Boolean).join(' — ');
    });

    async function saveClientSecret() {
        await setClientSecret(clientSecret.value);
    }

    async function saveClientId() {
        await setClientId(clientId.value);
    }

    /** Reads whatever is stored, so the UI survives a reload. */
    async function refreshConnection() {
        const tokens = await getStoredTokens();
        avtrConnected.value = tokens !== null;
        avtrScopes.value = tokens?.scopes ?? [];
        avtrAccount.value = await getStoredAccount();
    }

    async function connectAvtr() {
        avtrBusy.value = true;
        avtrError.value = '';
        authorizationAbort = new AbortController();
        try {
            pendingAuthorization.value = await startDeviceAuthorization();
            const tokens = await pollDeviceToken(pendingAuthorization.value, {
                signal: authorizationAbort.signal
            });
            pendingAuthorization.value = null;
            avtrScopes.value = tokens.scopes;
            avtrConnected.value = true;

            // Name the account in the UI, when the grant allows it.
            if (tokens.scopes.includes(AVTR_SCOPES.identify)) {
                try {
                    const user = await getUserInfo();
                    await setStoredAccount(user);
                    avtrAccount.value = user;
                } catch (err) {
                    console.error('Could not read the avtr.zip account', err);
                }
            }
        } catch (err) {
            if (err?.error !== 'cancelled') {
                console.error('Could not connect to avtr.zip', err);
                avtrError.value = err instanceof Error ? err.message : String(err);
            }
            pendingAuthorization.value = null;
        } finally {
            authorizationAbort = null;
            avtrBusy.value = false;
        }
    }

    function cancelConnect() {
        authorizationAbort?.abort();
        pendingAuthorization.value = null;
    }

    function openActivatePage() {
        const target =
            pendingAuthorization.value?.verificationUriComplete || pendingAuthorization.value?.verificationUri;
        if (target) {
            openExternalLink(target);
        }
    }

    function copyUserCode() {
        if (pendingAuthorization.value?.userCode) {
            copyToClipboard(pendingAuthorization.value.userCode);
        }
    }

    async function disconnectAvtr() {
        avtrBusy.value = true;
        try {
            await disconnectAvtrZip();
            recommendedAvatars.value = [];
            hasFetchedRecommended.value = false;
            await refreshConnection();
        } catch (err) {
            console.error('Could not disconnect from avtr.zip', err);
            avtrError.value = err instanceof Error ? err.message : String(err);
        } finally {
            avtrBusy.value = false;
        }
    }

    // Live search. avtr.zip's own API when connected, otherwise the custom
    // endpoint below, which predates the API and is still supported. Results
    // join the local pool and are filtered by the same query, so a provider
    // that only does free text still works.

    const liveSearchUrl = ref('');
    const liveResults = ref([]);
    const liveLoading = ref(false);
    const liveError = ref('');
    const liveWarnings = ref(/** @type {string[]} */ ([]));
    const liveTotal = ref(/** @type {number | null} */ (null));
    const liveTotalIsEstimate = ref(false);
    const liveCursor = ref(/** @type {string | null} */ (null));
    const liveHasMore = ref(false);

    const hasLiveProvider = computed(() => avtrConnected.value || liveSearchUrl.value.trim().length > 0);

    const liveTotalLabel = computed(() => {
        if (liveTotal.value === null) {
            return '';
        }
        const count = liveTotal.value.toLocaleString();
        return liveTotalIsEstimate.value
            ? t('view.plugins.avatars.live.total_estimate', { count })
            : t('view.plugins.avatars.live.total', { count });
    });

    async function saveLiveSearchUrl() {
        await setLiveSearchUrl(liveSearchUrl.value);
    }

    /**
     * @param {boolean} append Keep what is already in the pool and page on
     */
    async function fetchLive(append) {
        liveLoading.value = true;
        liveError.value = '';
        try {
            const result = await searchLive(effectiveQuery.value, {
                cursor: append ? (liveCursor.value ?? undefined) : undefined,
                url: avtrConnected.value ? undefined : liveSearchUrl.value.trim() || undefined
            });
            liveResults.value = append ? [...liveResults.value, ...result.avatars] : result.avatars;
            liveWarnings.value = result.warnings;
            liveTotal.value = result.total;
            liveTotalIsEstimate.value = result.totalIsEstimate;
            liveCursor.value = result.nextCursor;
            // Only hasMore says whether another page exists; a short page does not.
            liveHasMore.value = result.hasMore && Boolean(result.nextCursor);
        } catch (err) {
            console.error('Live avatar search failed', err);
            liveError.value = err instanceof Error ? err.message : String(err);
            if (!append) {
                liveResults.value = [];
            }
        } finally {
            liveLoading.value = false;
        }
    }

    function runLiveSearch() {
        liveCursor.value = null;
        return fetchLive(false);
    }

    function loadMoreLive() {
        return fetchLive(true);
    }

    // avtr.zip's own recommendations. The endpoint answers with ids and scores
    // rather than cards, so each one is looked up; the list is deliberately
    // short, since that is one request per avatar.

    const recommendedAvatars = ref([]);
    const recommendedLoading = ref(false);
    const recommendedError = ref('');
    const hasFetchedRecommended = ref(false);

    /** How many recommendations to hydrate, and how many lookups at a time. */
    const RECOMMENDED_LIMIT = 24;
    const HYDRATE_BATCH = 6;

    async function loadAvtrRecommendations() {
        recommendedLoading.value = true;
        recommendedError.value = '';
        hasFetchedRecommended.value = true;
        try {
            const { items } = await getRecommendations({ limit: RECOMMENDED_LIMIT });
            const avatars = [];
            for (let index = 0; index < items.length; index += HYDRATE_BATCH) {
                const batch = items.slice(index, index + HYDRATE_BATCH);
                const cards = await Promise.all(batch.map((item) => getAvatar(item.avatarId)));
                // getAvatar answers null for anything hidden since the
                // recommendation was computed.
                avatars.push(...cards.filter(Boolean));
            }
            recommendedAvatars.value = avatars;
        } catch (err) {
            console.error('Could not load avtr.zip recommendations', err);
            recommendedError.value = err instanceof Error ? err.message : String(err);
            recommendedAvatars.value = [];
        } finally {
            recommendedLoading.value = false;
        }
    }

    /**
     * @param {object} avatar
     * @returns {string} The like toggle's label, or '' to hide it
     */
    function likeLabel(avatar) {
        // Only for records that came from avtr.zip: for anything else the
        // like state is unknown, and a toggle showing the wrong state is worse
        // than no toggle.
        if (!canWriteLikes.value || avatar?.source !== 'avtr.zip') {
            return '';
        }
        return avatar.liked ? t('view.plugins.avatars.avtr.unlike') : t('view.plugins.avatars.avtr.like');
    }

    /** @param {object} avatar */
    async function toggleLike(avatar) {
        const wanted = !avatar.liked;
        // Optimistic, then corrected from the response: `liked` there is the
        // state after the call, which is what the UI should show.
        avatar.liked = wanted;
        try {
            const result = await setAvatarLiked(avatar.id, wanted);
            avatar.liked = result.liked;
        } catch (err) {
            console.error('Could not change the like', err);
            avatar.liked = !wanted;
            avtrError.value = err instanceof Error ? err.message : String(err);
        }
    }

    /** The `feature:` fragment the filter panel contributes. */
    const featureQuery = computed(() => buildFeatureQuery(selectedFeatures.value, featureMode.value));

    /** What actually gets searched: the text box plus the filter panel. */
    const effectiveQuery = computed(() => [query.value.trim(), featureQuery.value].filter(Boolean).join(' '));

    /**
     * Everything searchable: your history, your favorites, and anything the
     * avatar database lookup has pulled in this session, shown or not.
     */
    const searchPool = computed(() => {
        const byId = new Map();
        for (const list of [history.value, favoriteAvatarRefs.value, databaseFetched.value, liveResults.value]) {
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

    const searchResults = computed(() => searchAvatars(searchPool.value, effectiveQuery.value).slice(0, 60));

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

    onMounted(async () => {
        liveSearchUrl.value = await getLiveSearchUrl();
        clientId.value = await getClientId();
        clientSecret.value = await getClientSecret();
        await refreshConnection();
        await loadHistory();
    });
</script>
