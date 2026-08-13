<template>
    <div class="flex flex-col gap-10 py-2">
        <div class="flex items-start justify-between gap-6 pl-0.5">
            <div class="flex flex-col gap-1.5">
                <p class="m-0 text-sm text-muted-foreground">{{ t('view.plugins.intro') }}</p>
                <p v-if="!oscSupported" class="m-0 text-sm text-destructive">
                    {{ t('view.plugins.osc_unavailable') }}
                </p>
            </div>
            <Button size="sm" variant="outline" class="shrink-0 gap-1.5" @click="requestPluginImport('')">
                <i class="ri-github-line" />
                {{ t('view.plugins.import.button') }}
            </Button>
        </div>

        <SettingsGroup v-for="category in categories" :key="category.key" :title="t(category.labelKey)">
            <div
                v-for="plugin in category.plugins"
                :key="plugin.id"
                class="flex items-start justify-between gap-6 py-2">
                <div class="flex gap-3 min-w-0 flex-1">
                    <i :class="[plugin.icon || 'ri-puzzle-line', 'text-lg text-muted-foreground mt-0.5']" />
                    <div class="flex flex-col gap-0.5 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-sm font-medium text-foreground">{{ pluginName(plugin) }}</span>
                            <Badge v-if="plugin.experimental" variant="outline" class="text-[10px]">
                                {{ t('view.plugins.experimental') }}
                            </Badge>
                            <Badge v-if="dependencyLabel(plugin)" variant="secondary" class="text-[10px]">
                                {{ dependencyLabel(plugin) }}
                            </Badge>
                        </div>
                        <span class="text-xs leading-tight text-muted-foreground">
                            {{ pluginDescription(plugin) }}
                        </span>
                        <span
                            v-if="statusLine(plugin)"
                            class="text-xs leading-tight truncate"
                            :class="statusClass(plugin)">
                            {{ statusLine(plugin) }}
                        </span>
                    </div>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                    <Button
                        v-if="plugin.external"
                        size="sm"
                        variant="ghost"
                        :aria-label="t('view.plugins.import.update')"
                        @click="update(plugin)">
                        <i class="ri-refresh-line" />
                    </Button>
                    <Button
                        v-if="plugin.external"
                        size="sm"
                        variant="ghost"
                        :aria-label="t('view.plugins.import.remove')"
                        @click="remove(plugin)">
                        <i class="ri-delete-bin-line" />
                    </Button>
                    <Button
                        v-if="plugin.settingsSchema?.length"
                        size="sm"
                        variant="ghost"
                        :aria-label="t('view.plugins.configure')"
                        @click="configure(plugin)">
                        <i class="ri-settings-3-line" />
                    </Button>
                    <Switch
                        :model-value="isEnabled(plugin)"
                        :aria-label="pluginName(plugin)"
                        @update:modelValue="toggle(plugin, $event)" />
                </div>
            </div>
        </SettingsGroup>

        <PluginSettingsDialog v-model:open="dialogOpen" :plugin="selectedPlugin" :settings="selectedSettings" />
    </div>
</template>

<script setup>
    import { computed, ref } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Badge } from '@/components/ui/badge';
    import { Button } from '@/components/ui/button';
    import { Switch } from '@/components/ui/switch';
    import PluginSettingsDialog from '../PluginSettingsDialog.vue';
    import SettingsGroup from '../SettingsGroup.vue';
    import {
        externalPlugins,
        getAllPlugins,
        getPlugin,
        pluginCategories,
        pluginState,
        requestPluginImport,
        setPluginEnabled,
        uninstallExternalPlugin,
        updateExternalPlugin
    } from '@/plugin-system';
    import { oscService } from '@/services/osc';
    import { toast } from 'vue-sonner';

    const { t, te } = useI18n();

    const dialogOpen = ref(false);
    const selectedPlugin = ref(null);

    const oscSupported = oscService.isSupported;

    const categories = computed(() => {
        // `externalPlugins` is only read so this recomputes when an import is
        // added or removed — the registry itself is not reactive.
        void externalPlugins.length;
        return pluginCategories
            .map((category) => ({
                ...category,
                plugins: getAllPlugins().filter((plugin) => plugin.category === category.key)
            }))
            .filter((category) => category.plugins.length > 0);
    });

    const selectedSettings = computed(() => {
        const id = selectedPlugin.value?.id;
        return id ? (pluginState[id]?.settings ?? {}) : {};
    });

    function pluginName(plugin) {
        return plugin.nameKey && te(plugin.nameKey) ? t(plugin.nameKey) : plugin.name;
    }

    function pluginDescription(plugin) {
        return plugin.descriptionKey && te(plugin.descriptionKey)
            ? t(plugin.descriptionKey)
            : (plugin.description ?? '');
    }

    function dependencyLabel(plugin) {
        if (!plugin.requires?.length) {
            return '';
        }
        const names = plugin.requires.map((id) => {
            const dependency = getPlugin(id);
            return dependency ? pluginName(dependency) : id;
        });
        return t('view.plugins.requires', { plugins: names.join(', ') });
    }

    function isEnabled(plugin) {
        return Boolean(pluginState[plugin.id]?.enabled);
    }

    function statusLine(plugin) {
        return pluginState[plugin.id]?.status ?? '';
    }

    function statusClass(plugin) {
        switch (pluginState[plugin.id]?.statusState) {
            case 'error':
                return 'text-destructive';
            case 'warning':
                return 'text-amber-500';
            default:
                return 'text-muted-foreground';
        }
    }

    function toggle(plugin, enabled) {
        setPluginEnabled(plugin.id, enabled);
    }

    function configure(plugin) {
        selectedPlugin.value = plugin;
        dialogOpen.value = true;
    }

    async function update(plugin) {
        try {
            await updateExternalPlugin(plugin.id);
            toast.success(t('view.plugins.import.updated', { name: plugin.name }));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    }

    async function remove(plugin) {
        try {
            await uninstallExternalPlugin(plugin.id);
            toast.success(t('view.plugins.import.removed', { name: plugin.name }));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    }
</script>
