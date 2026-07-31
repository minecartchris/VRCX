import { toast } from 'vue-sonner';

import { resolveStores } from '../stores';
import { registerChatboxSource } from '../chatbox';

/**
 * Normalises an avatar change event into the record shape kept in history.
 *
 * The two upstream sources disagree on how much they know: Photon carries the
 * full avatar ref, while the log-file parser only ever knows a display name and
 * an avatar name. Anything missing is stored as an empty string so the history
 * has one stable shape.
 *
 * @param {object} payload
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {{userId: string, displayName: string, avatarName: string, avatarId: string, authorId: string, at: number} | null}
 */
export function normalizeAvatarChange(payload, now = Date.now()) {
    if (!payload) {
        return null;
    }
    const displayName = String(payload.displayName ?? '').trim();
    const userId = String(payload.userId ?? '').trim();
    if (!displayName && !userId) {
        // Without either identifier the entry cannot be attributed to anyone.
        return null;
    }
    const parsed = Date.parse(payload.createdAt ?? '');
    return {
        userId,
        displayName,
        avatarName: String(payload.avatarName ?? '').trim(),
        avatarId: String(payload.avatarId ?? '').trim(),
        authorId: String(payload.authorId ?? '').trim(),
        at: Number.isFinite(parsed) ? parsed : now
    };
}

/**
 * Rate limit per person, keyed by whichever identifier we have.
 *
 * Cycling through a few avatars in a row is common, and without this the log
 * fills with near-duplicate entries.
 *
 * @param {Map<string, number>} lastSeen
 * @param {{userId: string, displayName: string, at: number}} record
 * @param {number} minIntervalMs
 * @returns {boolean}
 */
export function shouldRecord(lastSeen, record, minIntervalMs) {
    const key = record.userId || record.displayName;
    if (!key) {
        return false;
    }
    const previous = lastSeen.get(key);
    if (previous !== undefined && record.at - previous < minIntervalMs) {
        return false;
    }
    lastSeen.set(key, record.at);
    return true;
}

/**
 * Appends to the history, keeping the newest `limit` entries.
 *
 * @param {object[]} history
 * @param {object} record
 * @param {number} limit
 * @returns {object[]}
 */
export function pushHistory(history, record, limit) {
    const next = Array.isArray(history) ? history.slice() : [];
    next.push(record);
    const capped = Math.max(1, Math.floor(limit) || 1);
    return next.length > capped ? next.slice(next.length - capped) : next;
}

/**
 * @param {{displayName: string, avatarName: string}} record
 * @returns {string}
 */
export function formatChange(record) {
    const who = record.displayName || record.userId;
    return record.avatarName
        ? `${who} → ${record.avatarName}`
        : `${who} changed avatar`;
}

/**
 * Keeps a running log of avatar switches by the people in your instance.
 *
 * This records only what VRCX already observes — who swapped, to which avatar
 * name, and when. It stores no avatar assets.
 *
 * @type {import('../registry').PluginManifest}
 */
