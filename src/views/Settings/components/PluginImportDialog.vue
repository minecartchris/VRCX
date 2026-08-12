<template>
    <Dialog v-model:open="dialogOpen">
        <DialogScrollContent class="x-dialog sm:max-w-2xl">
            <DialogHeader>
                <DialogTitle>{{ t('view.plugins.import.title') }}</DialogTitle>
                <DialogDescription>{{ t('view.plugins.import.description') }}</DialogDescription>
            </DialogHeader>

            <div class="flex flex-col gap-4 py-2">
                <div class="flex flex-col gap-1.5">
                    <label class="text-sm font-medium text-foreground">{{ t('view.plugins.import.code_label') }}</label>
                    <div class="flex gap-2">
                        <Input
                            v-model="code"
                            placeholder="gist link, https bundle link, or owner/repo"
                            :disabled="loading"
                            class="flex-1"
                            @keyup.enter="preview" />
                        <Button :disabled="loading || !code.trim()" @click="preview">
                            {{ loading ? t('view.plugins.import.loading') : t('view.plugins.import.fetch') }}
                        </Button>
                    </div>
                    <span class="text-xs text-muted-foreground">{{ t('view.plugins.import.code_hint') }}</span>
                </div>

                <p v-if="error" class="m-0 text-sm text-destructive">{{ error }}</p>

                <template v-if="fetched">
                    <div class="rounded-md border p-3 flex flex-col gap-2">
                        <div class="flex items-center gap-2 flex-wrap">
                            <i :class="[fetched.manifest.icon || 'ri-puzzle-line', 'text-lg text-muted-foreground']" />
                            <span class="text-sm font-medium">{{ fetched.manifest.name }}</span>
                            <Badge variant="secondary" class="text-[10px]">{{ fetched.manifest.id }}</Badge>
                            <Badge v-if="fetched.manifest.version" variant="outline" class="text-[10px]">
                                v{{ fetched.manifest.version }}
                            </Badge>
                        </div>
                        <span v-if="fetched.manifest.description" class="text-xs text-muted-foreground">
                            {{ fetched.manifest.description }}
                        </span>
                        <span class="text-xs text-muted-foreground break-all">{{ fetched.sourceUrl }}</span>
                        <span class="text-xs text-muted-foreground">
                            {{ t('view.plugins.import.source_size', { kb: sourceKb }) }}
                        </span>
                    </div>

                    <div class="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                        <p class="m-0 text-xs text-destructive">{{ t('view.plugins.import.warning') }}</p>
                    </div>

                    <details class="rounded-md border">
                        <summary class="cursor-pointer px-3 py-2 text-sm">
                            {{ t('view.plugins.import.review_source') }}
                        </summary>
                        <pre
                            class="max-h-80 overflow-auto px-3 pb-3 text-xs whitespace-pre-wrap break-words font-mono m-0"
                            >{{ fetched.source }}</pre>
                    </details>
                </template>
            </div>

            <DialogFooter>
                <Button variant="secondary" class="mr-2" @click="dialogOpen = false">
                    {{ t('view.plugins.cancel') }}
                </Button>
                <Button :disabled="!fetched || installing" @click="install">
                    {{ t('view.plugins.import.install') }}
                </Button>
            </DialogFooter>
        </DialogScrollContent>
    </Dialog>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { toast } from 'vue-sonner';

    import { Badge } from '@/components/ui/badge';
    import { Button } from '@/components/ui/button';
    import {
        Dialog,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogScrollContent,
        DialogTitle
    } from '@/components/ui/dialog';
    import { Input } from '@/components/ui/input';
    import { installExternalPlugin, previewExternalPlugin } from '@/plugin-system';

    const props = defineProps({
        open: { type: Boolean, default: false }
    });
    const emit = defineEmits(['update:open']);

    const { t } = useI18n();

    const code = ref('');
    const fetched = ref(null);
    const error = ref('');
    const loading = ref(false);
    const installing = ref(false);

    const dialogOpen = computed({
        get: () => props.open,
        set: (value) => emit('update:open', value)
    });

    const sourceKb = computed(() => ((fetched.value?.source.length ?? 0) / 1024).toFixed(1));

    watch(
        () => props.open,
        (open) => {
            if (open) {
                code.value = '';
                fetched.value = null;
                error.value = '';
            }
        }
    );

    // Editing the code invalidates the preview, so the install button can never
    // apply to something other than what is on screen.
    watch(code, () => {
        fetched.value = null;
    });

    async function preview() {
        loading.value = true;
        error.value = '';
        fetched.value = null;
        try {
            fetched.value = await previewExternalPlugin(code.value);
        } catch (err) {
            error.value = err instanceof Error ? err.message : String(err);
        } finally {
            loading.value = false;
        }
    }

    async function install() {
        if (!fetched.value) {
            return;
        }
        installing.value = true;
        error.value = '';
        try {
            await installExternalPlugin(fetched.value);
            toast.success(t('view.plugins.import.installed', { name: fetched.value.manifest.name }));
            dialogOpen.value = false;
        } catch (err) {
            error.value = err instanceof Error ? err.message : String(err);
        } finally {
            installing.value = false;
        }
    }
</script>
