import { reactive } from 'vue';

import { oscService } from '../../services/osc';
import { registerChatboxSource } from '../chatbox';

/**
 * Live snapshot of every avatar parameter VRChat has sent, keyed by parameter
 * name. Exported so other plugins and the settings UI can read it.
 *
 * @type {Record<string, number | boolean | string>}
 */
export const avatarParameters = reactive({});

/** Current avatar id reported over `/avatar/change`. */
export const avatarState = reactive({ avatarId: '', lastChangeAt: 0 });

const PARAMETER_PREFIX = '/avatar/parameters/';

/**
 * Receives avatar parameters from VRChat over OSC.
 *
 * @type {import('../registry').PluginManifest}
 */
export const oscAvatarParametersPlugin = {
    id: 'osc-avatar-parameters',
    name: 'OSC avatar parameters',
    nameKey: 'view.plugins.items.osc_avatar_parameters.name',
    descriptionKey: 'view.plugins.items.osc_avatar_parameters.description',
    description:
        'Listens for avatar parameters from VRChat and can surface chosen ones in the chatbox.',
    icon: 'ri-sliders-line',
    category: 'osc',
    tags: ['osc'],
    settingsSchema: [
        {
            key: 'host',
            type: 'string',
            label: 'OSC host',
            default: '127.0.0.1'
        },
        {
            key: 'receivePort',
            type: 'number',
            label: 'Receive port',
            default: 9001,
            min: 1,
            max: 65535
        },
        {
            key: 'chatboxParameters',
            type: 'list',
            label: 'Parameters to show in the chatbox',
            description:
                'One parameter name per entry, e.g. "MuteSelf". Requires the OSC Chatbox plugin.',
            default: []
        },
        {
            key: 'order',
            type: 'number',
            label: 'Chatbox position',
            default: 100,
            min: 0,
            max: 999
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

        const connected = await oscService.acquire(ctx.id, {
            host: settings.host,
            receivePort: settings.receivePort
        });
        if (!connected) {
            ctx.setStatus('Could not open the OSC socket.', 'error');
            return;
        }
        ctx.onDispose(() => oscService.release(ctx.id));

        let received = 0;
        const off = oscService.onMessage(({ address, args }) => {
            if (address === '/avatar/change') {
                avatarState.avatarId = String(args?.[0] ?? '');
                avatarState.lastChangeAt = Date.now();
                // Parameters do not carry over between avatars.
                for (const key of Object.keys(avatarParameters)) {
                    delete avatarParameters[key];
                }
                return;
            }
            if (!address?.startsWith(PARAMETER_PREFIX)) {
                return;
            }
            const name = address.slice(PARAMETER_PREFIX.length);
            avatarParameters[name] = args?.[0];
            received += 1;
            ctx.emit(ctx.events.OSC_MESSAGE, { address, args });
            if (received % 50 === 1) {
                ctx.setStatus(
                    `Tracking ${Object.keys(avatarParameters).length} parameters`,
                    'ok'
                );
            }
        });
        ctx.onDispose(off);
        ctx.onDispose(() => {
            for (const key of Object.keys(avatarParameters)) {
                delete avatarParameters[key];
            }
        });

        ctx.setStatus(`Listening on port ${settings.receivePort}`, 'ok');

        if (settings.chatboxParameters?.length) {
            const unregister = registerChatboxSource({
                id: ctx.id,
                label: 'Avatar parameters',
                order: settings.order,
                render() {
                    const parts = [];
                    for (const name of settings.chatboxParameters) {
                        const value = avatarParameters[name];
                        if (value === undefined) {
                            continue;
                        }
                        const display =
                            typeof value === 'number'
                                ? Math.round(value * 100) / 100
                                : value;
                        parts.push(`${name}: ${display}`);
                    }
                    return parts.length > 0 ? parts.join(' ') : null;
                }
            });
            ctx.onDispose(unregister);
        }
    }
};
