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
                    v-for="avatar in rediscoveries"
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
        </SettingsGroup>

        <!-- From the avatar database: explicit opt-in, since it leaves the machine -->
        <SettingsGroup :title="t('view.plugins.avatars.database.header')">
            <template #description>
                <p class="m-0">{{ t('view.plugins.avatars.database.description') }}</p>
            </template>

            <SettingsItem :label="t('view.plugins.avatars.database.action')" :description="providerDescription">
                <Button size="sm" :disabled="!hasProvider || loadingDatabase" @click="loadFromDatabase">
                    <i v-if="loadingDatabase" class="ri-loader-4-line animate-spin" />
                    {{ loadingDatabase ? t('view.plugins.avatars.loading') : t('view.plugins.avatars.database.fetch') }}
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
    import { filterNewAvatars, formatAge, pickTopAuthors, rankRediscoveries } from '../recommendations';
    import { searchAvatars } from '../avatarQuery';

    const { t } = useI18n();

    const userStore = useUserStore();
    const favoriteStore = useFavoriteStore();
    const avatarProviderStore = useAvatarProviderStore();

    const history = ref([]);
    const loadingHistory = ref(false);
    const loadingDatabase = ref(false);
    const hasSearchedDatabase = ref(false);
    const databaseError = ref('');
    const databaseResults = ref([]);
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
     * avatar database lookup has pulled in this session.
     */
    const searchPool = computed(() => {
        const byId = new Map();
        for (const list of [history.value, favoriteAvatarRefs.value, databaseResults.value]) {
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

    const rediscoveries = computed(() =>
        rankRediscoveries(history.value, {
            excludeIds: [userStore.currentUser?.currentAvatar].filter(Boolean)
        })
    );

    function openAvatar(avatarId) {
        showAvatarDialog(avatarId);
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

    async function loadFromDatabase() {
        loadingDatabase.value = true;
        databaseError.value = '';
        hasSearchedDatabase.value = true;
        try {
            const authors = pickTopAuthors(history.value, favoriteStore.favoriteAvatars, {
                excludeAuthorId: userStore.currentUser?.id ?? ''
            });
            if (authors.length === 0) {
                databaseResults.value = [];
                return;
            }

            // Everything already in your history or favorites is, by
            // definition, not a recommendation.
            const known = new Set(history.value.map((entry) => entry.id));
            for (const favorite of favoriteStore.favoriteAvatars ?? []) {
                const id = favorite?.id ?? favorite?.ref?.id;
                if (id) {
                    known.add(id);
                }
            }

            const found = [];
            for (const authorId of authors) {
                const byAuthor = await lookupAvatars('authorId', authorId);
                found.push(...byAuthor.values());
            }
            databaseResults.value = filterNewAvatars(found, known);
        } catch (err) {
            console.error('Avatar database lookup failed', err);
            databaseError.value = err instanceof Error ? err.message : String(err);
            databaseResults.value = [];
        } finally {
            loadingDatabase.value = false;
        }
    }

    onMounted(loadHistory);
</script>
