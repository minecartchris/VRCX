<template>
    <Dialog v-model:open="dialogOpen">
        <DialogScrollContent class="x-dialog sm:max-w-2xl">
            <DialogHeader>
                <DialogTitle>{{ pluginName }}</DialogTitle>
                <DialogDescription>{{ pluginDescription }}</DialogDescription>
            </DialogHeader>

            <div v-if="visibleFields.length === 0" class="text-sm text-muted-foreground py-4">
                {{ t('view.plugins.no_settings') }}
            </div>

            <div v-else class="flex flex-col gap-5 py-2">
                <PluginSettingField
                    v-for="field in visibleFields"
                    :key="field.key"
                    :field="field"
                    :model-value="draft[field.key]"
                    @update:modelValue="draft[field.key] = $event" />
            </div>

            <DialogFooter>
                <Button variant="ghost" class="mr-auto" @click="reset">
                    {{ t('view.plugins.reset_defaults') }}
                </Button>
                <Button variant="secondary" class="mr-2" @click="dialogOpen = false">
                    {{ t('view.plugins.cancel') }}
                </Button>
                <Button :disabled="saving" @click="save">
                    {{ t('view.plugins.save') }}
                </Button>
            </DialogFooter>
        </DialogScrollContent>
    </Dialog>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Button } from '@/components/ui/button';
    import {
        Dialog,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogScrollContent,
        DialogTitle
    } from '@/components/ui/dialog';
    import PluginSettingField from './PluginSettingField.vue';
    import { isFieldVisible, normalizeSettings, updatePluginSettings } from '@/plugin-system';

    const props = defineProps({
        open: { type: Boolean, default: false },
        plugin: { type: Object, default: null },
        settings: { type: Object, default: () => ({}) }
    });
    const emit = defineEmits(['update:open']);

    const { t, te } = useI18n();

    const draft = ref({});
    const saving = ref(false);

    const dialogOpen = computed({
        get: () => props.open,
        set: (value) => emit('update:open', value)
    });

    const pluginName = computed(() => {
        if (props.plugin?.nameKey && te(props.plugin.nameKey)) {
            return t(props.plugin.nameKey);
        }
        return props.plugin?.name ?? '';
    });

    const pluginDescription = computed(() => {
        if (props.plugin?.descriptionKey && te(props.plugin.descriptionKey)) {
            return t(props.plugin.descriptionKey);
        }
        return props.plugin?.description ?? '';
    });

    const visibleFields = computed(() =>
        (props.plugin?.settingsSchema ?? []).filter((field) => isFieldVisible(field, draft.value))
    );

    watch(
        () => [props.open, props.plugin?.id],
        ([open]) => {
            if (open) {
                draft.value = { ...props.settings };
            }
        },
        { immediate: true }
    );

    function reset() {
        draft.value = normalizeSettings(props.plugin?.settingsSchema, null);
    }

    async function save() {
        if (!props.plugin) {
            return;
        }
        saving.value = true;
        try {
            await updatePluginSettings(props.plugin.id, draft.value);
            dialogOpen.value = false;
        } finally {
            saving.value = false;
        }
    }
</script>
