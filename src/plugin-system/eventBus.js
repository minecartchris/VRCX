/**
 * Lightweight synchronous event bus used to feed VRCX runtime events into
 * plugins. Handlers are isolated: a throwing handler never prevents the
 * remaining handlers from running.
 */

/**
 * Canonical event names emitted by the plugin runtime.
 *
 * @readonly
 */
export const PluginEvents = Object.freeze({
    /** Fired once per second while the runtime is active. `{ tick: number }` */
    TICK: 'tick',
    /** A new game log entry was produced. `{ entry }` */
    GAME_LOG: 'gameLog',
    /** The local user changed instance. `{ location, previousLocation, name }` */
    LOCATION_CHANGE: 'locationChange',
    /** A player joined the current instance. `{ userId, displayName, isFriend }` */
    PLAYER_JOIN: 'playerJoin',
    /** A player left the current instance. `{ userId, displayName, isFriend }` */
    PLAYER_LEAVE: 'playerLeave',
    /** A video/media URL started playing in the current instance. `{ videoName, videoUrl, displayName }` */
    VIDEO_PLAY: 'videoPlay',
    /** Someone in the current instance switched avatar. `{ userId, displayName, avatarName, avatarId }` */
    AVATAR_CHANGE: 'avatarChange',
    /** A friend came online. `{ userId, displayName, location }` */
    FRIEND_ONLINE: 'friendOnline',
    /** A friend went offline. `{ userId, displayName }` */
    FRIEND_OFFLINE: 'friendOffline',
    /** A friend moved to a different instance. `{ userId, displayName, location }` */
    FRIEND_LOCATION: 'friendLocation',
    /** VRChat game process started or stopped. `{ isRunning }` */
    GAME_STATE: 'gameState',
    /** An OSC message was received from VRChat. `{ address, args }` */
    OSC_MESSAGE: 'oscMessage',
    /** The user logged in or out of VRChat. `{ isLoggedIn }` */
    AUTH_STATE: 'authState'
});

export class EventBus {
    constructor() {
        /** @type {Map<string, Set<Function>>} */
        this._handlers = new Map();
    }

    /**
     * Subscribes to an event.
     *
     * @param {string} event
     * @param {Function} handler
     * @returns {() => void} unsubscribe function
     */
    on(event, handler) {
        if (typeof handler !== 'function') {
            throw new TypeError('handler must be a function');
        }
        let set = this._handlers.get(event);
        if (!set) {
            set = new Set();
            this._handlers.set(event, set);
        }
        set.add(handler);
        return () => this.off(event, handler);
    }

    /**
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
        const set = this._handlers.get(event);
        if (!set) {
            return;
        }
        set.delete(handler);
        if (set.size === 0) {
            this._handlers.delete(event);
        }
    }

    /**
     * @param {string} event
     * @param {*} [payload]
     */
    emit(event, payload) {
        const set = this._handlers.get(event);
        if (!set || set.size === 0) {
            return;
        }
        for (const handler of Array.from(set)) {
            try {
                handler(payload);
            } catch (err) {
                console.error(`[plugins] handler for "${event}" threw`, err);
            }
        }
    }

    /**
     * @param {string} event
     * @returns {number}
     */
    listenerCount(event) {
        return this._handlers.get(event)?.size ?? 0;
    }

    clear() {
        this._handlers.clear();
    }
}

export const pluginBus = new EventBus();
