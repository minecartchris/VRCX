import { describe, expect, test } from 'vitest';

import {
    buildDefaultSettings,
    coerceValue,
    isFieldVisible,
    normalizeSettings
} from '../settingsSchema';

const schema = [
    { key: 'enabled', type: 'boolean', default: true },
    { key: 'port', type: 'number', default: 9000, min: 1, max: 65535 },
    { key: 'label', type: 'string', default: 'hello' },
    {
        key: 'mode',
        type: 'select',
        default: 'a',
        options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' }
        ]
    },
    { key: 'items', type: 'list', default: ['x'] },
    { key: 'picks', type: 'multiselect', default: [] }
];

describe('buildDefaultSettings', () => {
    test('uses declared defaults', () => {
        expect(buildDefaultSettings(schema)).toEqual({
            enabled: true,
            port: 9000,
            label: 'hello',
            mode: 'a',
            items: ['x'],
            picks: []
        });
    });

    test('falls back per type when no default is declared', () => {
        expect(
            buildDefaultSettings([
                { key: 'a', type: 'boolean' },
                { key: 'b', type: 'number', min: 5 },
                { key: 'c', type: 'string' },
                { key: 'd', type: 'list' },
                {
                    key: 'e',
                    type: 'select',
                    options: [{ value: 'z', label: 'Z' }]
                }
            ])
        ).toEqual({ a: false, b: 5, c: '', d: [], e: 'z' });
    });

    test('tolerates a missing schema', () => {
        expect(buildDefaultSettings(undefined)).toEqual({});
    });
});

describe('coerceValue', () => {
    test('clamps numbers into range', () => {
        const field = { key: 'port', type: 'number', min: 1, max: 10 };
        expect(coerceValue(field, 50)).toBe(10);
        expect(coerceValue(field, -3)).toBe(1);
    });

    test('repairs a non numeric value with the default', () => {
        const field = { key: 'port', type: 'number', default: 7 };
        expect(coerceValue(field, 'not a number')).toBe(7);
    });

    test('rejects select values outside the option list', () => {
        const field = schema.find((f) => f.key === 'mode');
        expect(coerceValue(field, 'b')).toBe('b');
        expect(coerceValue(field, 'nope')).toBe('a');
    });

    test('copies arrays instead of aliasing them', () => {
        const field = { key: 'items', type: 'list', default: [] };
        const source = ['a'];
        const result = coerceValue(field, source);
        result.push('b');
        expect(source).toEqual(['a']);
    });
});

describe('normalizeSettings', () => {
    test('merges stored values over defaults', () => {
        expect(normalizeSettings(schema, { port: 9001, label: 'hi' })).toEqual({
            enabled: true,
            port: 9001,
            label: 'hi',
            mode: 'a',
            items: ['x'],
            picks: []
        });
    });

    test('drops keys that are no longer in the schema', () => {
        const result = normalizeSettings(schema, { removed: 1 });
        expect(result).not.toHaveProperty('removed');
    });

    test('repairs values whose type drifted', () => {
        expect(
            normalizeSettings(schema, { port: 'abc', items: 'nope' })
        ).toMatchObject({
            port: 9000,
            items: ['x']
        });
    });
});

describe('isFieldVisible', () => {
    test('defaults to visible without a predicate', () => {
        expect(isFieldVisible({ key: 'a', type: 'string' }, {})).toBe(true);
    });

    test('honours the predicate', () => {
        const field = {
            key: 'a',
            type: 'string',
            visibleWhen: (settings) => settings.enabled
        };
        expect(isFieldVisible(field, { enabled: true })).toBe(true);
        expect(isFieldVisible(field, { enabled: false })).toBe(false);
    });

    test('stays visible when the predicate throws', () => {
        const field = {
            key: 'a',
            type: 'string',
            visibleWhen: () => {
                throw new Error('boom');
            }
        };
        expect(isFieldVisible(field, {})).toBe(true);
    });
});
