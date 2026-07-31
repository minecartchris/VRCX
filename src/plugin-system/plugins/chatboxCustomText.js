import { registerChatboxSource } from '../chatbox';
import { parseLocation } from '../../shared/utils/locationParser';
import { resolveStores } from '../stores';

/**
 * Rotating user-authored chatbox lines with variable substitution.
 *
 * @type {import('../registry').PluginManifest}
 */
export const chatboxCustomTextPlugin = {
    id: 'chatbox-custom-text',
    name: 'Chatbox: Custom text',
    nameKey: 'view.plugins.items.chatbox_custom_text.name',
    descriptionKey: 'view.plugins.items.chatbox_custom_text.description',
    description:
        'Rotates through your own messages. Supports {name}, {world}, {players}, {status}, {time}.',
    icon: 'ri-quill-pen-line',
    category: 'chatbox',
    requires: ['osc-chatbox'],
    tags: ['chatbox'],
    settingsSchema: [
        {
            key: 'messages',
            type: 'list',
            label: 'Messages',
            description:
                'One entry per line. Variables: {name} {status} {world} {players} {time}.',
            default: ['Hi, I am {name}']
        },
        {
            key: 'rotateEverySeconds',
            type: 'number',
            label: 'Rotate every (seconds)',
            description: 'Set to 0 to always show the first message.',
            default: 15,
            min: 0,
            max: 600
        },
        {
            key: 'order',
            type: 'number',
            label: 'Position',
            default: 20,
            min: 0,
            max: 999
        }
    ],

    async setup(ctx) {
        const settings = ctx.settings;
        const { location: locationStore, user: userStore } =
            await resolveStores(['location', 'user']);

        /**
         * @param {string} template
         * @returns {string}
         */
        function substitute(template) {
            const currentUser = userStore.currentUser ?? {};
            const lastLocation = locationStore.lastLocation ?? {};
            const location = parseLocation(lastLocation.location ?? '');
            return template
                .replace(/\{name\}/g, currentUser.displayName ?? '')
                .replace(/\{status\}/g, currentUser.statusDescription || '')
                .replace(/\{world\}/g, lastLocation.name ?? '')
                .replace(
                    /\{players\}/g,
                    String(lastLocation.playerList?.size ?? 0)
                )
                .replace(/\{instance\}/g, location.accessTypeName ?? '')
                .replace(
                    /\{time\}/g,
                    new Date().toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit'
                    })
                );
        }

        const unregister = registerChatboxSource({
            id: ctx.id,
            label: 'Custom text',
            order: settings.order,
            render() {
                const messages = (settings.messages ?? []).filter(
                    (message) => typeof message === 'string' && message.trim()
                );
                if (messages.length === 0) {
                    return null;
                }
                const rotate = settings.rotateEverySeconds;
                const index =
                    rotate > 0
                        ? Math.floor(Date.now() / (rotate * 1000)) %
                          messages.length
                        : 0;
                return substitute(messages[index]);
            }
        });
        ctx.onDispose(unregister);
    }
};
