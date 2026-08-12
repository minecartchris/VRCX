import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import {
    compileRemotePlugin,
    validateBundle,
    validateRemoteManifest
} from '../remote';
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
        apiCalls: [],
        invites: [],
        friends: [
            {
                userId: 'usr_a',
                displayName: 'Alice',
                status: 'active',
                location: 'wrld_1',
                isOnline: true,
                isFavorite: true
            },
            {
                userId: 'usr_b',
                displayName: 'Bob',
                status: 'offline',
                location: 'offline',
                isOnline: false,
                isFavorite: false
            }
        ],
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
            friends: () => record.friends,
            api: (endpoint, options) => {
                record.apiCalls.push({ endpoint, options });
                return Promise.resolve({});
            },
            inviteToGroup: (groupId, userId) => {
                record.invites.push({ groupId, userId });
                return Promise.resolve({});
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

describe('friend list blocks', () => {
    test('iterates every friend with name and id available', async () => {
        const built = build({
            id: 'friend-loop',
            name: 'Friend loop',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'forEachFriend',
                            children: [
                                {
                                    type: 'feed',
                                    text: '{{friend}} ({{friendId}})'
                                }
                            ]
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.feeds.map((f) => f.message)).toEqual([
            'Alice (usr_a)',
            'Bob (usr_b)'
        ]);
    });

    test('can filter to online friends only', async () => {
        const built = build({
            id: 'online-only',
            name: 'Online only',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'forEachFriend',
                            only: 'online',
                            children: [{ type: 'feed', text: '{{friend}}' }]
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.feeds.map((f) => f.message)).toEqual(['Alice']);
    });

    test('can filter to favourites only', async () => {
        const built = build({
            id: 'favs-only',
            name: 'Favs only',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'forEachFriend',
                            only: 'favorites',
                            children: [{ type: 'feed', text: '{{friend}}' }]
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.feeds.map((f) => f.message)).toEqual(['Alice']);
    });
});

describe('list variables', () => {
    test('adds, reads and counts a list', async () => {
        const built = build({
            id: 'list-basics',
            name: 'List basics',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        { type: 'listAdd', name: 'seen', text: 'one' },
                        { type: 'listAdd', name: 'seen', text: 'two' },
                        {
                            type: 'status',
                            text: '{{list.seen.count}}: {{list.seen}}'
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('2: one, two');
    });

    test('empties a list', async () => {
        const built = build({
            id: 'list-clear',
            name: 'List clear',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        { type: 'listAdd', name: 'x', text: 'a' },
                        { type: 'listClear', name: 'x' },
                        { type: 'status', text: 'n={{list.x.count}}' }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('n=0');
    });

    test('loops over a list', async () => {
        const built = build({
            id: 'list-loop',
            name: 'List loop',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        { type: 'listAdd', name: 'names', text: 'a' },
                        { type: 'listAdd', name: 'names', text: 'b' },
                        {
                            type: 'forEachItem',
                            name: 'names',
                            children: [{ type: 'feed', text: 'item {{item}}' }]
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.feeds.map((f) => f.message)).toEqual([
            'item a',
            'item b'
        ]);
    });

    test('collecting friends into a list then looping it works', async () => {
        const built = build({
            id: 'collect',
            name: 'Collect',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'forEachFriend',
                            only: 'online',
                            children: [
                                {
                                    type: 'listAdd',
                                    name: 'online',
                                    text: '{{friend}}'
                                }
                            ]
                        },
                        { type: 'status', text: 'online: {{list.online}}' }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('online: Alice');
    });

    test('an unknown list name stays literal', async () => {
        const built = build({
            id: 'bad-list',
            name: 'Bad list',
            stacks: [
                {
                    trigger: 'start',
                    actions: [{ type: 'status', text: '{{list.nothing}}' }]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('{{list.nothing}}');
    });

    test('mutating a list while looping it does not loop forever', async () => {
        const built = build({
            id: 'self-append',
            name: 'Self append',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        { type: 'listAdd', name: 'q', text: 'a' },
                        {
                            type: 'forEachItem',
                            name: 'q',
                            children: [
                                { type: 'listAdd', name: 'q', text: 'more' }
                            ]
                        },
                        { type: 'status', text: '{{list.q.count}}' }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('2');
    });
});

describe('VRChat blocks', () => {
    test('group invite passes group and user through', async () => {
        const built = build({
            id: 'inviter',
            name: 'Inviter',
            settings: [
                {
                    key: 'groupId',
                    type: 'string',
                    label: 'Group',
                    default: 'grp_123'
                }
            ],
            stacks: [
                {
                    trigger: 'playerJoin',
                    actions: [
                        {
                            type: 'groupInvite',
                            groupId: '{{setting.groupId}}',
                            userId: '{{userId}}'
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        built.record.handlers.get('PLAYER_JOIN')({
            displayName: 'Alice',
            userId: 'usr_a'
        });
        expect(built.record.invites).toEqual([
            { groupId: 'grp_123', userId: 'usr_a' }
        ]);
    });

    test('api call uses the chosen method', async () => {
        const built = build({
            id: 'api-caller',
            name: 'Api caller',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'apiCall',
                            endpoint: 'users/{{instance.ownerId}}',
                            method: 'GET'
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        expect(built.record.apiCalls).toEqual([
            { endpoint: 'users/usr_owner', options: { method: 'GET' } }
        ]);
    });

    test('an unrecognised method falls back to GET', () => {
        const { source } = codegen.generate({
            id: 'bad-method',
            name: 'Bad method',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'apiCall',
                            endpoint: 'x',
                            method: 'DROP TABLE'
                        }
                    ]
                }
            ]
        });
        expect(source).toContain('method: "GET"');
    });

    test('a failed API call does not abort the rest of the stack', async () => {
        const built = build({
            id: 'resilient',
            name: 'Resilient',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        { type: 'apiCall', endpoint: 'boom', method: 'GET' },
                        { type: 'status', text: 'still running' }
                    ]
                }
            ]
        });
        built.ctx.api = () => Promise.reject(new Error('nope'));
        await built.compiled.setup(built.ctx);
        expect(built.record.status.detail).toBe('still running');
    });
});

describe('and / or conditions', () => {
    /**
     * @param {object} condition extra fields for the if block
     */
    async function runIf(condition, event) {
        const built = build({
            id: 'cond',
            name: 'Cond',
            stacks: [
                {
                    trigger: 'playerJoin',
                    actions: [
                        Object.assign(
                            {
                                type: 'ifElse',
                                children: [{ type: 'feed', text: 'yes' }],
                                elseChildren: [{ type: 'feed', text: 'no' }]
                            },
                            condition
                        )
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        built.record.handlers.get('PLAYER_JOIN')(event);
        return built.record.feeds.at(-1).message;
    }

    const AND = {
        join: 'and',
        conditions: [
            { left: '{{displayName}}', operator: 'contains', right: 'a' },
            { left: '{{userId}}', operator: 'notEmpty' }
        ]
    };

    test('and requires every clause', async () => {
        expect(await runIf(AND, { displayName: 'Alice', userId: 'u' })).toBe(
            'yes'
        );
        expect(await runIf(AND, { displayName: 'Alice', userId: '' })).toBe(
            'no'
        );
        expect(await runIf(AND, { displayName: 'Bob', userId: 'u' })).toBe(
            'no'
        );
    });

    test('or needs only one clause', async () => {
        const OR = { ...AND, join: 'or' };
        expect(await runIf(OR, { displayName: 'Bob', userId: 'u' })).toBe(
            'yes'
        );
        expect(await runIf(OR, { displayName: 'Bob', userId: '' })).toBe('no');
    });

    test('the old single clause shape still works', async () => {
        expect(
            await runIf(
                { left: '{{displayName}}', operator: 'equals', right: 'Alice' },
                { displayName: 'Alice' }
            )
        ).toBe('yes');
    });

    test('numeric comparisons compare as numbers', async () => {
        const built = build({
            id: 'numeric',
            name: 'Numeric',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'ifElse',
                            join: 'and',
                            conditions: [
                                {
                                    left: '{{instance.playerCount}}',
                                    operator: 'greater',
                                    right: '2'
                                }
                            ],
                            children: [{ type: 'status', text: 'busy' }],
                            elseChildren: [{ type: 'status', text: 'quiet' }]
                        }
                    ]
                }
            ]
        });
        await built.compiled.setup(built.ctx);
        // 3 players, and "10" > "9" must not be compared as strings
        expect(built.record.status.detail).toBe('busy');
    });

    test('a clause group is parenthesised so negation stays correct', () => {
        const { source } = codegen.generate({
            id: 'negate',
            name: 'Negate',
            stacks: [
                {
                    trigger: 'playerJoin',
                    actions: [
                        {
                            type: 'stop',
                            join: 'or',
                            conditions: [
                                { left: 'a', operator: 'equals', right: 'b' },
                                { left: 'c', operator: 'equals', right: 'd' }
                            ]
                        }
                    ]
                }
            ]
        });
        expect(source).toContain('if (!((`a` === `b` || `c` === `d`)))');
    });

    test('an empty condition list is treated as true', () => {
        const { source } = codegen.generate({
            id: 'empty-cond',
            name: 'Empty cond',
            stacks: [
                {
                    trigger: 'start',
                    actions: [
                        {
                            type: 'ifElse',
                            conditions: [],
                            children: [{ type: 'status', text: 'x' }],
                            elseChildren: []
                        }
                    ]
                }
            ]
        });
        expect(source).toContain('if (true)');
    });
});

describe('single file bundle', () => {
    test('bundles the manifest and source into one file', () => {
        const { bundle, manifest, source } = codegen.generate({
            id: 'bundled',
            name: 'Bundled',
            stacks: [
                {
                    trigger: 'start',
                    actions: [{ type: 'status', text: 'hi' }]
                }
            ]
        });
        const parsed = JSON.parse(bundle);
        expect(parsed.vrcxPlugin).toBe(1);
        expect(parsed.manifest).toEqual(manifest);
        expect(parsed.source).toBe(source);
    });

    test('the bundle passes the importer validator and runs', async () => {
        const { bundle } = codegen.generate({
            id: 'bundled-run',
            name: 'Bundled run',
            stacks: [
                {
                    trigger: 'start',
                    actions: [{ type: 'status', text: 'from a bundle' }]
                }
            ]
        });
        const { manifest, source } = validateBundle(JSON.parse(bundle));
        const compiled = compileRemotePlugin(source, manifest.id);
        const { ctx, record } = fakeContext(
            buildDefaultSettings(manifest.settingsSchema)
        );
        await compiled.setup(ctx);
        expect(record.status.detail).toBe('from a bundle');
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
