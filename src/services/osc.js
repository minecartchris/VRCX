import * as workerTimers from 'worker-timers';

/**
 * Thin front-end wrapper around the native OSC transport exposed by AppApi.
 *
 * The transport is shared by every plugin, so it is reference counted: it opens
 * on the first acquire and closes when the last holder releases it.
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SEND_PORT = 9000;
const DEFAULT_RECEIVE_PORT = 9001;
const POLL_INTERVAL_MS = 250;

/** VRChat truncates chatbox messages past this length. */
export const CHATBOX_MAX_LENGTH = 144;

class OscService {
    constructor() {
        /** @type {Set<string>} */
        this._holders = new Set();
        this._running = false;
        this._pollHandle = null;
        /** @type {Set<(message: {address: string, args: any[]}) => void>} */
        this._listeners = new Set();
        this._config = {
            host: DEFAULT_HOST,
            sendPort: DEFAULT_SEND_PORT,
            receivePort: DEFAULT_RECEIVE_PORT
        };
        /**
         * Serialises acquire/release. Several plugins can start at once, and
         * two concurrent OscStart calls would fight over the same socket.
         *
         * @type {Promise<any>}
         */
        this._queue = Promise.resolve();
    }

    /**
     * @template T
     * @param {() => Promise<T>} run
     * @returns {Promise<T>}
     */
    _enqueue(run) {
        const next = this._queue.then(run, run);
        this._queue = next.catch(() => {});
        return next;
    }

    /**
     * @returns {boolean} true when the native OSC methods exist in this build
     */
    get isSupported() {
        return typeof AppApi?.OscStart === 'function';
    }

    get isRunning() {
        return this._running;
    }

    get config() {
        return { ...this._config };
    }

    /**
     * Opens (or re-opens) the transport on behalf of `holderId`.
     *
     * @param {string} holderId
     * @param {{host?: string, sendPort?: number, receivePort?: number}} [config]
     * @returns {Promise<boolean>}
     */
    acquire(holderId, config = {}) {
        if (!this.isSupported) {
            return Promise.resolve(false);
        }
        return this._enqueue(async () => {
            const next = {
                host: config.host || this._config.host,
                sendPort: Number(config.sendPort) || this._config.sendPort,
                receivePort: Number.isFinite(Number(config.receivePort))
                    ? Number(config.receivePort)
                    : this._config.receivePort
            };
            const configChanged =
                next.host !== this._config.host ||
                next.sendPort !== this._config.sendPort ||
                next.receivePort !== this._config.receivePort;

            this._holders.add(holderId);
            if (this._running && !configChanged) {
                return true;
            }
            this._config = next;

            const started = await AppApi.OscStart(
                next.host,
                next.sendPort,
                next.receivePort
            );
            this._running = Boolean(started);
            if (this._running) {
                this._startPolling();
            }
            return this._running;
        });
    }

    /**
     * @param {string} holderId
     * @returns {Promise<void>}
     */
    release(holderId) {
        return this._enqueue(async () => {
            this._holders.delete(holderId);
            if (this._holders.size > 0 || !this._running) {
                return;
            }
            this._stopPolling();
            this._running = false;
            if (this.isSupported) {
                await AppApi.OscStop();
            }
        });
    }

    /**
     * Subscribes to inbound OSC messages.
     *
     * @param {(message: {address: string, args: any[]}) => void} listener
     * @returns {() => void} unsubscribe
     */
    onMessage(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /**
     * @param {string} text
     * @param {{send?: boolean, sound?: boolean}} [options]
     * @returns {Promise<boolean>}
     */
    async sendChatbox(text, { send = true, sound = false } = {}) {
        if (!this._running) {
            return false;
        }
        const truncated = String(text ?? '').slice(0, CHATBOX_MAX_LENGTH);
        return Boolean(await AppApi.OscSendChatbox(truncated, send, sound));
    }

    /**
     * @param {boolean} typing
     * @returns {Promise<boolean>}
     */
    async sendTyping(typing) {
        if (!this._running) {
            return false;
        }
        return Boolean(await AppApi.OscSendTyping(Boolean(typing)));
    }

    /**
     * Sends an avatar parameter, picking the OSC type from the JS value.
     *
     * @param {string} name parameter name or full address
     * @param {number|boolean} value
     * @returns {Promise<boolean>}
     */
    async sendParameter(name, value) {
        if (!this._running) {
            return false;
        }
        const address = name.startsWith('/')
            ? name
            : `/avatar/parameters/${name}`;
        if (typeof value === 'boolean') {
            return Boolean(await AppApi.OscSendBool(address, value));
        }
        if (Number.isInteger(value)) {
            return Boolean(await AppApi.OscSendInt(address, value));
        }
        return Boolean(await AppApi.OscSendFloat(address, Number(value) || 0));
    }

    _startPolling() {
        if (this._pollHandle !== null || this._config.receivePort <= 0) {
            return;
        }
        this._pollHandle = workerTimers.setInterval(() => {
            this._poll().catch((err) => {
                console.error('[osc] poll failed', err);
            });
        }, POLL_INTERVAL_MS);
    }

    _stopPolling() {
        if (this._pollHandle === null) {
            return;
        }
        try {
            workerTimers.clearInterval(this._pollHandle);
        } catch {
            /* already cleared */
        }
        this._pollHandle = null;
    }

    async _poll() {
        if (!this._running || this._listeners.size === 0) {
            return;
        }
        const raw = await AppApi.OscPollMessages();
        if (!raw) {
            return;
        }
        let messages;
        try {
            messages = JSON.parse(raw);
        } catch (err) {
            console.error('[osc] failed to parse incoming messages', err);
            return;
        }
        if (!Array.isArray(messages)) {
            return;
        }
        for (const message of messages) {
            for (const listener of Array.from(this._listeners)) {
                try {
                    listener(message);
                } catch (err) {
                    console.error('[osc] listener threw', err);
                }
            }
        }
    }
}

export const oscService = new OscService();
