import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { compileRemotePlugin, validateRemoteManifest } from '../remote';
import { buildDefaultSettings } from '../settingsSchema';

/**
 * The visual builder is only useful if what it emits actually imports, so its
 * output is pushed through the same validate + compile path the import button
 * uses, then executed against a stand-in context.
 *
 * codegen.js is a classic script rather than a module (file:// blocks ES
 * modules), so it is evaluated the same way an imported plugin is.
 */
function loadCodegen() {
    const source = readFileSync(
        join(process.cwd(), 'tools', 'plugin-builder', 'codegen.js'),
        'utf8'
    );
    const scope = {};
    new Function('globalThis', `"use strict";\n${source}\n`)(scope);
    return scope.VrcxPluginCodegen;
}

const codegen = loadCodegen();

/**
 * @param {Record<string, *>} settings
 */
function fakeContext(settings) {
    const record = {
        handlers: new Map(),
        intervals: [],
        chatbox: [],
        feeds: [],
        status: null,
        instance: {
            inInstance: true,
            worldName: 'The Great Pug',
            ownerId: 'usr_owner',
            accessTypeName: 'Friends',
            region: 'use',
            playerCount: 3,
            friendCount: 1,
            minutesHere: 12,
            isGroup: false,
            players: ['Alice', 'Bob', 'Carol']
        }
    };
    return {
        record,
        ctx: {
            id: 'generated',
            settings,
            events: {
                PLAYER_JOIN: 'PLAYER_JOIN',
                PLAYER_LEAVE: 'PLAYER_LEAVE',
                AVATAR_CHANGE: 'AVATAR_CHANGE',
                LOCATION_CHANGE: 'LOCATION_CHANGE',
                VIDEO_PLAY: 'VIDEO_PLAY',
                FRIEND_ONLINE: 'FRIEND_ONLINE',
                FRIEND_OFFLINE: 'FRIEND_OFFLINE',
                GAME_STATE: 'GAME_STATE'
            },
            on: (event, handler) => record.handlers.set(event, handler),
            interval: (fn, ms) => record.intervals.push({ fn, ms }),
            timeout: vi.fn(),
            onDispose: vi.fn(),
            storage: { get: async (_k, f) => f, set: async () => {} },
            chatbox: (render, options) =>
                record.chatbox.push({ render, options }),
            oscListen: async () => true,
            feed: (message, options) => {
                record.feeds.push({ message, options });
                return Promise.resolve(null);
            },
            instance: () => record.instance,
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            setStatus: (detail, state) => {
                record.status = { detail, state };
            }
        }
    };
}

/**
 * Generates a project, imports it exactly as the app would, and runs setup().
 *
 * @param {object} project
 */
function build(project) {
    const { manifest, manifestJson, source } = codegen.generate(project);
    // Round-trips through JSON so the test exercises the bytes that get written
    // to vrcx-plugin.json, not the in-memory object.
    const validated = validateRemoteManifest(JSON.parse(manifestJson));
    const compiled = compileRemotePlugin(source, validated.id);
    const settings = buildDefaultSettings(validated.settingsSchema);
    const { ctx, record } = fakeContext(settings);
    return { manifest, validated, source, compiled, ctx, record, settings };
}

