import { registerChatboxSource } from '../chatbox';
import { resolveStores } from '../stores';

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatClock(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(safe / 60);
    return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * Mirrors the video currently playing in the instance into the chatbox. VRCX
 * already tracks this for the video player widget, so nothing extra is polled.
 *
 * @type {import('../registry').PluginManifest}
 */
export const chatboxNowPlayingPlugin = {
    id: 'chatbox-now-playing',
    name: 'Chatbox: Now playing',
    nameKey: 'view.plugins.items.chatbox_now_playing.name',
    descriptionKey: 'view.plugins.items.chatbox_now_playing.description',
    description:
        'Shows the video currently playing in your instance in the chatbox.',
    icon: 'ri-music-2-line',
    category: 'chatbox',
    requires: ['osc-chatbox'],
    tags: ['chatbox', 'media'],
    settingsSchema: [
        {
            key: 'prefix',
            type: 'string',
            label: 'Prefix',
            default: '🎵 '
        },
        {
            key: 'showProgress',
            type: 'boolean',
            label: 'Show elapsed / total time',
            default: true
        },
        {
            key: 'maxTitleLength',
            type: 'number',
            label: 'Trim title to',
            default: 40,
            min: 8,
            max: 144
        },
        {
            key: 'order',
            type: 'number',
            label: 'Position',
            default: 70,
            min: 0,
            max: 999
        }
    ],

    async setup(ctx) {
        const settings = ctx.settings;
        const { gameLog: gameLogStore } = await resolveStores(['gameLog']);

        const unregister = registerChatboxSource({
            id: ctx.id,
            label: 'Now playing',
            order: settings.order,
            render() {
                const nowPlaying = gameLogStore.nowPlaying;
                if (!nowPlaying?.playing || !nowPlaying.name) {
                    return null;
                }
                let title = nowPlaying.name;
                if (title.length > settings.maxTitleLength) {
                    title = `${title.slice(0, settings.maxTitleLength - 1)}…`;
                }
                if (!settings.showProgress || !nowPlaying.length) {
                    return `${settings.prefix}${title}`;
                }
                return (
                    `${settings.prefix}${title} ` +
                    `(${formatClock(nowPlaying.elapsed)}/${formatClock(nowPlaying.length)})`
                );
            }
        });
        ctx.onDispose(unregister);
    }
};
