import { registerChatboxSource } from '../chatbox';
import { resolveStores } from '../stores';

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatSessionDuration(ms) {
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
 * How long the current VRChat session has been running.
 *
 * @type {import('../registry').PluginManifest}
 */
export const chatboxSessionStatsPlugin = {
    id: 'chatbox-session-stats',
    name: 'Chatbox: Session time',
    nameKey: 'view.plugins.items.chatbox_session_stats.name',
    descriptionKey: 'view.plugins.items.chatbox_session_stats.description',
    description: 'Shows how long your current VRChat session has been running.',
    icon: 'ri-timer-line',
    category: 'chatbox',
    requires: ['osc-chatbox'],
    tags: ['chatbox'],
    settingsSchema: [
        {
            key: 'prefix',
            type: 'string',
            label: 'Prefix',
            default: '⏳ '
        },
        {
            key: 'suffix',
            type: 'string',
            label: 'Suffix',
            default: ' in VRC'
        },
        {
            key: 'order',
            type: 'number',
            label: 'Position',
            default: 80,
            min: 0,
            max: 999
        }
    ],

    async setup(ctx) {
        const settings = ctx.settings;
        const { game: gameStore } = await resolveStores(['game']);
        let sessionStart = gameStore.isGameRunning ? Date.now() : 0;

        ctx.on(ctx.events.GAME_STATE, ({ isRunning }) => {
            sessionStart = isRunning ? Date.now() : 0;
        });

        const unregister = registerChatboxSource({
            id: ctx.id,
            label: 'Session time',
            order: settings.order,
            render() {
                if (!sessionStart) {
                    return null;
                }
                return `${settings.prefix}${formatSessionDuration(Date.now() - sessionStart)}${settings.suffix}`;
            }
        });
        ctx.onDispose(unregister);
    }
};
