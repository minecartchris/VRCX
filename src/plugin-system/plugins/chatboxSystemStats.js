import { registerChatboxSource } from '../chatbox';

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatGigabytes(bytes) {
    return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

/**
 * CPU and memory readout, sampled on its own timer so the chatbox render stays
 * synchronous.
 *
 * @type {import('../registry').PluginManifest}
 */
export const chatboxSystemStatsPlugin = {
    id: 'chatbox-system-stats',
    name: 'Chatbox: System stats',
    nameKey: 'view.plugins.items.chatbox_system_stats.name',
    descriptionKey: 'view.plugins.items.chatbox_system_stats.description',
    description: 'Adds CPU and memory usage of this PC to the chatbox.',
    icon: 'ri-cpu-line',
    category: 'chatbox',
    requires: ['osc-chatbox'],
    tags: ['chatbox', 'system'],
    settingsSchema: [
        { key: 'showCpu', type: 'boolean', label: 'Show CPU', default: true },
        {
            key: 'showMemory',
            type: 'boolean',
            label: 'Show memory',
            default: true
        },
        {
            key: 'memoryStyle',
            type: 'select',
            label: 'Memory style',
            default: 'percent',
            options: [
                { value: 'percent', label: 'Percentage' },
                { value: 'absolute', label: 'Used / total' }
            ]
        },
        {
            key: 'sampleIntervalSeconds',
            type: 'number',
            label: 'Sample interval (seconds)',
            default: 5,
            min: 2,
            max: 120
        },
        {
            key: 'order',
            type: 'number',
            label: 'Position',
            default: 40,
            min: 0,
            max: 999
        }
    ],

    async setup(ctx) {
        if (typeof AppApi?.GetSystemStats !== 'function') {
            ctx.setStatus(
                'System stats are not available in this build of VRCX.',
                'error'
            );
            return;
        }
        const settings = ctx.settings;
        let stats = null;

        async function sample() {
            try {
                const raw = await AppApi.GetSystemStats();
                stats = raw ? JSON.parse(raw) : null;
            } catch (err) {
                ctx.error('failed to sample system stats', err);
                stats = null;
            }
        }

        await sample();
        ctx.interval(() => {
            sample().catch((err) => ctx.error('sample failed', err));
        }, settings.sampleIntervalSeconds * 1000);

        const unregister = registerChatboxSource({
            id: ctx.id,
            label: 'System stats',
            order: settings.order,
            render() {
                if (!stats) {
                    return null;
                }
                const parts = [];
                if (settings.showCpu) {
                    parts.push(`CPU ${Math.round(stats.cpuPercent ?? 0)}%`);
                }
                if (settings.showMemory && stats.memoryTotalBytes > 0) {
                    if (settings.memoryStyle === 'absolute') {
                        parts.push(
                            `RAM ${formatGigabytes(stats.memoryUsedBytes)}/${formatGigabytes(stats.memoryTotalBytes)}`
                        );
                    } else {
                        parts.push(
                            `RAM ${Math.round(stats.memoryPercent ?? 0)}%`
                        );
                    }
                }
                return parts.length > 0 ? `🖥 ${parts.join(' ')}` : null;
            }
        });
        ctx.onDispose(unregister);
    }
};
