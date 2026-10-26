<template>
    <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
            <Input
                v-model="featureSearch"
                class="min-w-48 flex-1"
                :placeholder="t('view.plugins.avatars.features.search_placeholder')"
                :aria-label="t('view.plugins.avatars.features.search_placeholder')" />

            <ToggleGroup :model-value="mode" type="single" size="sm" @update:model-value="onModeChange">
                <ToggleGroupItem value="all">{{ t('view.plugins.avatars.features.mode_all') }}</ToggleGroupItem>
                <ToggleGroupItem value="any">{{ t('view.plugins.avatars.features.mode_any') }}</ToggleGroupItem>
            </ToggleGroup>

            <Button size="sm" variant="outline" :disabled="refreshing" @click="refreshCatalog">
                <i :class="refreshing ? 'ri-loader-4-line animate-spin' : 'ri-refresh-line'" />
                {{ t('view.plugins.avatars.features.refresh') }}
            </Button>
        </div>

        <p v-if="refreshError" class="m-0 text-xs text-muted-foreground">
            {{ t('view.plugins.avatars.features.refresh_failed') }}
        </p>

        <!-- What is selected, and a quick way to drop one -->
        <div v-if="modelValue.length > 0" class="flex flex-wrap items-center gap-1.5">
            <Badge
                v-for="id in modelValue"
                :key="id"
                variant="secondary"
                class="cursor-pointer"
                :title="id"
                @click="toggle(id)">
                {{ labelFor(id) }}
                <i class="ri-close-line" />
            </Badge>
            <Button size="sm" variant="ghost" @click="clear">
                {{ t('view.plugins.avatars.features.clear') }}
            </Button>
        </div>

        <p class="m-0 text-xs text-muted-foreground">
            {{
                modelValue.length > 0
                    ? t('view.plugins.avatars.features.selected', { count: modelValue.length })
                    : t('view.plugins.avatars.features.none_selected')
            }}
        </p>

        <!-- Matches while searching, grouped by category otherwise -->
        <div v-if="featureSearch.trim()" class="flex flex-col gap-1">
            <p v-if="matches.length === 0" class="m-0 py-2 text-sm text-muted-foreground">
                {{ t('view.plugins.avatars.features.no_matches') }}
            </p>
            <label
                v-for="feature in matches"
                :key="feature.id"
                class="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-muted">
                <Checkbox :model-value="isSelected(feature.id)" @update:model-value="toggle(feature.id)" />
                <span class="text-sm">{{ feature.label }}</span>
                <span class="text-xs text-muted-foreground">{{ feature.category }}</span>
                <span class="ml-auto text-xs text-muted-foreground">{{ formatCount(feature.count) }}</span>
            </label>
        </div>

        <details v-for="group in groups" v-else :key="group.id" class="rounded border border-border px-2 py-1">
            <summary class="cursor-pointer select-none text-sm">
                {{ group.label }}
                <span class="text-xs text-muted-foreground">
                    {{
                        selectedInGroup(group) > 0
                            ? `${selectedInGroup(group)}/${group.features.length}`
                            : group.features.length
                    }}
                </span>
            </summary>
            <div class="mt-1 flex flex-col gap-0.5 pb-1">
                <label
                    v-for="feature in group.features"
                    :key="feature.id"
                    class="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-muted">
                    <Checkbox :model-value="isSelected(feature.id)" @update:model-value="toggle(feature.id)" />
                    <span class="text-sm">{{ feature.label }}</span>
                    <span class="ml-auto text-xs text-muted-foreground">{{ formatCount(feature.count) }}</span>
                </label>
            </div>
        </details>
    </div>
</template>

<script setup>
    import { computed, ref } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Badge } from '@/components/ui/badge';
    import { Button } from '@/components/ui/button';
    import { Checkbox } from '@/components/ui/checkbox';
    import { Input } from '@/components/ui/input';
    import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
    import {
        FEATURE_CATALOG,
        fetchFeatureCatalog,
        groupFeaturesByCategory,
        indexFeatures,
        searchFeatures
    } from '../avtrFeatures';

    /** Enough rows to scan, few enough to stay responsive while typing. */
    const MATCH_LIMIT = 60;

    const props = defineProps({
        /** Selected feature ids. */
        modelValue: { type: Array, default: () => [] },
        /** Whether an avatar must have all the selected features or any of them. */
        mode: { type: String, default: 'all' }
    });

    const emit = defineEmits(['update:modelValue', 'update:mode']);

    const { t } = useI18n();

    const featureSearch = ref('');
    const catalog = ref(FEATURE_CATALOG);
    const refreshing = ref(false);
    const refreshError = ref(false);

    const groups = computed(() => groupFeaturesByCategory(catalog.value));
    const index = computed(() => indexFeatures(catalog.value));
    const matches = computed(() => searchFeatures(featureSearch.value, { catalog: catalog.value, limit: MATCH_LIMIT }));

    /**
     * @param {string} id
     * @returns {boolean}
     */
    function isSelected(id) {
        return props.modelValue.includes(id);
    }

    /**
     * @param {string} id
     */
    function toggle(id) {
        const next = isSelected(id) ? props.modelValue.filter((entry) => entry !== id) : [...props.modelValue, id];
        emit('update:modelValue', next);
    }

    function clear() {
        emit('update:modelValue', []);
    }

    /**
     * @param {string | null} value
     */
    function onModeChange(value) {
        // The toggle group clears itself when you click the active item; the
        // filter still needs a mode, so keep the current one.
        emit('update:mode', value || props.mode);
    }

    /**
     * @param {string} id
     * @returns {string} The human label, falling back to the raw id
     */
    function labelFor(id) {
        return index.value.byId.get(String(id).toLowerCase())?.label ?? id;
    }

    /**
     * @param {{ features: { id: string }[] }} group
     * @returns {number}
     */
    function selectedInGroup(group) {
        return group.features.filter((feature) => isSelected(feature.id)).length;
    }

    /**
     * @param {number} count
     * @returns {string} Compact count, e.g. 52k
     */
    function formatCount(count) {
        if (!Number.isFinite(count) || count <= 0) {
            return '';
        }
        return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
    }

    /**
     * Pulls the current vocabulary from avtr.zip, keeping the bundled snapshot
     * when that fails — a stale list is far better than an empty one.
     */
    async function refreshCatalog() {
        refreshing.value = true;
        refreshError.value = false;
        try {
            catalog.value = await fetchFeatureCatalog();
        } catch (err) {
            console.error('Feature catalog refresh failed', err);
            refreshError.value = true;
        } finally {
            refreshing.value = false;
        }
    }
</script>
