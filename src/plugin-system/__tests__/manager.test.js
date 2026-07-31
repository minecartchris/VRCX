import { beforeEach, describe, expect, test, vi } from 'vitest';

const store = new Map();

vi.mock('../../services/config', () => ({
    default: {
        getString: vi.fn(async (key, fallback = null) =>
            store.has(key) ? store.get(key) : fallback
        ),
        setString: vi.fn(async (key, value) => {
            store.set(key, value);
        }),
        getArray: vi.fn(async (key, fallback = null) =>
            store.has(key) ? JSON.parse(store.get(key)) : fallback
        ),
        setArray: vi.fn(async (key, value) => {
            store.set(key, JSON.stringify(value));
        }),
        getObject: vi.fn(async (key, fallback = null) =>
            store.has(key) ? JSON.parse(store.get(key)) : fallback
        ),
        setObject: vi.fn(async (key, value) => {
            store.set(key, JSON.stringify(value));
        })
    }
}));

const {
    activatePlugin,
    deactivatePlugin,
    disablePlugin,
    enablePlugin,
    getPluginSettings,
    initPluginManager,
    isPluginActive,
    pluginState,
    resetPluginManager,
    shutdownPlugins,
    updatePluginSettings
} = await import('../manager');
const { clearRegistry, registerPlugin } = await import('../registry');

describe('plugin manager', () => {
    beforeEach(() => {
        store.clear();
        clearRegistry();
        resetPluginManager();
    });

    test('starts plugins marked enabled by default on first run', async () => {
        const setup = vi.fn();
        registerPlugin({
            id: 'auto',
            name: 'Auto',
            enabledByDefault: true,
            setup
        });
        registerPlugin({ id: 'manual', name: 'Manual', setup: vi.fn() });

        await initPluginManager();

        expect(setup).toHaveBeenCalledTimes(1);
        expect(isPluginActive('auto')).toBe(true);
        expect(isPluginActive('manual')).toBe(false);
    });

    test('restores the persisted enabled set on later runs', async () => {
        store.set('VRCX_enabledPlugins', JSON.stringify(['manual']));
        const autoSetup = vi.fn();
        const manualSetup = vi.fn();
        registerPlugin({
            id: 'auto',
            name: 'Auto',
            enabledByDefault: true,
            setup: autoSetup
        });
        registerPlugin({ id: 'manual', name: 'Manual', setup: manualSetup });

        await initPluginManager();

        expect(autoSetup).not.toHaveBeenCalled();
        expect(manualSetup).toHaveBeenCalledTimes(1);
    });

    test('teardown runs and context resources are released on disable', async () => {
        const disposer = vi.fn();
        const teardown = vi.fn();
        registerPlugin({
            id: 'a',
            name: 'A',
            setup: (ctx) => ctx.onDispose(disposer),
            teardown
        });
        await initPluginManager();

        await activatePlugin('a');
        expect(isPluginActive('a')).toBe(true);

        await deactivatePlugin('a');
        expect(teardown).toHaveBeenCalledTimes(1);
        expect(disposer).toHaveBeenCalledTimes(1);
        expect(isPluginActive('a')).toBe(false);
    });

    test('a plugin that throws during setup is marked errored, not active', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        registerPlugin({
            id: 'bad',
            name: 'Bad',
            setup: () => {
                throw new Error('kaboom');
            }
        });
        await initPluginManager();

        await activatePlugin('bad');

        expect(pluginState.bad.runState).toBe('error');
        expect(pluginState.bad.status).toBe('kaboom');
        vi.restoreAllMocks();
    });

    test('enabling a plugin starts its dependencies first', async () => {
        const order = [];
        registerPlugin({
            id: 'core',
            name: 'Core',
            setup: () => order.push('core')
        });
        registerPlugin({
            id: 'leaf',
            name: 'Leaf',
            requires: ['core'],
            setup: () => order.push('leaf')
        });
        await initPluginManager();

        await enablePlugin('leaf');

        expect(order).toEqual(['core', 'leaf']);
    });

    test('disabling a dependency also stops its dependents', async () => {
        registerPlugin({ id: 'core', name: 'Core', setup: vi.fn() });
        registerPlugin({
            id: 'leaf',
            name: 'Leaf',
            requires: ['core'],
            setup: vi.fn()
        });
        await initPluginManager();
        await enablePlugin('leaf');

        await disablePlugin('core');

        expect(isPluginActive('leaf')).toBe(false);
        expect(pluginState.leaf.enabled).toBe(false);
    });

    test('settings are normalised, persisted and restart the plugin', async () => {
        const setup = vi.fn();
        registerPlugin({
            id: 'a',
            name: 'A',
            settingsSchema: [
                { key: 'port', type: 'number', default: 9000, min: 1, max: 100 }
            ],
            setup
        });
        await initPluginManager();
        await activatePlugin('a');
        expect(setup).toHaveBeenCalledTimes(1);

        await updatePluginSettings('a', { port: 5000 });

        // Clamped to the declared max, then persisted.
        expect(getPluginSettings('a').port).toBe(100);
        expect(JSON.parse(store.get('VRCX_pluginSettings_a'))).toEqual({
            port: 100
        });
        // Restarted so setup observes the new value.
        expect(setup).toHaveBeenCalledTimes(2);
    });

    test('settings updates are visible through the context proxy', async () => {
        let seen = null;
        registerPlugin({
            id: 'a',
            name: 'A',
            settingsSchema: [{ key: 'label', type: 'string', default: 'one' }],
            setup: (ctx) => {
                seen = ctx.settings;
            }
        });
        await initPluginManager();
        await activatePlugin('a');
        expect(seen.label).toBe('one');

        await updatePluginSettings('a', { label: 'two' });

        expect(seen.label).toBe('two');
    });

    test('shutdown stops everything without clearing the enabled set', async () => {
        registerPlugin({ id: 'a', name: 'A', setup: vi.fn() });
        await initPluginManager();
        await enablePlugin('a');

        await shutdownPlugins();

        expect(isPluginActive('a')).toBe(false);
        expect(JSON.parse(store.get('VRCX_enabledPlugins'))).toContain('a');
    });

    test('rapid toggling settles on the final state', async () => {
        const setup = vi.fn();
        const teardown = vi.fn();
        registerPlugin({ id: 'a', name: 'A', setup, teardown });
        await initPluginManager();

        await Promise.all([
            activatePlugin('a'),
            deactivatePlugin('a'),
            activatePlugin('a')
        ]);

        expect(isPluginActive('a')).toBe(true);
        expect(setup.mock.calls.length).toBe(teardown.mock.calls.length + 1);
    });
});
