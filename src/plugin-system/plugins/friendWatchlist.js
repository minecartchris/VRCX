import { toast } from 'vue-sonner';

import { parseLocation } from '../../shared/utils/locationParser';

/**
 * Matches a display name against the watchlist, case-insensitively.
 *
 * @param {string[]} watchlist
 * @param {string} displayName
 * @param {string} userId
 * @returns {boolean}
 */
export function isWatched(watchlist, displayName, userId) {
    if (!Array.isArray(watchlist) || watchlist.length === 0) {
        return false;
    }
    const name = String(displayName ?? '').toLowerCase();
    return watchlist.some((entry) => {
        const needle = String(entry ?? '').trim();
        if (!needle) {
            return false;
        }
        return needle === userId || needle.toLowerCase() === name;
    });
}

/**
 * Highlights a small set of people: desktop and VR notifications when they come
 * online or move instance, without turning on notifications for everyone.
 *
 * @type {import('../registry').PluginManifest}
 */
export const friendWatchlistPlugin = {
    id: 'friend-watchlist',
    name: 'Friend watchlist',
    nameKey: 'view.plugins.items.friend_watchlist.name',
    descriptionKey: 'view.plugins.items.friend_watchlist.description',
    description:
        'Get a dedicated alert when specific friends come online or change instance.',
    icon: 'ri-user-star-line',
    category: 'social',
    tags: ['friends', 'notifications'],
    settingsSchema: [
        {
            key: 'watchlist',
            type: 'list',
            label: 'Watched friends',
            description: 'Display name or user id, one per entry.',
            default: []
        },
        {
            key: 'notifyOnline',
            type: 'boolean',
            label: 'Notify when they come online',
            default: true
        },
        {
            key: 'notifyOffline',
            type: 'boolean',
            label: 'Notify when they go offline',
            default: false
        },
        {
            key: 'notifyInstanceChange',
            type: 'boolean',
            label: 'Notify when they change instance',
            default: false
        },
        {
            key: 'desktopNotification',
            type: 'boolean',
            label: 'Send a desktop notification',
            default: true
        },
        {
            key: 'xsOverlayNotification',
            type: 'boolean',
            label: 'Send an XSOverlay notification',
            default: false
        }
    ],

    setup(ctx) {
        const settings = ctx.settings;

        /**
         * @param {string} title
         * @param {string} body
         */
        function notify(title, body) {
            toast.info(`${title} ${body}`.trim());
            if (
                settings.desktopNotification &&
                typeof AppApi?.DesktopNotification === 'function'
            ) {
                AppApi.DesktopNotification(title, body, '');
            }
            if (
                settings.xsOverlayNotification &&
                typeof AppApi?.XSNotification === 'function'
            ) {
                AppApi.XSNotification(
                    'VRCX',
                    `${title} ${body}`.trim(),
                    3000,
                    1,
                    ''
                );
            }
            ctx.setStatus(`${title} ${body}`.trim(), 'ok');
        }

        ctx.on(
            ctx.events.FRIEND_ONLINE,
            ({ userId, displayName, location }) => {
                if (
                    !settings.notifyOnline ||
                    !isWatched(settings.watchlist, displayName, userId)
                ) {
                    return;
                }
                const parsed = parseLocation(location ?? '');
                notify(
                    displayName,
                    parsed.worldId ? 'is online and in a world' : 'is online'
                );
            }
        );

        ctx.on(ctx.events.FRIEND_OFFLINE, ({ userId, displayName }) => {
            if (
                !settings.notifyOffline ||
                !isWatched(settings.watchlist, displayName, userId)
            ) {
                return;
            }
            notify(displayName, 'went offline');
        });

        ctx.on(ctx.events.FRIEND_LOCATION, ({ userId, displayName }) => {
            if (
                !settings.notifyInstanceChange ||
                !isWatched(settings.watchlist, displayName, userId)
            ) {
                return;
            }
            notify(displayName, 'changed instance');
        });

        ctx.setStatus(
            settings.watchlist?.length
                ? `Watching ${settings.watchlist.length} people`
                : 'No one on the watchlist yet.',
            settings.watchlist?.length ? 'ok' : 'warning'
        );
    }
};
