<template>
    <TooltipProvider>
        <MacOSTitleBar></MacOSTitleBar>

        <div
            id="x-app"
            class="flex w-screen h-screen overflow-hidden cursor-default [&>.x-container]:pt-[15px]"
            :class="{ 'pt-7': isMacOS }">
            <RouterView></RouterView>
            <Toaster position="top-center" :theme="theme"></Toaster>

            <AlertDialogModal></AlertDialogModal>
            <PromptDialogModal></PromptDialogModal>
            <OtpDialogModal></OtpDialogModal>
            <DatabaseUpgradeDialog></DatabaseUpgradeDialog>

            <VRCXUpdateDialog></VRCXUpdateDialog>
            <PluginImportDialog v-model:open="pluginImportOpen" :initial-code="pluginImportCode" />
        </div>
        <div id="x-dialog-portal" class="x-dialog-portal"></div>
    </TooltipProvider>
</template>

<script setup>
    import { computed, onBeforeMount, onMounted, ref, watch } from 'vue';

    import { addGameLogEvent, getGameLogTable } from './coordinators/gameLogCoordinator';
    import {
        runCheckVRChatDebugLoggingFlow,
        runUpdateIsGameRunningFlow,
        runUpdateIsHmdAfkFlow
    } from './coordinators/gameCoordinator';
    import { Toaster } from './components/ui/sonner';
    import { TooltipProvider } from './components/ui/tooltip';
    import { createGlobalStores } from './stores';
    import { initNoty } from './plugins/noty';
    import { initPluginSystem, pendingImport } from './plugin-system';

    import AlertDialogModal from './components/ui/alert-dialog/AlertDialogModal.vue';
    import DatabaseUpgradeDialog from './components/dialogs/DatabaseUpgradeDialog.vue';
    import MacOSTitleBar from './components/MacOSTitleBar.vue';
    import OtpDialogModal from './components/ui/dialog/OtpDialogModal.vue';
    import PromptDialogModal from './components/ui/dialog/PromptDialogModal.vue';
    import PluginImportDialog from './views/Settings/components/PluginImportDialog.vue';
    import VRCXUpdateDialog from './components/dialogs/VRCXUpdateDialog.vue';

    import '@/styles/globals.css';

    console.log(`isLinux: ${LINUX}`);

    const isMacOS = computed(() => navigator.platform.includes('Mac'));

    // The import dialog lives here rather than in the Plugins tab so a
    // vrcx://import-plugin link works whichever view is open.
    const pluginImportOpen = ref(false);
    const pluginImportCode = ref('');

    watch(pendingImport, (request) => {
        if (!request) {
            return;
        }
        pluginImportCode.value = request.code;
        pluginImportOpen.value = true;
    });

    const theme = computed(() => {
        return store.appearanceSettings.isDarkMode ? 'dark' : 'light';
    });

    initNoty();

    const store = createGlobalStores();

    if (typeof window !== 'undefined') {
        window.$pinia = store;
        // Bridge: attach coordinator functions to store for C# IPC callbacks
        store.game.updateIsGameRunning = runUpdateIsGameRunningFlow;
        store.game.updateIsHmdAfk = runUpdateIsHmdAfkFlow;
        store.gameLog.addGameLogEvent = addGameLogEvent;
    }

    onBeforeMount(() => {
        store.updateLoop.updateLoop();
    });

    onMounted(async () => {
        if (await store.vrcx.waitForDatabaseInit()) {
            getGameLogTable();
            await store.auth.migrateStoredUsers();
            store.auth.autoLoginAfterMounted();
            store.vrcx.checkAutoBackupRestoreVrcRegistry();
            // Plugins persist their state in the config database, so they can
            // only start once it is ready.
            initPluginSystem().catch((err) => console.error('Failed to init plugin system', err));
        }

        runCheckVRChatDebugLoggingFlow();
    });
</script>
