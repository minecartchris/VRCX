import { registerChatboxSource } from '../chatbox';
import { parseLocation } from '../../shared/utils/locationParser';
import { resolveStores } from '../stores';

/**
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return '0m';
    }
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0
        ? `${hours}h${String(minutes).padStart(2, '0')}m`
        : `${minutes}m`;
}

/**
 * World name, instance type, head count and time in instance.
 *
 * @type {import('../registry').PluginManifest}
 */
export const chatboxInstanceStatsPlugin = {
    id: 'chatbox-instance-stats',
    name: 'Chatbox: Instance stats',
    nameKey: 'view.plugins.items.chatbox_instance_stats.name',
    descriptionKey: 'view.plugins.items.chatbox_instance_stats.description',
    description:
        'Adds the current world, instance type, player count and time in instance.',
    icon: 'ri-earth-line',
    category: 'chatbox',
    requires: ['osc-chatbox'],
    tags: ['chatbox', 'instance'],
    settingsSchema: [
        {
            key: 'showWorldName',
            type: 'boolean',
            label: 'Show world name',
            default: true
        },
        {
            key: 'showInstanceType',
            type: 'boolean',
            label: 'Show instance type',
            default: false
        },
        {
            key: 'showPlayerCount',
            type: 'boolean',
            label: 'Show player count',
            default: true
        },
        {
            key: 'showFriendCount',
            type: 'boolean',
            label: 'Show friends in instance',
            default: false
        },
        {
            key: 'showTimeInInstance',
            type: 'boolean',
            label: 'Show time in instance',
            default: false
        },
        {
            key: 'maxWorldNameLength',
            type: 'number',
            label: 'Trim world name to',
            default: 24,
            min: 4,
            max: 144
        },
        {
            key: 'order',
            type: 'number',
            label: 'Position',
            default: 30,
            min: 0,
            max: 999
        }
    ],

    async setup(ctx) {
        const settings = ctx.settings;
        const { location: locationStore } = await resolveStores(['location']);

        const unregister = registerChatboxSource({
            id: ctx.id,
            label: 'Instance stats',
            order: settings.order,
            render() {
                const lastLocation = locationStore.lastLocation;
                if (!lastLocation?.location) {
                    return null;
                }
                const parts = [];

                if (settings.showWorldName && lastLocation.name) {
                    let name = lastLocation.name;
                    if (name.length > settings.maxWorldNameLength) {
                        name = `${name.slice(0, settings.maxWorldNameLength - 1)}…`;
                    }
                    parts.push(`🌐 ${name}`);
                }
                if (settings.showInstanceType) {
                    const location = parseLocation(lastLocation.location);
                    if (location.accessTypeName) {
                        parts.push(`[${location.accessTypeName}]`);
                    }
                }
                if (settings.showPlayerCount) {
                    parts.push(`👥 ${lastLocation.playerList?.size ?? 0}`);
                }
                if (settings.showFriendCount) {
                    parts.push(`🤝 ${lastLocation.friendList?.size ?? 0}`);
                }
                if (settings.showTimeInInstance && lastLocation.date) {
                    parts.push(
                        `⏱ ${formatDuration(Date.now() - lastLocation.date)}`
                    );
                }

                return parts.length > 0 ? parts.join(' ') : null;
            }
        });
        ctx.onDispose(unregister);
    }
};
