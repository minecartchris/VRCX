import webApiService from '../../services/webapi';
import { registerChatboxSource } from '../chatbox';

const PING_URL = 'https://api.vrchat.cloud/api/1/time';

/**
 * Round-trip latency to the VRChat API.
 *
 * @type {import('../registry').PluginManifest}
 */
export const chatboxNetworkStatsPlugin = {
    id: 'chatbox-network-stats',
    name: 'Chatbox: Network',
    nameKey: 'view.plugins.items.chatbox_network_stats.name',
    descriptionKey: 'view.plugins.items.chatbox_network_stats.description',
    description: 'Shows round-trip latency to the VRChat API in the chatbox.',
    icon: 'ri-signal-wifi-line',
    category: 'chatbox',
    requires: ['osc-chatbox'],
    tags: ['chatbox', 'network'],
    settingsSchema: [
        {
            key: 'prefix',
            type: 'string',
            label: 'Prefix',
            default: '📶 '
        },
        {
            key: 'sampleIntervalSeconds',
            type: 'number',
            label: 'Sample interval (seconds)',
            description: 'Keep this high; every sample is a request to VRChat.',
            default: 60,
            min: 15,
            max: 900
        },
        {
            key: 'order',
            type: 'number',
            label: 'Position',
            default: 90,
            min: 0,
            max: 999
        }
    ],

    async setup(ctx) {
        const settings = ctx.settings;
        let latencyMs = 0;

        async function sample() {
            const startedAt = Date.now();
            try {
                const response = await webApiService.execute({
                    url: PING_URL,
                    method: 'GET',
                    headers: { Referer: 'https://vrcx.app' }
                });
                if (response.status < 200 || response.status >= 400) {
                    throw new Error(`status ${response.status}`);
                }
                latencyMs = Date.now() - startedAt;
                ctx.setStatus(`${latencyMs} ms`, 'ok');
            } catch (err) {
                latencyMs = 0;
                ctx.setStatus(
                    `Ping failed: ${err instanceof Error ? err.message : err}`,
                    'warning'
                );
            }
        }

        await sample();
        ctx.interval(() => {
            sample().catch((err) => ctx.error('ping failed', err));
        }, settings.sampleIntervalSeconds * 1000);

        const unregister = registerChatboxSource({
            id: ctx.id,
            label: 'Network',
            order: settings.order,
            render() {
                return latencyMs > 0
                    ? `${settings.prefix}${latencyMs}ms`
                    : null;
            }
        });
        ctx.onDispose(unregister);
    }
};
