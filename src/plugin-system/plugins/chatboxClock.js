import dayjs from 'dayjs';

import { registerChatboxSource } from '../chatbox';

/**
 * Shows the current time (optionally in another timezone) in the chatbox.
 *
 * @type {import('../registry').PluginManifest}
 */
export const chatboxClockPlugin = {
    id: 'chatbox-clock',
    name: 'Chatbox: Clock',
    nameKey: 'view.plugins.items.chatbox_clock.name',
    descriptionKey: 'view.plugins.items.chatbox_clock.description',
    description: 'Adds the current time and date to the OSC chatbox.',
    icon: 'ri-time-line',
    category: 'chatbox',
    requires: ['osc-chatbox'],
    tags: ['chatbox'],
    settingsSchema: [
        {
            key: 'format',
            type: 'string',
            label: 'Format',
            description:
                'Day.js tokens, e.g. "HH:mm" or "ddd HH:mm". See day.js display formats.',
            default: 'HH:mm'
        },
        {
            key: 'prefix',
            type: 'string',
            label: 'Prefix',
            default: '🕒 '
        },
        {
            key: 'timezone',
            type: 'string',
            label: 'Timezone',
            description:
                'IANA name such as Europe/Berlin. Leave empty for local time.',
            default: '',
            placeholder: 'Europe/Berlin'
        },
        {
            key: 'order',
            type: 'number',
            label: 'Position',
            description: 'Lower numbers appear earlier in the chatbox.',
            default: 10,
            min: 0,
            max: 999
        }
    ],

    setup(ctx) {
        const settings = ctx.settings;
        const unregister = registerChatboxSource({
            id: ctx.id,
            label: 'Clock',
            order: settings.order,
            render() {
                let now = dayjs();
                if (settings.timezone) {
                    try {
                        now = now.tz(settings.timezone);
                    } catch {
                        // Invalid timezone: fall back to local rather than
                        // blanking the whole chatbox line.
                    }
                }
                return `${settings.prefix}${now.format(settings.format || 'HH:mm')}`;
            }
        });
        ctx.onDispose(unregister);
    }
};
