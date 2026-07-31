import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
    clearChatboxSources,
    composeChatboxMessage,
    getChatboxSources,
    registerChatboxSource,
    renderChatboxSources
} from '../chatbox';

describe('chatbox source registry', () => {
    beforeEach(clearChatboxSources);

    test('sorts sources by order', () => {
        registerChatboxSource({ id: 'b', order: 20, render: () => 'b' });
        registerChatboxSource({ id: 'a', order: 10, render: () => 'a' });
        expect(getChatboxSources().map((s) => s.id)).toEqual(['a', 'b']);
    });

    test('unregisters via the returned function', () => {
        const off = registerChatboxSource({ id: 'a', render: () => 'a' });
        off();
        expect(getChatboxSources()).toHaveLength(0);
    });

    test('rejects a source without a render function', () => {
        expect(() => registerChatboxSource({ id: 'a' })).toThrow(TypeError);
    });

    test('skips empty and whitespace-only output', () => {
        registerChatboxSource({ id: 'a', order: 1, render: () => '  ' });
        registerChatboxSource({ id: 'b', order: 2, render: () => null });
        registerChatboxSource({ id: 'c', order: 3, render: () => ' hi ' });
        expect(renderChatboxSources()).toEqual([{ id: 'c', text: 'hi' }]);
    });

    test('a throwing source does not blank the others', () => {
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        registerChatboxSource({
            id: 'bad',
            order: 1,
            render: () => {
                throw new Error('boom');
            }
        });
        registerChatboxSource({ id: 'good', order: 2, render: () => 'ok' });

        expect(renderChatboxSources()).toEqual([{ id: 'good', text: 'ok' }]);
        consoleError.mockRestore();
    });
});

describe('composeChatboxMessage', () => {
    const lines = [
        { id: 'a', text: 'one' },
        { id: 'b', text: 'two' }
    ];

    test('joins every line in stack mode', () => {
        expect(
            composeChatboxMessage(lines, {
                mode: 'stack',
                separator: ' | ',
                maxLength: 144
            })
        ).toBe('one | two');
    });

    test('truncates to the max length', () => {
        expect(
            composeChatboxMessage(lines, {
                mode: 'stack',
                separator: ' | ',
                maxLength: 5
            })
        ).toBe('one |');
    });

    test('cycles one line at a time in rotate mode', () => {
        const rotate = (rotationIndex) =>
            composeChatboxMessage(lines, {
                mode: 'rotate',
                separator: ' | ',
                maxLength: 144,
                rotationIndex
            });
        expect(rotate(0)).toBe('one');
        expect(rotate(1)).toBe('two');
        expect(rotate(2)).toBe('one');
    });

    test('handles a negative rotation index', () => {
        expect(
            composeChatboxMessage(lines, {
                mode: 'rotate',
                separator: ' | ',
                maxLength: 144,
                rotationIndex: -1
            })
        ).toBe('two');
    });

    test('returns an empty string with no lines', () => {
        expect(
            composeChatboxMessage([], {
                mode: 'stack',
                separator: ' | ',
                maxLength: 144
            })
        ).toBe('');
    });
});
