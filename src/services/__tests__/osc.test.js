import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CHATBOX_MAX_LENGTH, oscService } from '../osc';

/**
 * @returns {Record<string, ReturnType<typeof vi.fn>>}
 */
function stubAppApi() {
    const api = {
        OscStart: vi.fn().mockResolvedValue(true),
        OscStop: vi.fn().mockResolvedValue(undefined),
        OscSendChatbox: vi.fn().mockResolvedValue(true),
        OscSendTyping: vi.fn().mockResolvedValue(true),
        OscSendBool: vi.fn().mockResolvedValue(true),
        OscSendInt: vi.fn().mockResolvedValue(true),
        OscSendFloat: vi.fn().mockResolvedValue(true),
        OscPollMessages: vi.fn().mockResolvedValue('[]')
    };
    globalThis.AppApi = api;
    return api;
}

describe('oscService', () => {
    /** @type {Record<string, ReturnType<typeof vi.fn>>} */
    let api;

    beforeEach(async () => {
        api = stubAppApi();
        // Drop any holders left behind by a previous test.
        await oscService.release('a');
        await oscService.release('b');
        api.OscStart.mockClear();
        api.OscStop.mockClear();
    });

    test('reports support based on the native binding', () => {
        expect(oscService.isSupported).toBe(true);
        globalThis.AppApi = {};
        expect(oscService.isSupported).toBe(false);
    });

    test('opens the socket once for several holders', async () => {
        await oscService.acquire('a', { sendPort: 9000, receivePort: 9001 });
        await oscService.acquire('b', {});

        expect(api.OscStart).toHaveBeenCalledTimes(1);
        expect(oscService.isRunning).toBe(true);
    });

    test('stays open until the last holder releases', async () => {
        await oscService.acquire('a', {});
        await oscService.acquire('b', {});

        await oscService.release('a');
        expect(api.OscStop).not.toHaveBeenCalled();
        expect(oscService.isRunning).toBe(true);

        await oscService.release('b');
        expect(api.OscStop).toHaveBeenCalledTimes(1);
        expect(oscService.isRunning).toBe(false);
    });

    test('reopens when a holder asks for a different port', async () => {
        await oscService.acquire('a', { sendPort: 9000, receivePort: 9001 });
        await oscService.acquire('b', { sendPort: 9010 });

        expect(api.OscStart).toHaveBeenCalledTimes(2);
        expect(oscService.config.sendPort).toBe(9010);
    });

    test('concurrent acquires do not race the socket open', async () => {
        await Promise.all([
            oscService.acquire('a', { sendPort: 9000, receivePort: 9001 }),
            oscService.acquire('b', { sendPort: 9000, receivePort: 9001 })
        ]);

        expect(api.OscStart).toHaveBeenCalledTimes(1);
    });

    test('truncates chatbox messages to what VRChat accepts', async () => {
        await oscService.acquire('a', {});
        await oscService.sendChatbox('x'.repeat(200));

        const [text] = api.OscSendChatbox.mock.calls[0];
        expect(text).toHaveLength(CHATBOX_MAX_LENGTH);
    });

    test('does not send while the transport is closed', async () => {
        expect(await oscService.sendChatbox('hi')).toBe(false);
        expect(api.OscSendChatbox).not.toHaveBeenCalled();
    });

    test('picks the OSC type from the JS value', async () => {
        await oscService.acquire('a', {});

        await oscService.sendParameter('MuteSelf', true);
        expect(api.OscSendBool).toHaveBeenCalledWith(
            '/avatar/parameters/MuteSelf',
            true
        );

        await oscService.sendParameter('Count', 3);
        expect(api.OscSendInt).toHaveBeenCalledWith(
            '/avatar/parameters/Count',
            3
        );

        await oscService.sendParameter('/custom/path', 0.5);
        expect(api.OscSendFloat).toHaveBeenCalledWith('/custom/path', 0.5);
    });
});