export const avatarChangeLogPlugin = {
    id: 'avatar-change-log',
    name: 'Avatar change log',
    nameKey: 'view.plugins.items.avatar_change_log.name',
    descriptionKey: 'view.plugins.items.avatar_change_log.description',
    description:
        'Keeps a log of who in your instance switched avatar, and when.',
    icon: 'ri-t-shirt-line',
    category: 'insights',
    tags: ['instance', 'stats'],
    settingsSchema: [
        {
            key: 'historySize',
            type: 'number',
            label: 'Entries to keep',
            description: 'Oldest entries are dropped once the log is full.',
            default: 200,
            min: 10,
            max: 2000,
            step: 10
        },
        {
            key: 'friendsOnly',
            type: 'boolean',
            label: 'Only log friends',
            default: false
        },
        {
            key: 'minSecondsBetween',
            type: 'number',
            label: 'Minimum seconds between entries per person',
            description:
                'Stops a log full of near-duplicates when someone cycles avatars.',
            default: 10,
            min: 0,
            max: 600
        },
        {
            key: 'writeToFeed',
            type: 'boolean',
            label: 'Add each change to the Feed tab',
            description: 'Shows up under the "Plugin" category.',
            default: true
        },
        {
            key: 'toastOnChange',
            type: 'boolean',
            label: 'Show a toast on each change',
            default: false
        },
        {
            key: 'desktopNotification',
            type: 'boolean',
            label: 'Send a desktop notification',
            default: false,
            visibleWhen: (settings) => settings.toastOnChange
        },
        {
            key: 'showInChatbox',
            type: 'boolean',
            label: 'Show the session count in the chatbox',
            default: false
        },
        {
            key: 'chatboxPrefix',
            type: 'string',
            label: 'Chatbox prefix',
            default: '👕 Swaps: ',
            visibleWhen: (settings) => settings.showInChatbox
        },
        {
            key: 'order',
            type: 'number',
            label: 'Chatbox position',
            default: 120,
            min: 0,
            max: 999,
            visibleWhen: (settings) => settings.showInChatbox
        }
    ],

    async setup(ctx) {
        const settings = ctx.settings;
        const { friend: friendStore } = await resolveStores(['friend']);

        /** @type {object[]} */
        let history = (await ctx.storage.get('history', null)) ?? [];
        if (!Array.isArray(history)) {
            history = [];
        }
        /** @type {Map<string, number>} */
        const lastSeen = new Map();
        let sessionCount = 0;
        let dirty = false;

        /**
         * @param {string} userId
         * @returns {boolean}
         */
        function isFriend(userId) {
            return Boolean(userId) && Boolean(friendStore.friends?.has(userId));
        }

        function updateStatus() {
            const latest = history[history.length - 1];
            ctx.setStatus(
                latest
                    ? `${sessionCount} this session · last: ${formatChange(latest)}`
                    : 'No avatar changes seen yet.',
                'ok'
            );
        }

        async function persist() {
            if (!dirty) {
                return;
            }
            dirty = false;
            await ctx.storage.set('history', history);
        }

        ctx.on(ctx.events.AVATAR_CHANGE, (payload) => {
            const record = normalizeAvatarChange(payload);
            if (!record) {
                return;
            }
            if (settings.friendsOnly && !isFriend(record.userId)) {
                return;
            }
            if (
                !shouldRecord(
                    lastSeen,
                    record,
                    Math.max(0, settings.minSecondsBetween) * 1000
                )
            ) {
                return;
            }

            history = pushHistory(history, record, settings.historySize);
            sessionCount += 1;
            dirty = true;

            const line = formatChange(record);
            if (settings.writeToFeed) {
                ctx.feed(line, {
                    detail: record.avatarId
                        ? `Avatar id: ${record.avatarId}`
                        : '',
                    userId: record.userId,
                    displayName: record.displayName
                });
            }
            if (settings.toastOnChange) {
                toast.info(line);
                if (
                    settings.desktopNotification &&
                    typeof AppApi?.DesktopNotification === 'function'
                ) {
                    AppApi.DesktopNotification('VRCX avatar change', line, '');
                }
            }
            updateStatus();
        });

        // The local user leaving an instance is the natural checkpoint: the
        // per-person rate limit is meaningless across instances.
        ctx.on(ctx.events.LOCATION_CHANGE, () => {
            lastSeen.clear();
            persist().catch((err) => ctx.error('failed to persist', err));
        });

        ctx.interval(() => {
            persist().catch((err) => ctx.error('failed to persist', err));
        }, 60000);
        ctx.onDispose(() => {
            dirty = true;
            return persist();
        });

        if (settings.showInChatbox) {
            const unregister = registerChatboxSource({
                id: ctx.id,
                label: 'Avatar swaps',
                order: settings.order,
                render() {
                    return `${settings.chatboxPrefix}${sessionCount}`;
                }
            });
            ctx.onDispose(unregister);
        }

        updateStatus();
    }
};
