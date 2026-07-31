import { postJson } from '../http';
import { parseLocation } from '../../shared/utils/locationParser';

const MIN_INTERVAL_MS = 1500;

/**
 * Relays selected VRCX events to a Discord webhook.
 *
 * @type {import('../registry').PluginManifest}
 */
export const discordWebhookPlugin = {
    id: 'discord-webhook',
    name: 'Discord webhook relay',
    nameKey: 'view.plugins.items.discord_webhook.name',
    descriptionKey: 'view.plugins.items.discord_webhook.description',
    description:
        'Posts world changes, joins and friend activity to a Discord webhook.',
    icon: 'ri-discord-line',
    category: 'integration',
    tags: ['discord', 'notifications'],
    settingsSchema: [
        {
            key: 'webhookUrl',
            type: 'password',
            label: 'Webhook URL',
            description:
                'Discord → channel settings → Integrations → Webhooks.',
            default: ''
        },
        {
            key: 'username',
            type: 'string',
            label: 'Post as',
            default: 'VRCX'
        },
        {
            key: 'events',
            type: 'multiselect',
            label: 'Events to relay',
            default: ['locationChange'],
            options: [
                { value: 'locationChange', label: 'I changed world' },
                { value: 'playerJoin', label: 'Someone joined my instance' },
                { value: 'playerLeave', label: 'Someone left my instance' },
                { value: 'friendOnline', label: 'A friend came online' },
                { value: 'friendOffline', label: 'A friend went offline' }
            ]
        },
        {
            key: 'friendsOnly',
            type: 'boolean',
            label: 'Only relay friends for join/leave',
            default: true
        }
    ],

    setup(ctx) {
        const settings = ctx.settings;
        if (!settings.webhookUrl) {
            ctx.setStatus('Set a webhook URL to start relaying.', 'warning');
            return;
        }
        if (
            !/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(
                settings.webhookUrl
            )
        ) {
            ctx.setStatus(
                'That does not look like a Discord webhook URL.',
                'error'
            );
            return;
        }

        /** @type {string[]} */
        const queue = [];
        let sending = false;
        let lastSentAt = 0;

        async function flush() {
            if (sending || queue.length === 0) {
                return;
            }
            const wait = MIN_INTERVAL_MS - (Date.now() - lastSentAt);
            if (wait > 0) {
                return;
            }
            sending = true;
            // Discord accepts 2000 characters; batching keeps us far below the
            // webhook rate limit when an instance fills up all at once.
            const batch = [];
            let length = 0;
            while (queue.length > 0 && length + queue[0].length + 1 < 1800) {
                const line = queue.shift();
                length += line.length + 1;
                batch.push(line);
            }
            try {
                await postJson(settings.webhookUrl, {
                    username: settings.username || 'VRCX',
                    content: batch.join('\n'),
                    allowed_mentions: { parse: [] }
                });
                lastSentAt = Date.now();
                ctx.setStatus(`Relayed ${batch.length} event(s)`, 'ok');
            } catch (err) {
                ctx.error('webhook post failed', err);
                ctx.setStatus(
                    err instanceof Error ? err.message : String(err),
                    'error'
                );
            } finally {
                sending = false;
            }
        }

        /**
         * @param {string} event
         * @param {string} line
         */
        function enqueue(event, line) {
            if (!settings.events?.includes(event)) {
                return;
            }
            queue.push(line);
            if (queue.length > 100) {
                queue.splice(0, queue.length - 100);
            }
        }

        ctx.interval(() => {
            flush().catch((err) => ctx.error('flush failed', err));
        }, 1000);

        ctx.on(ctx.events.LOCATION_CHANGE, ({ location, name }) => {
            if (!location) {
                enqueue('locationChange', 'Left the instance');
                return;
            }
            const parsed = parseLocation(location);
            enqueue(
                'locationChange',
                `Now in **${name || parsed.worldId || location}**${parsed.accessTypeName ? ` (${parsed.accessTypeName})` : ''}`
            );
        });

        ctx.on(ctx.events.PLAYER_JOIN, ({ displayName, isFriend }) => {
            if (settings.friendsOnly && !isFriend) {
                return;
            }
            enqueue('playerJoin', `➡️ ${displayName} joined`);
        });

        ctx.on(ctx.events.PLAYER_LEAVE, ({ displayName, isFriend }) => {
            if (settings.friendsOnly && !isFriend) {
                return;
            }
            enqueue('playerLeave', `⬅️ ${displayName} left`);
        });

        ctx.on(ctx.events.FRIEND_ONLINE, ({ displayName }) => {
            enqueue('friendOnline', `🟢 ${displayName} is online`);
        });

        ctx.on(ctx.events.FRIEND_OFFLINE, ({ displayName }) => {
            enqueue('friendOffline', `⚫ ${displayName} went offline`);
        });

        ctx.setStatus('Ready.', 'ok');
    }
};
