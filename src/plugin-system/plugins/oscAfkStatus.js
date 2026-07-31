import { toast } from 'vue-sonner';
import { resolveStores } from '../stores';

import { oscService } from '../../services/osc';
import { registerChatboxSource } from '../chatbox';

const AFK_PARAMETER = '/avatar/parameters/AFK';

/**
 * Reacts to VRChat's built-in AFK avatar parameter: optionally flips your
 * social status and adds an AFK marker to the chatbox.
 *
 * @type {import('../registry').PluginManifest}
 */
export const oscAfkStatusPlugin = {
    id: 'osc-afk-status',
    name: 'AFK detection',
    nameKey: 'view.plugins.items.osc_afk_status.name',
    descriptionKey: 'view.plugins.items.osc_afk_status.description',
    description:
        'Detects the VRChat AFK state over OSC and can change your status automatically.',
    icon: 'ri-zzz-line',
    category: 'automation',
    tags: ['osc', 'status'],
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
            key: 'graceSeconds',
            type: 'number',
            label: 'Wait before reacting (seconds)',
            description:
                'Avoids flapping when the AFK parameter toggles briefly.',
            default: 60,
            min: 0,
            max: 1800
        },
        {
            key: 'changeStatus',
            type: 'boolean',
            label: 'Change my status while AFK',
            default: false
        },
        {
            key: 'afkStatus',
            type: 'select',
            label: 'Status while AFK',
            default: 'ask me',
            options: [
                { value: 'join me', label: 'Join me' },
                { value: 'active', label: 'Online' },
                { value: 'ask me', label: 'Ask me' },
                { value: 'busy', label: 'Do not disturb' }
            ],
            visibleWhen: (settings) => settings.changeStatus
        },
        {
            key: 'showInChatbox',
            type: 'boolean',
            label: 'Show an AFK marker in the chatbox',
            default: true
        },
        {
            key: 'chatboxText',
            type: 'string',
            label: 'Chatbox text',
            default: '💤 AFK',
            visibleWhen: (settings) => settings.showInChatbox
        },
        {
            key: 'order',
            type: 'number',
            label: 'Chatbox position',
            default: 5,
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
        const { user: userStore } = await resolveStores(['user']);
        const { default: userRequest } = await import('../../api/user');

        const connected = await oscService.acquire(ctx.id, {
            host: settings.host,
            receivePort: settings.receivePort
        });
        if (!connected) {
            ctx.setStatus('Could not open the OSC socket.', 'error');
            return;
        }
        ctx.onDispose(() => oscService.release(ctx.id));

        let isAfk = false;
        let afkSince = 0;
        let statusApplied = false;
        /** Status to restore once the user comes back. */
        let previousStatus = '';

        async function applyStatus(status) {
            try {
                await userRequest.saveCurrentUser({ status });
            } catch (err) {
                ctx.error('failed to change status', err);
                toast.error('AFK detection could not change your status.');
            }
        }

        async function evaluate() {
            if (!settings.changeStatus) {
                return;
            }
            const afkLongEnough =
                isAfk && Date.now() - afkSince >= settings.graceSeconds * 1000;

            if (afkLongEnough && !statusApplied) {
                previousStatus = userStore.currentUser?.status ?? '';
                if (previousStatus === settings.afkStatus) {
                    // Nothing to restore later; skip touching the API at all.
                    statusApplied = true;
                    return;
                }
                statusApplied = true;
                await applyStatus(settings.afkStatus);
                ctx.setStatus(
                    `AFK — status set to ${settings.afkStatus}`,
                    'ok'
                );
            } else if (!isAfk && statusApplied) {
                statusApplied = false;
                if (previousStatus) {
                    await applyStatus(previousStatus);
                    ctx.setStatus(`Back — status restored`, 'ok');
                }
            }
        }

        const off = oscService.onMessage(({ address, args }) => {
            if (address !== AFK_PARAMETER) {
                return;
            }
            const next = Boolean(args?.[0]);
            if (next === isAfk) {
                return;
            }
            isAfk = next;
            afkSince = next ? Date.now() : 0;
            ctx.setStatus(next ? 'AFK' : 'Active', 'ok');
        });
        ctx.onDispose(off);

        ctx.interval(() => {
            evaluate().catch((err) => ctx.error('AFK evaluation failed', err));
        }, 5000);

        ctx.onDispose(async () => {
            if (statusApplied && previousStatus) {
                await applyStatus(previousStatus);
            }
        });

        if (settings.showInChatbox) {
            const unregister = registerChatboxSource({
                id: ctx.id,
                label: 'AFK marker',
                order: settings.order,
                render() {
                    return isAfk ? settings.chatboxText : null;
                }
            });
            ctx.onDispose(unregister);
        }

        ctx.setStatus(`Listening on port ${settings.receivePort}`, 'ok');
    }
};
