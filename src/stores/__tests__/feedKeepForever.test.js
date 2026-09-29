import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';

const mocks = vi.hoisted(() => ({
    config: new Map(),
    purgeAvatarFeedData: vi.fn(),
    setBool: vi.fn()
}));

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));
vi.mock('../../services/appConfig', () => ({ logWebRequest: vi.fn() }));
vi.mock('../../services/database', () => ({
    database: { purgeAvatarFeedData: (...args) => mocks.purgeAvatarFeedData(...args) }
}));
vi.mock('../../localization', () => ({ languageCodes: ['en'] }));
vi.mock('../game', () => ({ useGameStore: () => ({}) }));
vi.mock('../modal', () => ({ useModalStore: () => ({}) }));
vi.mock('../updateLoop', () => ({ useUpdateLoopStore: () => ({}) }));
vi.mock('../vrcxUpdater', () => ({ useVRCXUpdaterStore: () => ({ branch: 'Stable' }) }));
vi.mock('../vrcx', () => ({ useVrcxStore: () => ({}) }));
vi.mock('../../services/watchState', () => ({ watchState: reactive({ isLoggedIn: false }) }));
vi.mock('../../services/webapi', () => ({ default: {} }));
vi.mock('../../services/config', () => {
    const read = async (key, fallback) => (mocks.config.has(key) ? mocks.config.get(key) : fallback);
    return {
        default: {
            getBool: read,
            getString: read,
            getInt: read,
            getFloat: read,
            setBool: (...args) => mocks.setBool(...args),
            setString: vi.fn(async () => {}),
            setInt: vi.fn(async () => {})
        }
    };
});

import { useAdvancedSettingsStore } from '../settings/advanced';

describe('keep feed history forever', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        globalThis.AppApi = { SetAppLauncherSettings: vi.fn() };
        setActivePinia(createPinia());
        mocks.config.clear();
        mocks.purgeAvatarFeedData.mockReset();
        mocks.setBool.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.AppApi;
    });

    test('is on unless the user turned it off', async () => {
        const store = useAdvancedSettingsStore();
        await vi.runAllTimersAsync();

        expect(store.feedKeepForever).toBe(true);
    });

    test('stops the avatar auto-cleanup from deleting anything', async () => {
        mocks.config.set('VRCX_avatarAutoCleanup', '30');
        const store = useAdvancedSettingsStore();

        await store.runAvatarAutoCleanup('usr_me');

        expect(mocks.purgeAvatarFeedData).not.toHaveBeenCalled();
    });

    test('lets the avatar auto-cleanup run once it is turned off', async () => {
        mocks.config.set('VRCX_avatarAutoCleanup', '30');
        mocks.config.set('VRCX_feedKeepForever', false);
        const store = useAdvancedSettingsStore();

        await store.runAvatarAutoCleanup('usr_me');

        expect(mocks.purgeAvatarFeedData).toHaveBeenCalledTimes(1);
    });

    test('saves the choice', async () => {
        const store = useAdvancedSettingsStore();
        await vi.runAllTimersAsync();

        await store.setFeedKeepForever(false);

        expect(store.feedKeepForever).toBe(false);
        expect(mocks.setBool).toHaveBeenCalledWith('VRCX_feedKeepForever', false);
    });
});
