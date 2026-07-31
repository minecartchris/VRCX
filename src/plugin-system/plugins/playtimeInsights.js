import { registerChatboxSource } from '../chatbox';
import { resolveStores } from '../stores';

/**
 * @param {Date} [date]
 * @returns {string} local YYYY-MM-DD
 */
export function localDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatHours(ms) {
    const hours = ms / 3600000;
    return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(ms / 60000)}m`;
}

/**
 * Tracks how long you spend in VRChat each day and in which worlds, with an
 * optional daily budget warning.
 *
 * @type {import('../registry').PluginManifest}
 */
export const playtimeInsightsPlugin = {
    id: 'playtime-insights',
    name: 'Playtime insights',
    nameKey: 'view.plugins.items.playtime_insights.name',
    descriptionKey: 'view.plugins.items.playtime_insights.description',
    description:
        'Tracks daily playtime and time per world, with an optional daily limit reminder.',
    icon: 'ri-hourglass-line',
    category: 'insights',
    tags: ['stats'],
    settingsSchema: [
        {
            key: 'dailyLimitHours',
            type: 'number',
            label: 'Daily reminder after (hours)',
            description: 'Set to 0 to disable the reminder.',
            default: 0,
            min: 0,
            max: 24,
            step: 0.5
        },
        {
            key: 'showInChatbox',
            type: 'boolean',
            label: "Show today's playtime in the chatbox",
            default: false
        },
        {
            key: 'chatboxPrefix',
            type: 'string',
            label: 'Chatbox prefix',
            default: '📊 Today: ',
            visibleWhen: (settings) => settings.showInChatbox
        },
        {
            key: 'order',
            type: 'number',
            label: 'Chatbox position',
            default: 110,
            min: 0,
            max: 999
        }
    ],

    async setup(ctx) {
        const settings = ctx.settings;
        const { game: gameStore, location: locationStore } =
            await resolveStores(['game', 'location']);

        /** @type {{day: string, totalMs: number, worlds: Record<string, number>}} */
        let today = (await ctx.storage.get('today', null)) ?? {
            day: localDayKey(),
            totalMs: 0,
            worlds: {}
        };
        if (today.day !== localDayKey()) {
            today = { day: localDayKey(), totalMs: 0, worlds: {} };
        }

        let lastSampleAt = Date.now();
        let reminderSent = false;

        async function persist() {
            await ctx.storage.set('today', today);
        }

        function sample() {
            const now = Date.now();
            const deltaMs = now - lastSampleAt;
            lastSampleAt = now;

            const day = localDayKey();
            if (day !== today.day) {
                today = { day, totalMs: 0, worlds: {} };
                reminderSent = false;
            }
            if (!gameStore.isGameRunning || deltaMs <= 0) {
                return;
            }
            // Guard against a machine sleeping: a huge delta is not playtime.
            const capped = Math.min(deltaMs, 120000);
            today.totalMs += capped;

            const worldName = locationStore.lastLocation?.name;
            if (worldName) {
                today.worlds[worldName] =
                    (today.worlds[worldName] ?? 0) + capped;
            }

            if (
                settings.dailyLimitHours > 0 &&
                !reminderSent &&
                today.totalMs >= settings.dailyLimitHours * 3600000
            ) {
                reminderSent = true;
                if (typeof AppApi?.DesktopNotification === 'function') {
                    AppApi.DesktopNotification(
                        'VRCX playtime',
                        `You have played for ${formatHours(today.totalMs)} today.`,
                        ''
                    );
                }
            }

            ctx.setStatus(
                `Today: ${formatHours(today.totalMs)}${topWorld() ? ` · most time in ${topWorld()}` : ''}`,
                'ok'
            );
        }

        /**
         * @returns {string}
         */
        function topWorld() {
            const entries = Object.entries(today.worlds);
            if (entries.length === 0) {
                return '';
            }
            return entries.sort((a, b) => b[1] - a[1])[0][0];
        }

        ctx.interval(sample, 30000);
        ctx.interval(() => {
            persist().catch((err) => ctx.error('failed to persist', err));
        }, 120000);
        ctx.onDispose(() => {
            sample();
            return persist();
        });

        if (settings.showInChatbox) {
            const unregister = registerChatboxSource({
                id: ctx.id,
                label: 'Playtime',
                order: settings.order,
                render() {
                    return `${settings.chatboxPrefix}${formatHours(today.totalMs)}`;
                }
            });
            ctx.onDispose(unregister);
        }

        ctx.setStatus(`Today: ${formatHours(today.totalMs)}`, 'ok');
    }
};
