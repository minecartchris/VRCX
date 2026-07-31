import { toast } from 'vue-sonner';
import { resolveStores } from '../stores';

/**
 * @param {Map<string, {type: string, targetUserId: string, sourceUserId: string}>} moderations
 * @param {string} currentUserId
 * @param {string} targetUserId
 * @returns {string[]} moderation types you applied to that user
 */
export function moderationTypesFor(moderations, currentUserId, targetUserId) {
    const types = [];
    for (const moderation of moderations.values()) {
        if (
            moderation.targetUserId === targetUserId &&
            moderation.sourceUserId === currentUserId
        ) {
            types.push(moderation.type);
        }
    }
    return types;
}

/**
 * Keeps an eye on who shares your instances: flags people you have blocked or
 * muted, and counts how often the same stranger keeps turning up.
 *
 * @type {import('../registry').PluginManifest}
 */
export const instanceRadarPlugin = {
    id: 'instance-radar',
    name: 'Instance radar',
    nameKey: 'view.plugins.items.instance_radar.name',
    descriptionKey: 'view.plugins.items.instance_radar.description',
    description:
        'Flags moderated users and repeat encounters when players join your instance.',
    icon: 'ri-radar-line',
    category: 'social',
    tags: ['instance', 'safety'],
    settingsSchema: [
        {
            key: 'alertModerated',
            type: 'boolean',
            label: 'Alert when someone you blocked or muted joins',
            default: true
        },
        {
            key: 'trackEncounters',
            type: 'boolean',
            label: 'Count repeat encounters',
            default: true
        },
        {
            key: 'repeatThreshold',
            type: 'number',
            label: 'Alert after this many separate instances',
            default: 5,
            min: 2,
            max: 100,
            visibleWhen: (settings) => settings.trackEncounters
        },
        {
            key: 'ignoreFriends',
            type: 'boolean',
            label: 'Ignore friends',
            default: true
        },
        {
            key: 'retentionDays',
            type: 'number',
            label: 'Forget encounters after (days)',
            default: 30,
            min: 1,
            max: 365,
            visibleWhen: (settings) => settings.trackEncounters
        }
    ],

    async setup(ctx) {
        const settings = ctx.settings;
        const { moderation: moderationStore, user: userStore } =
            await resolveStores(['moderation', 'user']);

        /** @type {Record<string, {name: string, count: number, lastSeen: number, alerted: boolean}>} */
        let encounters = (await ctx.storage.get('encounters', null)) ?? {};

        const cutoff = Date.now() - settings.retentionDays * 86400000;
        for (const [userId, record] of Object.entries(encounters)) {
            if ((record.lastSeen ?? 0) < cutoff) {
                delete encounters[userId];
            }
        }

        /** Users already counted for the current instance. */
        let countedThisInstance = new Set();

        ctx.on(ctx.events.LOCATION_CHANGE, () => {
            countedThisInstance = new Set();
        });

        ctx.on(ctx.events.PLAYER_JOIN, ({ userId, displayName, isFriend }) => {
            if (!userId || userId === userStore.currentUser?.id) {
                return;
            }
            if (settings.ignoreFriends && isFriend) {
                return;
            }

            if (settings.alertModerated) {
                const types = moderationTypesFor(
                    moderationStore.cachedPlayerModerations,
                    userStore.currentUser?.id ?? '',
                    userId
                );
                if (types.length > 0) {
                    const message = `${displayName} joined — you have them ${types.join(', ')}`;
                    toast.warning(message);
                    ctx.setStatus(message, 'warning');
                }
            }

            if (!settings.trackEncounters || countedThisInstance.has(userId)) {
                return;
            }
            countedThisInstance.add(userId);

            const record = encounters[userId] ?? {
                name: displayName,
                count: 0,
                lastSeen: 0,
                alerted: false
            };
            record.name = displayName || record.name;
            record.count += 1;
            record.lastSeen = Date.now();
            encounters[userId] = record;

            if (!record.alerted && record.count >= settings.repeatThreshold) {
                record.alerted = true;
                const message = `${record.name} has now shared ${record.count} instances with you`;
                toast.info(message);
                ctx.setStatus(message, 'ok');
            }
        });

        ctx.interval(() => {
            ctx.storage
                .set('encounters', encounters)
                .catch((err) => ctx.error('failed to persist encounters', err));
        }, 60000);
        ctx.onDispose(() => ctx.storage.set('encounters', encounters));

        ctx.setStatus(
            `Tracking ${Object.keys(encounters).length} people`,
            'ok'
        );
    }
};
