import { watch } from 'vue';
import * as workerTimers from 'worker-timers';

import { parseLocation } from '../shared/utils/locationParser';
import { watchState } from '../services/watchState';
import { pluginBus, PluginEvents } from './eventBus';

/**
 * Bridges VRCX's existing reactive state onto the plugin event bus.
 *
 * Everything here is read-only observation of stores that already exist, which
 * keeps the plugin system from having to touch core code paths.
 */

let started = false;
/** @type {Function[]} */
let stoppers = [];
/**
 * Held so `getInstanceSnapshot` can read live values without every caller
 * having to resolve the store graph.
 *
 * @type {object|null}
 */
let locationStoreRef = null;
let tickHandle = null;
let tickCount = 0;

/** @type {Map<string, string>} */
const friendStateCache = new Map();
/** @type {Map<string, string>} */
const friendLocationCache = new Map();

/**
 * @param {object} stores
 * @param {object} stores.gameLogStore
 * @param {object} stores.locationStore
 * @param {object} stores.friendStore
 * @param {object} stores.gameStore
 */
export function startPluginSources({
    gameLogStore,
    locationStore,
    friendStore,
    gameStore
}) {
    if (started) {
        return;
    }
    started = true;
    locationStoreRef = locationStore;

    stoppers.push(
        watch(
            () => gameLogStore.latestGameLogEntry,
            (entry) => {
                if (!entry) {
                    return;
                }
                pluginBus.emit(PluginEvents.GAME_LOG, { entry });

                switch (entry.type) {
                    case 'OnPlayerJoined':
                        pluginBus.emit(PluginEvents.PLAYER_JOIN, {
                            userId: entry.userId,
                            displayName: entry.displayName,
                            isFriend: Boolean(entry.isFriend),
                            isFavorite: Boolean(entry.isFavorite)
                        });
                        break;
                    case 'OnPlayerLeft':
                        pluginBus.emit(PluginEvents.PLAYER_LEAVE, {
                            userId: entry.userId,
                            displayName: entry.displayName,
                            isFriend: Boolean(entry.isFriend),
                            isFavorite: Boolean(entry.isFavorite),
                            timeMs: entry.time ?? 0
                        });
                        break;
                    case 'VideoPlay':
                        pluginBus.emit(PluginEvents.VIDEO_PLAY, {
                            videoName: entry.videoName ?? '',
                            videoUrl: entry.videoUrl ?? '',
                            videoLength: entry.videoLength ?? 0,
                            displayName: entry.displayName ?? ''
                        });
                        break;
                    case 'AvatarChange':
                        // Photon supplies the full avatar ref; the log-file
                        // parser only knows a name, so the id fields are
                        // frequently absent.
                        pluginBus.emit(PluginEvents.AVATAR_CHANGE, {
                            userId: entry.userId ?? '',
                            displayName: entry.displayName ?? '',
                            avatarName: entry.name ?? '',
                            avatarId: entry.avatarId ?? '',
                            authorId: entry.authorId ?? '',
                            releaseStatus: entry.releaseStatus ?? '',
                            createdAt: entry.created_at ?? ''
                        });
                        break;
                    default:
                        break;
                }
            }
        )
    );

    stoppers.push(
        watch(
            () => locationStore.lastLocation.location,
            (location, previousLocation) => {
                pluginBus.emit(PluginEvents.LOCATION_CHANGE, {
                    location,
                    previousLocation,
                    name: locationStore.lastLocation.name,
                    date: locationStore.lastLocation.date
                });
            }
        )
    );

    stoppers.push(
        watch(
            () => gameStore.isGameRunning,
            (isRunning) => {
                pluginBus.emit(PluginEvents.GAME_STATE, { isRunning });
            }
        )
    );

    stoppers.push(
        watch(
            () => watchState.isLoggedIn,
            (isLoggedIn) => {
                if (!isLoggedIn) {
                    friendStateCache.clear();
                    friendLocationCache.clear();
                }
                pluginBus.emit(PluginEvents.AUTH_STATE, { isLoggedIn });
            }
        )
    );

    // Friend presence is diffed on a timer rather than deep-watched: the friend
    // map is large and mutated in place, so a deep watcher would be far more
    // expensive than a once-per-second pass over the existing entries.
    tickHandle = workerTimers.setInterval(() => {
        tickCount += 1;
        try {
            diffFriendPresence(friendStore);
        } catch (err) {
            console.error('[plugins] friend presence diff failed', err);
        }
        pluginBus.emit(PluginEvents.TICK, { tick: tickCount });
    }, 1000);
}

