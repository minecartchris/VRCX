import { watch } from 'vue';
import * as workerTimers from 'worker-timers';

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
