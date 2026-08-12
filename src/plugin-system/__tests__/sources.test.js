import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick, reactive } from 'vue';

vi.mock('worker-timers', () => ({
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn()
}));

const { pluginBus, PluginEvents } = await import('../eventBus');
const {
    emptyInstanceSnapshot,
    getInstanceSnapshot,
    startPluginSources,
    stopPluginSources
} = await import('../sources');

/**
 * Minimal stand-ins for the stores `startPluginSources` observes.
 */
function makeStores() {
    return {
        gameLogStore: reactive({ latestGameLogEntry: null }),
        locationStore: reactive({ lastLocation: { location: '', name: '' } }),
        friendStore: reactive({ friends: new Map() }),
        gameStore: reactive({ isGameRunning: false })
    };
}

describe('plugin sources', () => {
    /** @type {ReturnType<typeof makeStores>} */
    let stores;

    beforeEach(() => {
        stores = makeStores();
        startPluginSources(stores);
    });

    afterEach(() => {
        stopPluginSources();
        pluginBus.clear();
    });

    test('maps a photon avatar change onto the bus', async () => {
        const handler = vi.fn();
        pluginBus.on(PluginEvents.AVATAR_CHANGE, handler);

        stores.gameLogStore.latestGameLogEntry = {
            type: 'AvatarChange',
            userId: 'usr_1',
            displayName: 'Alice',
            name: 'CoolAvatar',
            avatarId: 'avtr_1',
            authorId: 'usr_2',
            releaseStatus: 'public',
            created_at: '2024-01-05T10:00:00.000Z'
        };
        await nextTick();

        expect(handler).toHaveBeenCalledWith({
            userId: 'usr_1',
            displayName: 'Alice',
            avatarName: 'CoolAvatar',
            avatarId: 'avtr_1',
            authorId: 'usr_2',
            releaseStatus: 'public',
            createdAt: '2024-01-05T10:00:00.000Z'
        });
    });

    test('maps a log-file avatar change, which carries no avatar id', async () => {
        const handler = vi.fn();
        pluginBus.on(PluginEvents.AVATAR_CHANGE, handler);

        stores.gameLogStore.latestGameLogEntry = {
            type: 'AvatarChange',
            userId: 'usr_1',
            displayName: 'Alice',
            name: 'CoolAvatar',
            created_at: '2024-01-05T10:00:00.000Z'
        };
        await nextTick();

        expect(handler).toHaveBeenCalledWith(
            expect.objectContaining({
                displayName: 'Alice',
                avatarName: 'CoolAvatar',
                avatarId: '',
                authorId: ''
            })
        );
    });

    test('does not emit an avatar change for other log entry types', async () => {
        const handler = vi.fn();
        pluginBus.on(PluginEvents.AVATAR_CHANGE, handler);

        stores.gameLogStore.latestGameLogEntry = {
            type: 'OnPlayerJoined',
            userId: 'usr_1',
            displayName: 'Alice'
        };
        await nextTick();

        expect(handler).not.toHaveBeenCalled();
    });

    test('the instance snapshot reflects the live location store', () => {
        stores.locationStore.lastLocation = {
            location: 'wrld_abc:12345~friends(usr_owner)~region(use)',
            name: 'The Great Pug',
            date: Date.now() - 5 * 60000,
            playerList: new Map([
                ['usr_1', { displayName: 'Alice' }],
                ['usr_2', { displayName: 'Bob' }]
            ]),
            friendList: new Map([['usr_1', {}]])
        };

        const snapshot = getInstanceSnapshot();
        expect(snapshot.inInstance).toBe(true);
        expect(snapshot.worldName).toBe('The Great Pug');
        expect(snapshot.worldId).toBe('wrld_abc');
        expect(snapshot.ownerId).toBe('usr_owner');
        expect(snapshot.region).toBe('use');
        expect(snapshot.playerCount).toBe(2);
        expect(snapshot.friendCount).toBe(1);
        expect(snapshot.players).toEqual(['Alice', 'Bob']);
        expect(snapshot.minutesHere).toBe(5);
    });

    test('the snapshot is empty when not in a world', () => {
        stores.locationStore.lastLocation = { location: '', name: '' };
        expect(getInstanceSnapshot()).toEqual(emptyInstanceSnapshot());
    });

    test('the snapshot has the same shape in both states', () => {
        stores.locationStore.lastLocation = {
            location: 'wrld_abc:1~region(eu)',
            name: 'W',
            playerList: new Map()
        };
        expect(Object.keys(getInstanceSnapshot()).sort()).toEqual(
            Object.keys(emptyInstanceSnapshot()).sort()
        );
    });

    test('every game log entry still reaches the generic gameLog event', async () => {
        const handler = vi.fn();
        pluginBus.on(PluginEvents.GAME_LOG, handler);

        const entry = { type: 'AvatarChange', displayName: 'Alice' };
        stores.gameLogStore.latestGameLogEntry = entry;
        await nextTick();

        expect(handler).toHaveBeenCalledWith({ entry });
    });
});
