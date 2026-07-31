import { CHATBOX_MAX_LENGTH, oscService } from '../../services/osc';
import { composeChatboxMessage, renderChatboxSources } from '../chatbox';
import { resolveStores } from '../stores';

/**
 * Core OSC chatbox engine.
 *
 * Owns the OSC transport and the send cadence. Content comes from whichever
 * "chatbox source" plugins the user has enabled, so this plugin on its own
 * sends nothing.
 *
 * @type {import('../registry').PluginManifest}
 */
export const oscChatboxPlugin = {
    id: 'osc-chatbox',
    name: 'OSC Chatbox',
    nameKey: 'view.plugins.items.osc_chatbox.name',
    descriptionKey: 'view.plugins.items.osc_chatbox.description',
    description:
        'Drives the VRChat chatbox over OSC. Enable chatbox modules to fill it with content.',
    icon: 'ri-chat-3-line',
    category: 'chatbox',
    tags: ['osc', 'chatbox'],
    settingsSchema: [
        {
            key: 'host',
            type: 'string',
            label: 'OSC host',
            description: 'Where VRChat is listening. Normally 127.0.0.1.',
            default: '127.0.0.1',
            placeholder: '127.0.0.1'
        },
        {
            key: 'sendPort',
            type: 'number',
            label: 'Send port',
            default: 9000,
            min: 1,
            max: 65535
        },
        {
            key: 'receivePort',
            type: 'number',
            label: 'Receive port',
            description: 'Port VRChat sends to. Set to 0 to disable receiving.',
            default: 9001,
            min: 0,
            max: 65535
        },
        {
            key: 'updateIntervalSeconds',
            type: 'number',
            label: 'Update interval (seconds)',
            description:
                'VRChat rate limits the chatbox; below 2 seconds messages may be dropped.',
            default: 3,
            min: 1,
            max: 60
        },
        {
            key: 'mode',
            type: 'select',
            label: 'Layout',
            default: 'stack',
            options: [
                { value: 'stack', label: 'Combine every module' },
                { value: 'rotate', label: 'Rotate through modules' }
            ]
        },
        {
            key: 'separator',
            type: 'string',
            label: 'Separator',
            description: 'Placed between modules in combined layout.',
            default: ' | '
        },
        {
            key: 'maxLength',
            type: 'number',
            label: 'Max length',
            default: CHATBOX_MAX_LENGTH,
            min: 16,
            max: CHATBOX_MAX_LENGTH
        },
        {
            key: 'playSound',
            type: 'boolean',
            label: 'Play notification sound',
            default: false
        },
        {
            key: 'onlyWhileInGame',
            type: 'boolean',
            label: 'Only send while VRChat is running',
            default: true
        },
        {
            key: 'clearOnStop',
            type: 'boolean',
            label: 'Clear the chatbox when stopping',
            default: true
        }
    ],

    async setup(ctx) {
        if (!oscService.isSupported) {
            ctx.setStatus(
                'OSC is not available in this build of VRCX.',
                'error'
            );
            return;
        }

        const settings = ctx.settings;
        const { game: gameStore } = await resolveStores(['game']);

        const connected = await oscService.acquire(ctx.id, {
            host: settings.host,
            sendPort: settings.sendPort,
            receivePort: settings.receivePort
        });
        if (!connected) {
            ctx.setStatus(
                `Could not open OSC on ${settings.host}:${settings.sendPort}.`,
                'error'
            );
            return;
        }
        ctx.onDispose(async () => {
            if (settings.clearOnStop) {
                await oscService.sendChatbox('', { send: true, sound: false });
            }
            await oscService.release(ctx.id);
        });

        ctx.setStatus(
            `Connected to ${settings.host}:${settings.sendPort}`,
            'ok'
        );

        let rotationIndex = 0;
        let lastMessage = null;

        async function pushUpdate() {
            if (settings.onlyWhileInGame && !gameStore.isGameRunning) {
                if (lastMessage !== null) {
                    lastMessage = null;
                    await oscService.sendChatbox('', {
                        send: true,
                        sound: false
                    });
                }
                return;
            }

            const lines = renderChatboxSources();
            const message = composeChatboxMessage(lines, {
                mode: settings.mode,
                separator: settings.separator,
                maxLength: settings.maxLength,
                rotationIndex
            });
            rotationIndex += 1;

            if (message.length === 0) {
                if (lastMessage !== null && lastMessage !== '') {
                    lastMessage = '';
                    await oscService.sendChatbox('', {
                        send: true,
                        sound: false
                    });
                }
                ctx.setStatus('No chatbox modules are enabled.', 'warning');
                return;
            }

            // In rotate mode the same text can legitimately repeat; re-sending
            // is what keeps the chatbox from timing out, so only skip identical
            // consecutive messages in stacked mode.
            if (settings.mode === 'stack' && message === lastMessage) {
                return;
            }
            lastMessage = message;
            await oscService.sendChatbox(message, {
                send: true,
                sound: settings.playSound
            });
            ctx.setStatus(message, 'ok');
        }

        ctx.interval(() => {
            pushUpdate().catch((err) =>
                ctx.error('chatbox update failed', err)
            );
        }, settings.updateIntervalSeconds * 1000);
    }
};
