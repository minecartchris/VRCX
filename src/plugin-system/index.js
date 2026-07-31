import {
    useFriendStore,
    useGameLogStore,
    useGameStore,
    useLocationStore
} from '../stores';
import { builtinPlugins } from './plugins';
import { initPluginManager, shutdownPlugins } from './manager';
import { loadExternalPlugins } from './external';
import { registerPlugins } from './registry';
import { startPluginSources, stopPluginSources } from './sources';

let registered = false;

/**
 * Boots the plugin system. Must run after Pinia is installed, because plugins
 * and the event sources both read from the app's stores.
 *
 * @returns {Promise<void>}
 */
export async function initPluginSystem() {
    if (!registered) {
        registerPlugins(builtinPlugins);
        // Imported plugins must be in the registry before the manager reads
        // persisted enable flags, or an enabled import would not start.
        await loadExternalPlugins();
        registered = true;
    }

    startPluginSources({
        gameLogStore: useGameLogStore(),
        locationStore: useLocationStore(),
        friendStore: useFriendStore(),
        gameStore: useGameStore()
    });

    await initPluginManager();
}

/**
 * @returns {Promise<void>}
 */
export async function teardownPluginSystem() {
    stopPluginSources();
    await shutdownPlugins();
}

export * from './chatbox';
export * from './eventBus';
export * from './external';
export * from './remote';
export * from './manager';
export * from './registry';
export * from './settingsSchema';
