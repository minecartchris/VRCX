import { registerChatboxSource } from '../chatbox';

const PULSOID_URL = 'wss://dev.pulsoid.net/api/v1/data/real_time?access_token=';
const HYPERATE_URL = 'wss://app.hyperate.io/socket/websocket?token=';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
/** HypeRate's Phoenix channel drops the socket without a periodic heartbeat. */
const HYPERATE_HEARTBEAT_MS = 25000;

/**
 * Walks a dotted path such as `data.heartRate` on a decoded payload.
 *
 * @param {*} payload
 * @param {string} path
 * @returns {*}
 */
export function readPath(payload, path) {
    if (!path) {
        return payload;
    }
    return path
        .split('.')
        .reduce(
            (value, key) =>
                value === null || value === undefined ? undefined : value[key],
            payload
        );
}

/**
 * Live heart rate in the chatbox, from Pulsoid, HypeRate, or any websocket that
 * emits JSON.
 *
 * @type {import('../registry').PluginManifest}
 */
export const chatboxHeartRatePlugin = {
    id: 'chatbox-heart-rate',
    name: 'Chatbox: Heart rate',
    nameKey: 'view.plugins.items.chatbox_heart_rate.name',
    descriptionKey: 'view.plugins.items.chatbox_heart_rate.description',
    description:
        'Streams your heart rate from Pulsoid or HypeRate into the chatbox.',
    icon: 'ri-heart-pulse-line',
    category: 'chatbox',
    requires: ['osc-chatbox'],
    tags: ['chatbox', 'wearable'],
    settingsSchema: [
        {
            key: 'provider',
            type: 'select',
            label: 'Provider',
            default: 'pulsoid',
            options: [
                { value: 'pulsoid', label: 'Pulsoid' },
                { value: 'hyperate', label: 'HypeRate' },
                { value: 'custom', label: 'Custom websocket' }
            ]
        },
        {
            key: 'token',
            type: 'password',
            label: 'Access token',
            description:
                'Pulsoid: a widget access token. HypeRate: your API key.',
            default: ''
        },
        {
            key: 'hyperateId',
            type: 'string',
            label: 'HypeRate device ID',
            default: '',
            visibleWhen: (settings) => settings.provider === 'hyperate'
        },
        {
            key: 'customUrl',
            type: 'string',
            label: 'Websocket URL',
            default: '',
            visibleWhen: (settings) => settings.provider === 'custom'
        },
        {
            key: 'customPath',
            type: 'string',
            label: 'JSON path to BPM',
            description: 'Dotted path, e.g. "data.heartRate".',
            default: 'data.heartRate',
            visibleWhen: (settings) => settings.provider === 'custom'
        },
        {
            key: 'prefix',
            type: 'string',
            label: 'Prefix',
            default: '❤️ '
        },
        {
            key: 'suffix',
            type: 'string',
            label: 'Suffix',
            default: ' BPM'
        },
        {
            key: 'staleAfterSeconds',
            type: 'number',
            label: 'Hide after no data for (seconds)',
            default: 30,
            min: 5,
            max: 600
        },
        {
            key: 'order',
            type: 'number',
            label: 'Position',
            default: 50,
            min: 0,
            max: 999
        }
    ],

    setup(ctx) {
        const settings = ctx.settings;
        let bpm = 0;
        let lastUpdate = 0;
        let socket = null;
        let reconnectAttempts = 0;
        let closed = false;
        let heartbeatHandle = null;

        /**
         * @returns {string | null}
         */
        function resolveUrl() {
            if (settings.provider === 'pulsoid') {
                return settings.token
                    ? `${PULSOID_URL}${encodeURIComponent(settings.token)}`
                    : null;
            }
            if (settings.provider === 'hyperate') {
                return settings.token
                    ? `${HYPERATE_URL}${encodeURIComponent(settings.token)}`
                    : null;
            }
            return settings.customUrl || null;
        }

        /**
         * @param {*} payload
         */
        function handlePayload(payload) {
            let value;
            if (settings.provider === 'pulsoid') {
                value = readPath(payload, 'data.heartRate');
            } else if (settings.provider === 'hyperate') {
                if (payload?.event !== 'hr_update') {
                    return;
                }
                value = readPath(payload, 'payload.hr');
            } else {
                value = readPath(payload, settings.customPath);
            }
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                return;
            }
            bpm = Math.round(parsed);
            lastUpdate = Date.now();
            ctx.setStatus(`${bpm} BPM`, 'ok');
        }

        function scheduleReconnect() {
            if (closed) {
                return;
            }
            reconnectAttempts += 1;
            const delay = Math.min(
                RECONNECT_MAX_MS,
                RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1)
            );
            ctx.setStatus(
                `Disconnected, retrying in ${Math.round(delay / 1000)}s`,
                'warning'
            );
            ctx.timeout(connect, delay);
        }

        function stopHeartbeat() {
            if (heartbeatHandle !== null) {
                clearInterval(heartbeatHandle);
                heartbeatHandle = null;
            }
        }

        function connect() {
            if (closed) {
                return;
            }
            const url = resolveUrl();
            if (!url) {
                ctx.setStatus('Missing access token or URL.', 'warning');
                return;
            }
            try {
                socket = new WebSocket(url);
            } catch (err) {
                ctx.error('failed to open heart rate socket', err);
                scheduleReconnect();
                return;
            }

            socket.onopen = () => {
                reconnectAttempts = 0;
                ctx.setStatus('Connected, waiting for data…', 'ok');
                if (settings.provider === 'hyperate' && settings.hyperateId) {
                    socket?.send(
                        JSON.stringify({
                            topic: `hr:${settings.hyperateId}`,
                            event: 'phx_join',
                            payload: {},
                            ref: 0
                        })
                    );
                    stopHeartbeat();
                    heartbeatHandle = setInterval(() => {
                        socket?.send(
                            JSON.stringify({
                                topic: 'phoenix',
                                event: 'heartbeat',
                                payload: {},
                                ref: 0
                            })
                        );
                    }, HYPERATE_HEARTBEAT_MS);
                }
            };
            socket.onmessage = (event) => {
                try {
                    handlePayload(JSON.parse(event.data));
                } catch {
                    // Non-JSON frame (keepalive); nothing to do.
                }
            };
            socket.onerror = () => {
                ctx.setStatus('Heart rate connection error.', 'warning');
            };
            socket.onclose = () => {
                stopHeartbeat();
                socket = null;
                scheduleReconnect();
            };
        }

        connect();

        ctx.onDispose(() => {
            closed = true;
            stopHeartbeat();
            const current = socket;
            socket = null;
            if (current) {
                current.onclose = null;
                current.close();
            }
        });

        const unregister = registerChatboxSource({
            id: ctx.id,
            label: 'Heart rate',
            order: settings.order,
            render() {
                if (
                    bpm <= 0 ||
                    Date.now() - lastUpdate > settings.staleAfterSeconds * 1000
                ) {
                    return null;
                }
                return `${settings.prefix}${bpm}${settings.suffix}`;
            }
        });
        ctx.onDispose(unregister);
    }
};
