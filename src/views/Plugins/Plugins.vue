<template>
    <div class="x-container flex flex-col overflow-hidden!">
        <div class="shrink-0 p-1.5">
            <span class="text-lg font-semibold text-foreground">{{ t('view.plugins.header') }}</span>
        </div>
        <TabsUnderline default-value="plugins" :items="tabs" :unmount-on-hide="false" fill>
            <template #plugins>
                <PluginList />
            </template>
            <template #avatars>
                <RecommendedAvatars />
            </template>
        </TabsUnderline>
    </div>
</template>

<script setup>
    import { computed } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { TabsUnderline } from '@/components/ui/tabs';
    import PluginList from './components/PluginList.vue';
    import RecommendedAvatars from './components/RecommendedAvatars.vue';

    const { t } = useI18n();

    const tabs = computed(() => [
        { value: 'plugins', label: t('view.plugins.tab.plugins') },
        { value: 'avatars', label: t('view.plugins.tab.avatars') }
    ]);
</script>
