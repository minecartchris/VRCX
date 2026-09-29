<template>
    <Dialog :open="open" @update:open="onOpenChange">
        <DialogContent class="x-dialog sm:max-w-md">
            <DialogHeader>
                <DialogTitle>{{ t('dialog.feed_history_delete.header') }}</DialogTitle>
                <DialogDescription>{{ t('dialog.feed_history_delete.description') }}</DialogDescription>
            </DialogHeader>

            <Alert variant="warning">
                <TriangleAlert />
                <AlertDescription>{{ t('dialog.feed_history_delete.warning') }}</AlertDescription>
            </Alert>

            <div class="flex flex-col gap-2">
                <span class="text-sm font-medium">{{ t('dialog.feed_history_delete.types') }}</span>
                <div class="grid grid-cols-2 gap-x-6 gap-y-2">
                    <label
                        v-for="type in FEED_HISTORY_TYPES"
                        :key="type"
                        class="flex cursor-pointer items-center gap-2 text-sm"
                        :data-type="type">
                        <Checkbox
                            :model-value="selectedTypes.includes(type)"
                            :disabled="deleting"
                            @update:model-value="(checked) => setTypeSelected(type, checked)" />
                        <span class="flex-1">{{ t(`view.feed.filters.${type}`) }}</span>
                        <span class="text-xs tabular-nums text-muted-foreground">{{ typeCountLabel(type) }}</span>
                    </label>
                </div>
            </div>

            <div class="flex items-center justify-between gap-4">
                <span class="text-sm font-medium">{{ t('dialog.feed_history_delete.older_than') }}</span>
                <Select v-model="period" :disabled="deleting">
                    <SelectTrigger class="w-36">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectItem v-for="option in PERIODS" :key="option" :value="option">
                                {{ t(`dialog.feed_history_delete.period.${option}`) }}
                            </SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>
            </div>

            <p class="text-sm" :class="total ? 'text-foreground' : 'text-muted-foreground'" data-testid="summary">
                {{ summary }}
            </p>

            <DialogFooter>
                <Button variant="outline" size="sm" :disabled="deleting" @click="close">
                    {{ t('confirm.cancel_button') }}
                </Button>
                <Button variant="destructive" size="sm" :disabled="!canDelete" @click="confirmDelete">
                    <Spinner v-if="deleting" />
                    <Trash2 v-else class="h-4 w-4" />
                    {{ deleting ? t('dialog.feed_history_delete.deleting') : t('dialog.feed_history_delete.confirm') }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>

<script setup>
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogTitle
    } from '@/components/ui/dialog';
    import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
    import { Trash2, TriangleAlert } from 'lucide-vue-next';
    import { computed, ref, watch } from 'vue';
    import { Alert, AlertDescription } from '@/components/ui/alert';
    import { Button } from '@/components/ui/button';
    import { Checkbox } from '@/components/ui/checkbox';
    import { Spinner } from '@/components/ui/spinner';
    import { toast } from 'vue-sonner';
    import { useI18n } from 'vue-i18n';

    import { FEED_HISTORY_TYPES } from '../../services/database/feedHistory';
    import { useAdvancedSettingsStore, useFeedStore } from '../../stores';

    const PERIODS = ['30', '90', '180', '365', '730', 'all'];
    const DEFAULT_PERIOD = '365';

    const props = defineProps({
        open: { type: Boolean, default: false }
    });
    const emit = defineEmits(['update:open']);

    const { t } = useI18n();
    const feedStore = useFeedStore();
    const advancedSettingsStore = useAdvancedSettingsStore();

    const selectedTypes = ref([...FEED_HISTORY_TYPES]);
    const period = ref(DEFAULT_PERIOD);
    // The cutoff the counts were taken with; deleting reuses it so exactly what was shown is what goes.
    const cutoffDate = ref(null);
    const counts = ref(null);
    const countFailed = ref(false);
    const deleting = ref(false);
    let countRequest = 0;

    const total = computed(() => {
        if (!counts.value) {
            return 0;
        }
        return selectedTypes.value.reduce((sum, type) => sum + (counts.value[type] ?? 0), 0);
    });

    const canDelete = computed(() => !deleting.value && counts.value !== null && total.value > 0);

    const summary = computed(() => {
        if (countFailed.value) {
            return t('dialog.feed_history_delete.count_failed');
        }
        if (counts.value === null) {
            return t('dialog.feed_history_delete.counting');
        }
        if (!selectedTypes.value.length) {
            return t('dialog.feed_history_delete.no_types');
        }
        if (!total.value) {
            return t('dialog.feed_history_delete.nothing');
        }
        return t('dialog.feed_history_delete.summary', { count: total.value.toLocaleString() });
    });

    /**
     * @param {string} value One of PERIODS
     * @returns {string | null} ISO cutoff, or null for entries of any age
     */
    function cutoffFor(value) {
        if (value === 'all') {
            return null;
        }
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - Number(value));
        return cutoff.toJSON();
    }

    /**
     * @param {string} type
     * @returns {string}
     */
    function typeCountLabel(type) {
        const count = counts.value?.[type];
        return count === undefined ? '' : count.toLocaleString();
    }

    /**
     * @param {string} type
     * @param {boolean | 'indeterminate'} checked
     */
    function setTypeSelected(type, checked) {
        const selected = new Set(selectedTypes.value);
        if (checked === true) {
            selected.add(type);
        } else {
            selected.delete(type);
        }
        selectedTypes.value = FEED_HISTORY_TYPES.filter((feedType) => selected.has(feedType));
    }

    async function refreshCounts() {
        const request = ++countRequest;
        const cutoff = cutoffFor(period.value);
        cutoffDate.value = cutoff;
        counts.value = null;
        countFailed.value = false;
        try {
            const result = await feedStore.countFeedHistory(FEED_HISTORY_TYPES, cutoff);
            if (request === countRequest) {
                counts.value = result;
            }
        } catch (err) {
            console.error('[feed] failed to count feed history', err);
            if (request === countRequest) {
                countFailed.value = true;
            }
        }
    }

    function close() {
        emit('update:open', false);
    }

    /**
     * @param {boolean} value
     */
    function onOpenChange(value) {
        // Closing mid-delete would hide the only sign that it is still running.
        if (!value && deleting.value) {
            return;
        }
        emit('update:open', value);
    }

    async function confirmDelete() {
        if (!canDelete.value) {
            return;
        }
        deleting.value = true;
        const expected = total.value;
        try {
            const deleted = await feedStore.deleteFeedHistory([...selectedTypes.value], cutoffDate.value);
            toast.success(t('dialog.feed_history_delete.done', { count: (deleted || expected).toLocaleString() }));
            Promise.resolve(advancedSettingsStore.getSqliteTableSizes()).catch((err) =>
                console.error('[feed] failed to refresh table sizes', err)
            );
            deleting.value = false;
            close();
        } catch (err) {
            console.error('[feed] failed to delete feed history', err);
            const error = String(err?.message ?? err);
            const deletedSoFar = Number(err?.deletedSoFar) || 0;
            toast.error(
                deletedSoFar
                    ? t('dialog.feed_history_delete.partial', { count: deletedSoFar.toLocaleString(), error })
                    : t('dialog.feed_history_delete.failed', { error })
            );
            deleting.value = false;
            refreshCounts();
        }
    }

    watch(
        [() => props.open, period],
        ([open]) => {
            if (open) {
                refreshCounts();
            }
        },
        { immediate: true }
    );

    watch(
        () => props.open,
        (open) => {
            if (!open) {
                // Start from the cautious defaults each time rather than remembering "any age".
                countRequest++;
                selectedTypes.value = [...FEED_HISTORY_TYPES];
                period.value = DEFAULT_PERIOD;
                counts.value = null;
                countFailed.value = false;
            }
        }
    );
</script>
