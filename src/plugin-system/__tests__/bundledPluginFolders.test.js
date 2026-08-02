import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { compileRemotePlugin, validateRemoteManifest } from '../remote';
import { buildDefaultSettings } from '../settingsSchema';

/**
 * The plugin folders under `vrcx-plugins/` are meant to be imported from
 * GitHub, so they are exercised through the same validate + compile path the
 * import flow uses rather than being imported as modules.
 */
const ROOT = join(process.cwd(), 'vrcx-plugins');
const FOLDERS = ['demo', 'magic-chatbox'];

/**
 * @param {string} folder
 */
function load(folder) {
    const manifest = validateRemoteManifest(
        JSON.parse(readFileSync(join(ROOT, folder, 'vrcx-plugin.json'), 'utf8'))
    );
    const source = readFileSync(join(ROOT, folder, manifest.entry), 'utf8');
    return {
        manifest,
        source,
        compiled: compileRemotePlugin(source, manifest.id)
    };
}

/**
 * Stand-in for the real plugin context, recording what the plugin registers.
 *
 * @param {Record<string, *>} settings
 */
function fakeContext(settings) {
    const record = {
        settings,
        handlers: new Map(),
        intervals: [],
        chatboxRender: null,
        status: null,
        feeds: [],
        disposers: []
    };
    return {
        record,
        ctx: {
            id: 'test',
            settings,
            events: {
                PLAYER_JOIN: 'playerJoin',
                AVATAR_CHANGE: 'avatarChange',
                LOCATION_CHANGE: 'locationChange'
            },
            on: (event, handler) => record.handlers.set(event, handler),
            interval: (fn, ms) => record.intervals.push({ fn, ms }),
            timeout: vi.fn(),
            watch: vi.fn(),
            onDispose: (fn) => record.disposers.push(fn),
            storage: {
                get: async (_key, fallback) => fallback,
                set: async () => {}
            },
            chatbox: (render) => {
                record.chatboxRender = render;
                return () => {};
            },
            oscListen: async () => true,
            feed: (message, options) => {
                record.feeds.push({ message, options });
                return Promise.resolve(null);
            },
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            setStatus: (detail, state) => {
                record.status = { detail, state };
            }
        }
    };
}

describe('bundled plugin folders', () => {
    test.each(FOLDERS)('%s has a valid manifest and compiles', (folder) => {
        const { manifest, compiled } = load(folder);
        expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
        expect(typeof compiled.setup).toBe('function');
    });

    test.each(FOLDERS)('%s declares a default for every setting', (folder) => {
        const { manifest } = load(folder);
        const defaults = buildDefaultSettings(manifest.settingsSchema);
        for (const field of manifest.settingsSchema) {
            expect(defaults[field.key]).toBeDefined();
        }
    });
});

describe('demo plugin behaviour', () => {
    test('writes the greeting to the feed and counts joins', async () => {
        const { manifest, compiled } = load('demo');
        const settings = buildDefaultSettings(manifest.settingsSchema);
        const { ctx, record } = fakeContext(settings);

        await compiled.setup(ctx);

        expect(record.feeds[0].message).toBe(settings.greeting);

        record.handlers.get('playerJoin')({
            userId: 'usr_1',
            displayName: 'Alice',
            isFriend: true
        });
        expect(record.feeds.at(-1).message).toBe('Alice joined');
        expect(record.status.detail).toContain('Seen 1');
    });

    test('only registers a chatbox source when asked', async () => {
        const { manifest, compiled } = load('demo');
        const settings = buildDefaultSettings(manifest.settingsSchema);
        const off = fakeContext({ ...settings, showInChatbox: false });
        await compiled.setup(off.ctx);
        expect(off.record.chatboxRender).toBeNull();

        const on = fakeContext({ ...settings, showInChatbox: true });
        await compiled.setup(on.ctx);
        expect(on.record.chatboxRender()).toBe(`${settings.chatboxPrefix}0`);
    });
});

describe('magic chatbox status plugin', () => {
    const EXPORT = JSON.stringify({
        Version: 2,
        Groups: [
            { GroupId: 'g1', Name: 'Default', IsActiveForCycle: true },
            { GroupId: 'g2', Name: 'music', IsActiveForCycle: false }
        ],
        Items: [
            { MSGID: 1, msg: 'afk', GroupId: 'g1', UseInCycle: true },
            { MSGID: 2, msg: 'be right back', GroupId: 'g1', UseInCycle: true },
            { MSGID: 3, msg: 'not cycled', GroupId: 'g1', UseInCycle: false },
            { MSGID: 4, msg: 'music only', GroupId: 'g2', UseInCycle: true }
        ]
    });

    /**
     * @param {Record<string, *>} overrides
     */
    async function run(overrides = {}) {
        const { manifest, compiled } = load('magic-chatbox');
        const settings = {
            ...buildDefaultSettings(manifest.settingsSchema),
            statusJson: EXPORT,
            ...overrides
        };
        const { ctx, record } = fakeContext(settings);
        await compiled.setup(ctx);
        return record;
    }

    test('shows the first cycling status from an active group', async () => {
        const record = await run();
        expect(record.chatboxRender()).toBe('afk');
        expect(record.status.state).toBe('ok');
        expect(record.status.detail).toContain('2 statuses');
    });

    test('honours UseInCycle and IsActiveForCycle', async () => {
        const all = await run({
            onlyUseInCycle: false,
            onlyActiveGroups: false
        });
        expect(all.status.detail).toContain('4 statuses');

        const groupsOff = await run({ onlyActiveGroups: false });
        expect(groupsOff.status.detail).toContain('3 statuses');
    });

    test('advances in order when random is off', async () => {
        const record = await run({ random: false });
        expect(record.chatboxRender()).toBe('afk');
        record.intervals[0].fn();
        expect(record.chatboxRender()).toBe('be right back');
        record.intervals[0].fn();
        expect(record.chatboxRender()).toBe('afk');
    });

    test('applies the prefix and the cycle interval', async () => {
        const record = await run({ prefix: '💬 ', intervalSeconds: 7 });
        expect(record.chatboxRender()).toBe('💬 afk');
        expect(record.intervals[0].ms).toBe(7000);
    });

    test('does not start a timer when cycling is off', async () => {
        const record = await run({ cycle: false });
        expect(record.intervals).toHaveLength(0);
    });

    test('reports a useful error for bad input', async () => {
        const empty = await run({ statusJson: '' });
        expect(empty.status.state).toBe('error');

        const bad = await run({ statusJson: 'not json' });
        expect(bad.status).toEqual({
            detail: 'That is not valid JSON.',
            state: 'error'
        });

        const noItems = await run({ statusJson: '{"Version":2}' });
        expect(noItems.status.detail).toContain('Items');
    });

    test('warns rather than failing when filters exclude everything', async () => {
        const record = await run({
            statusJson: JSON.stringify({
                Version: 2,
                Groups: [{ GroupId: 'g1', Name: 'x', IsActiveForCycle: true }],
                Items: [
                    { MSGID: 1, msg: 'a', GroupId: 'g1', UseInCycle: false }
                ]
            })
        });
        expect(record.status.state).toBe('warning');
        expect(record.chatboxRender).toBeNull();
    });
});