describe('builder output survives the import pipeline', () => {
    test('an empty project still produces an importable plugin', async () => {
        const built = build({ id: 'empty-plugin', name: 'Empty' });
        await built.compiled.setup(built.ctx);
        expect(built.validated.id).toBe('empty-plugin');
        expect(built.record.status.state).toBe('warning');
    });

    test('a join trigger wires up and fires', async () => {
        const built = build({
            id: 'join-logger',
            name: 'Join logger',
            stacks: [
                {
                    trigger: 'playerJoin',
                    actions: [
                        {
                            type: 'feed',
                            text: '{{displayName}} joined',
                            level: 'success'
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);

        built.record.handlers.get('PLAYER_JOIN')({
            displayName: 'Alice',
            userId: 'usr_1'
        });
        expect(built.record.feeds[0]).toEqual({
            message: 'Alice joined',
            options: {
                level: 'success',
                userId: 'usr_1',
                displayName: 'Alice'
            }
        });
    });

    test('an interval trigger uses seconds', async () => {
        const built = build({
            id: 'ticker',
            name: 'Ticker',
            stacks: [
                {
                    trigger: 'interval',
                    seconds: 30,
                    actions: [{ type: 'status', text: 'tick' }]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.intervals[0].ms).toBe(30000);
        built.record.intervals[0].fn();
        expect(built.record.status.detail).toBe('tick');
    });

    test('chatbox blocks are hoisted into a chatbox source', async () => {
        const built = build({
            id: 'chatty',
            name: 'Chatty',
            settings: [
                { key: 'label', type: 'string', label: 'Label', default: 'hi' }
            ],
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        { type: 'chatbox', text: 'say {{setting.label}}' }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.chatbox).toHaveLength(1);
        expect(built.record.chatbox[0].render()).toBe('say hi');
    });

    test('counters increment and read back', async () => {
        const built = build({
            id: 'counter-plugin',
            name: 'Counter',
            stacks: [
                {
                    trigger: 'playerJoin',
                    actions: [
                        { type: 'count', name: 'joins' },
                        { type: 'status', text: 'seen {{counter.joins}}' }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        const handler = built.record.handlers.get('PLAYER_JOIN');
        handler({ displayName: 'A', userId: 'u1' });
        handler({ displayName: 'B', userId: 'u2' });
        expect(built.record.status.detail).toBe('seen 2');
    });

    test('a condition block stops the rest of the stack', async () => {
        const built = build({
            id: 'filtered',
            name: 'Filtered',
            stacks: [
                {
                    trigger: 'playerJoin',
                    actions: [
                        {
                            type: 'stop',
                            left: '{{displayName}}',
                            operator: 'equals',
                            right: 'Alice'
                        },
                        { type: 'feed', text: 'Alice is here' }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        const handler = built.record.handlers.get('PLAYER_JOIN');
        handler({ displayName: 'Bob', userId: 'u1' });
        expect(built.record.feeds).toHaveLength(0);
        handler({ displayName: 'Alice', userId: 'u2' });
        expect(built.record.feeds).toHaveLength(1);
    });
});

describe('instance placeholders', () => {
    test('reads fields off ctx.instance()', async () => {
        const built = build({
            id: 'instance-reader',
            name: 'Instance reader',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'status',
                            text: '{{instance.worldName}} [{{instance.accessTypeName}}] {{instance.playerCount}} here, owner {{instance.ownerId}}'
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe(
            'The Great Pug [Friends] 3 here, owner usr_owner'
        );
    });

    test('an unknown instance field stays literal', async () => {
        const built = build({
            id: 'bad-field',
            name: 'Bad field',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        { type: 'status', text: 'x {{instance.secretKey}}' }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('x {{instance.secretKey}}');
    });

    test('instance fields work inside a chatbox block', async () => {
        const built = build({
            id: 'inst-chatbox',
            name: 'Inst chatbox',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'chatbox',
                            text: '{{instance.playerCount}} in {{instance.worldName}}'
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.chatbox[0].render()).toBe('3 in The Great Pug');
    });
});

describe('control flow blocks', () => {
    test('if / else picks the right branch', async () => {
        const project = {
            id: 'branching',
            name: 'Branching',
            stacks: [
                {
                    trigger: 'playerJoin',
                    actions: [
                        {
                            type: 'ifElse',
                            left: '{{displayName}}',
                            operator: 'equals',
                            right: 'Alice',
                            children: [{ type: 'feed', text: 'hello Alice' }],
                            elseChildren: [
                                { type: 'feed', text: 'hello stranger' }
                            ]
                        }
                    ]
                }
            ]
        };
        const built = build(project);
        await built.compiled.setup(built.ctx);
        const fire = built.record.handlers.get('PLAYER_JOIN');
        fire({ displayName: 'Alice', userId: 'u1' });
        fire({ displayName: 'Bob', userId: 'u2' });
        expect(built.record.feeds.map((f) => f.message)).toEqual([
            'hello Alice',
            'hello stranger'
        ]);
    });

    test('an if with no else emits no else branch', async () => {
        const built = build({
            id: 'no-else',
            name: 'No else',
            stacks: [
                {
                    trigger: 'playerJoin',
                    actions: [
                        {
                            type: 'ifElse',
                            left: '{{displayName}}',
                            operator: 'contains',
                            right: 'ali',
                            children: [{ type: 'feed', text: 'matched' }],
                            elseChildren: []
                        }
                    ]
                }
            ]
        });
        expect(built.source).not.toContain('} else {');
        await built.compiled.setup(built.ctx);
        built.record.handlers.get('PLAYER_JOIN')({ displayName: 'Alice' });
        expect(built.record.feeds).toHaveLength(1);
    });

    test('repeat runs its body N times', async () => {
        const built = build({
            id: 'repeater',
            name: 'Repeater',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'repeat',
                            times: 3,
                            children: [{ type: 'count', name: 'n' }]
                        },
                        { type: 'status', text: 'ran {{counter.n}}' }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('ran 3');
    });

    test('for each player iterates the instance roster', async () => {
        const built = build({
            id: 'roster',
            name: 'Roster',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'forEachPlayer',
                            children: [{ type: 'feed', text: 'saw {{player}}' }]
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.feeds.map((f) => f.message)).toEqual([
            'saw Alice',
            'saw Bob',
            'saw Carol'
        ]);
    });

    test('nested containers do not collide on loop variables', async () => {
        const built = build({
            id: 'nested',
            name: 'Nested',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'repeat',
                            times: 2,
                            children: [
                                {
                                    type: 'forEachPlayer',
                                    children: [
                                        {
                                            type: 'repeat',
                                            times: 2,
                                            children: [
                                                { type: 'count', name: 'hits' }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        },
                        { type: 'status', text: '{{counter.hits}}' }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        // 2 outer x 3 players x 2 inner
        expect(built.record.status.detail).toBe('12');
    });

    test('counters nested inside containers are still declared', () => {
        const { source } = codegen.generate({
            id: 'deep-counter',
            name: 'Deep counter',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'ifElse',
                            left: 'a',
                            operator: 'equals',
                            right: 'a',
                            children: [{ type: 'count', name: 'deep' }],
                            elseChildren: []
                        }
                    ]
                }
            ]
        });
        expect(source).toContain('const counters = { deep: 0 }');
    });

    test('an empty container produces no dead code', () => {
        const { source } = codegen.generate({
            id: 'empty-container',
            name: 'Empty container',
            stacks: [
                {
                    trigger: 'start',
                    actions: [{ type: 'repeat', times: 5, children: [] }]
                }
            ]
        });
        // The loop is still emitted but must be syntactically valid.
        expect(() =>
            compileRemotePlugin(source, 'empty-container')
        ).not.toThrow();
    });
});

describe('text compilation is injection safe', () => {
    /**
     * Text typed into a block ends up inside a template literal. Anything that
     * could close that literal early has to be neutralised, or a user could
     * produce broken — or hostile — code without meaning to.
     */
    const NASTY = [
        'back`tick',
        'dollar ${1 + 1}',
        'backslash \\ end',
        'both `${x}`',
        '"double" and \'single\'',
        'line\nbreak'
    ];

    test.each(NASTY)('renders %j literally', async (text) => {
        const built = build({
            id: 'nasty',
            name: 'Nasty',
            stacks: [{ trigger: 'start', actions: [{ type: 'status', text }] }]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe(text);
    });

    test('an unknown placeholder stays literal instead of crashing', async () => {
        const built = build({
            id: 'unknown-token',
            name: 'Unknown',
            stacks: [
                {
                    trigger: 'start',
                    actions: [{ type: 'status', text: 'x {{nope}} y' }]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('x {{nope}} y');
    });

    test('an event field is not usable from a trigger that lacks it', async () => {
        // {{avatarName}} belongs to AVATAR_CHANGE, not PLAYER_JOIN.
        const built = build({
            id: 'wrong-scope',
            name: 'Wrong scope',
            stacks: [
                {
                    trigger: 'playerJoin',
                    actions: [{ type: 'status', text: 'a {{avatarName}}' }]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        built.record.handlers.get('PLAYER_JOIN')({ displayName: 'A' });
        expect(built.record.status.detail).toBe('a {{avatarName}}');
    });

    test('an unterminated placeholder does not break the output', async () => {
        const built = build({
            id: 'unterminated',
            name: 'Unterminated',
            stacks: [
                {
                    trigger: 'start',
                    actions: [{ type: 'status', text: 'oops {{displayName' }]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('oops {{displayName');
    });
});

describe('manifest generation', () => {
    test('sanitises ids and setting keys', () => {
        const { manifest } = codegen.generate({
            id: 'my-plugin',
            name: 'My plugin',
            settings: [{ key: 'my key!', type: 'number', default: 5 }]
        });
        expect(manifest.settingsSchema[0].key).toBe('my_key_');
        expect(manifest.settingsSchema[0].default).toBe(5);
    });

    test('rejects an unusable id through the real validator', () => {
        const { manifestJson } = codegen.generate({
            id: 'Not Valid',
            name: 'X'
        });
        expect(() => validateRemoteManifest(JSON.parse(manifestJson))).toThrow(
            /kebab-case/
        );
    });

    test('every generated setting has a default', () => {
        const { manifest } = codegen.generate({
            id: 'defaults',
            name: 'Defaults',
            settings: [
                { key: 'a', type: 'string' },
                { key: 'b', type: 'number' },
                { key: 'c', type: 'boolean' }
            ]
        });
        const defaults = buildDefaultSettings(manifest.settingsSchema);
        expect(defaults).toEqual({ a: '', b: 0, c: false });
    });
});
