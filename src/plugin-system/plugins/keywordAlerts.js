import { toast } from 'vue-sonner';

/**
 * Fields of a game log entry that are worth scanning for keywords.
 *
 * @param {object} entry
 * @returns {string}
 */
export function entryToSearchableText(entry) {
    return [
        entry?.displayName,
        entry?.worldName,
        entry?.videoName,
        entry?.videoUrl,
        entry?.message,
        entry?.data,
        entry?.event
    ]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(' ');
}

/**
 * @param {string[]} keywords
 * @param {string} text
 * @param {boolean} caseSensitive
 * @returns {string | null} the keyword that matched
 */
export function findKeyword(keywords, text, caseSensitive) {
    if (!Array.isArray(keywords) || !text) {
        return null;
    }
    const haystack = caseSensitive ? text : text.toLowerCase();
    for (const keyword of keywords) {
        const needle = String(keyword ?? '').trim();
        if (!needle) {
            continue;
        }
        if (haystack.includes(caseSensitive ? needle : needle.toLowerCase())) {
            return needle;
        }
    }
    return null;
}

/**
 * Watches the game log for words you care about — your name in a chatbox, a
 * video title, a world name — and alerts on a match.
 *
 * @type {import('../registry').PluginManifest}
 */
export const keywordAlertsPlugin = {
    id: 'keyword-alerts',
    name: 'Keyword alerts',
    nameKey: 'view.plugins.items.keyword_alerts.name',
    descriptionKey: 'view.plugins.items.keyword_alerts.description',
    description:
        'Alerts you when a word you care about shows up in the game log.',
    icon: 'ri-notification-badge-line',
    category: 'social',
    tags: ['notifications', 'gamelog'],
    settingsSchema: [
        {
            key: 'keywords',
            type: 'list',
            label: 'Keywords',
            description: 'One keyword or phrase per entry.',
            default: []
        },
        {
            key: 'eventTypes',
            type: 'multiselect',
            label: 'Event types to watch',
            default: ['ChatBoxMessage', 'VideoPlay', 'OnPlayerJoined'],
            options: [
                { value: 'ChatBoxMessage', label: 'Chatbox messages' },
                { value: 'VideoPlay', label: 'Videos' },
                { value: 'OnPlayerJoined', label: 'Player joins' },
                { value: 'OnPlayerLeft', label: 'Player leaves' },
                { value: 'Location', label: 'World changes' },
                { value: 'PortalSpawn', label: 'Portals' },
                { value: 'Event', label: 'Instance events' }
            ]
        },
        {
            key: 'caseSensitive',
            type: 'boolean',
            label: 'Case sensitive',
            default: false
        },
        {
            key: 'desktopNotification',
            type: 'boolean',
            label: 'Send a desktop notification',
            default: false
        },
        {
            key: 'cooldownSeconds',
            type: 'number',
            label: 'Cooldown per keyword (seconds)',
            default: 30,
            min: 0,
            max: 3600
        }
    ],

    setup(ctx) {
        const settings = ctx.settings;
        /** @type {Map<string, number>} */
        const lastAlertAt = new Map();

        ctx.on(ctx.events.GAME_LOG, ({ entry }) => {
            if (!settings.keywords?.length) {
                return;
            }
            if (
                settings.eventTypes?.length &&
                !settings.eventTypes.includes(entry?.type)
            ) {
                return;
            }
            const keyword = findKeyword(
                settings.keywords,
                entryToSearchableText(entry),
                settings.caseSensitive
            );
            if (!keyword) {
                return;
            }

            const now = Date.now();
            const previous = lastAlertAt.get(keyword) ?? 0;
            if (now - previous < settings.cooldownSeconds * 1000) {
                return;
            }
            lastAlertAt.set(keyword, now);

            const message = `Keyword "${keyword}" in ${entry.type}`;
            toast.info(message);
            if (
                settings.desktopNotification &&
                typeof AppApi?.DesktopNotification === 'function'
            ) {
                AppApi.DesktopNotification('VRCX keyword alert', message, '');
            }
            ctx.setStatus(message, 'ok');
        });

        ctx.setStatus(
            settings.keywords?.length
                ? `Watching ${settings.keywords.length} keywords`
                : 'No keywords configured yet.',
            settings.keywords?.length ? 'ok' : 'warning'
        );
    }
};