/**
 * The shape `getInstanceSnapshot` returns when nothing is known yet. Shared so
 * callers always see the same fields whether or not the user is in a world.
 *
 * @returns {{inInstance: boolean, worldName: string, worldId: string, instanceId: string, instanceName: string, accessType: string, accessTypeName: string, region: string, ownerId: string, groupId: string, isGroup: boolean, ageGate: boolean, playerCount: number, friendCount: number, minutesHere: number, players: string[], location: string}}
 */
export function emptyInstanceSnapshot() {
    return {
        inInstance: false,
        worldName: '',
        worldId: '',
        instanceId: '',
        instanceName: '',
        accessType: '',
        accessTypeName: '',
        region: '',
        ownerId: '',
        groupId: '',
        isGroup: false,
        ageGate: false,
        playerCount: 0,
        friendCount: 0,
        minutesHere: 0,
        players: [],
        location: ''
    };
}

/**
 * Fields a plugin can read about the instance the local user is in.
 *
 * Built on demand from the live store rather than cached, so a plugin never
 * reads a stale head count. Everything is a plain value, so an imported plugin
 * cannot reach back into the store graph through it.
 *
 * @returns {ReturnType<typeof emptyInstanceSnapshot>}
 */
export function getInstanceSnapshot() {
    const empty = emptyInstanceSnapshot();
    const last = locationStoreRef?.lastLocation;
    if (!last?.location) {
        return empty;
    }

    let parsed;
    try {
        parsed = parseLocation(last.location);
    } catch {
        return { ...empty, location: last.location };
    }

    const players = last.playerList ? Array.from(last.playerList.values()) : [];

    return {
        inInstance: true,
        worldName: last.name ?? '',
        worldId: parsed.worldId ?? '',
        instanceId: parsed.instanceId ?? '',
        instanceName: parsed.instanceName ?? '',
        accessType: parsed.accessType ?? '',
        accessTypeName: parsed.accessTypeName ?? '',
        region: parsed.region ?? '',
        // For anything other than a public instance this is whoever opened it.
        ownerId: parsed.userId ?? parsed.groupId ?? '',
        groupId: parsed.groupId ?? '',
        isGroup: Boolean(parsed.groupId),
        ageGate: Boolean(parsed.ageGate),
        playerCount: last.playerList?.size ?? 0,
        friendCount: last.friendList?.size ?? 0,
        minutesHere: last.date
            ? Math.max(0, Math.floor((Date.now() - last.date) / 60000))
            : 0,
        players: players
            .map((entry) =>
                typeof entry === 'string' ? entry : (entry?.displayName ?? '')
            )
            .filter(Boolean),
        location: last.location
    };
}

/**
 * @param {object} friendStore
 */
function diffFriendPresence(friendStore) {
    if (!watchState.isLoggedIn || !watchState.isFriendsLoaded) {
        return;
    }
    const friends = friendStore.friends;
    if (!friends?.size) {
        return;
    }
    const seen = new Set();
    for (const [userId, friend] of friends) {
        seen.add(userId);
        const state = friend?.state ?? 'offline';
        const previousState = friendStateCache.get(userId);
        friendStateCache.set(userId, state);

        const displayName = friend?.name ?? friend?.ref?.displayName ?? '';
        const location = friend?.ref?.location ?? '';
        const previousLocation = friendLocationCache.get(userId);
        friendLocationCache.set(userId, location);

        if (previousState === undefined) {
            // First pass after login: seed the cache without firing events so
            // plugins do not get a burst of "friend online" for everyone.
            continue;
        }
        if (previousState !== state) {
            if (state === 'offline') {
                pluginBus.emit(PluginEvents.FRIEND_OFFLINE, {
                    userId,
                    displayName
                });
            } else if (previousState === 'offline') {
                pluginBus.emit(PluginEvents.FRIEND_ONLINE, {
                    userId,
                    displayName,
                    location
                });
            }
        }
        if (
            state === 'online' &&
            previousLocation !== undefined &&
            previousLocation !== location &&
            location
        ) {
            pluginBus.emit(PluginEvents.FRIEND_LOCATION, {
                userId,
                displayName,
                location,
                previousLocation
            });
        }
    }
    for (const userId of Array.from(friendStateCache.keys())) {
        if (!seen.has(userId)) {
            friendStateCache.delete(userId);
            friendLocationCache.delete(userId);
        }
    }
}

export function stopPluginSources() {
    if (!started) {
        return;
    }
    started = false;
    locationStoreRef = null;
    if (tickHandle !== null) {
        try {
            workerTimers.clearInterval(tickHandle);
        } catch {
            /* already cleared */
        }
        tickHandle = null;
    }
    for (const stop of stoppers) {
        try {
            stop();
        } catch (err) {
            console.error('[plugins] failed to stop source watcher', err);
        }
    }
    stoppers = [];
    friendStateCache.clear();
    friendLocationCache.clear();
}
