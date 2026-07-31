import { describe, expect, test } from 'vitest';

import { buildDefaultSettings } from '../settingsSchema';
import { builtinPlugins } from '../plugins';
import { validateManifest } from '../registry';
import { entryToSearchableText, findKeyword } from '../plugins/keywordAlerts';
import { formatHours, localDayKey } from '../plugins/playtimeInsights';
import { formatSessionDuration } from '../plugins/chatboxSessionStats';
import { isWatched } from '../plugins/friendWatchlist';
import { moderationTypesFor } from '../plugins/instanceRadar';
import { readPath } from '../plugins/chatboxHeartRate';
import { weatherIcon } from '../plugins/chatboxWeather';

describe('built-in plugins', () => {
    test('every manifest is valid', () => {
        for (const plugin of builtinPlugins) {
            expect(() => validateManifest(plugin)).not.toThrow();
        }
    });

    test('ids are unique', () => {
        const ids = builtinPlugins.map((plugin) => plugin.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('every declared dependency exists', () => {
        const ids = new Set(builtinPlugins.map((plugin) => plugin.id));
        for (const plugin of builtinPlugins) {
            for (const dependency of plugin.requires ?? []) {
                expect(ids.has(dependency)).toBe(true);
            }
        }
    });

    test('every settings field has a usable default', () => {
        for (const plugin of builtinPlugins) {
            const defaults = buildDefaultSettings(plugin.settingsSchema);
            for (const field of plugin.settingsSchema ?? []) {
                expect(defaults[field.key]).toBeDefined();
            }
        }
    });

    test('nothing is enabled by default', () => {
        // Plugins are opt-in; a fresh install must behave exactly as before.
        expect(
            builtinPlugins.filter((plugin) => plugin.enabledByDefault)
        ).toHaveLength(0);
    });
});

describe('keyword alerts helpers', () => {
    test('collects the searchable fields of an entry', () => {
        expect(
            entryToSearchableText({
                displayName: 'Alice',
                videoName: 'Cool video',
                unrelated: 42
            })
        ).toBe('Alice Cool video');
    });

    test('matches case insensitively by default', () => {
        expect(findKeyword(['hello'], 'Say HELLO there', false)).toBe('hello');
        expect(findKeyword(['hello'], 'Say HELLO there', true)).toBeNull();
    });

    test('ignores blank keywords', () => {
        expect(findKeyword(['  ', ''], 'anything', false)).toBeNull();
    });
});

describe('friend watchlist helpers', () => {
    test('matches on display name or user id', () => {
        expect(isWatched(['alice'], 'Alice', 'usr_1')).toBe(true);
        expect(isWatched(['usr_1'], 'Alice', 'usr_1')).toBe(true);
        expect(isWatched(['bob'], 'Alice', 'usr_1')).toBe(false);
    });

    test('an empty watchlist matches nothing', () => {
        expect(isWatched([], 'Alice', 'usr_1')).toBe(false);
    });
});

describe('instance radar helpers', () => {
    test('only returns moderations you applied', () => {
        const moderations = new Map([
            ['1', { type: 'block', targetUserId: 'usr_b', sourceUserId: 'me' }],
            ['2', { type: 'mute', targetUserId: 'usr_b', sourceUserId: 'me' }],
            [
                '3',
                { type: 'block', targetUserId: 'usr_b', sourceUserId: 'other' }
            ]
        ]);
        expect(moderationTypesFor(moderations, 'me', 'usr_b')).toEqual([
            'block',
            'mute'
        ]);
        expect(moderationTypesFor(moderations, 'me', 'usr_c')).toEqual([]);
    });
});

describe('heart rate helpers', () => {
    test('reads a dotted path', () => {
        expect(readPath({ data: { heartRate: 72 } }, 'data.heartRate')).toBe(
            72
        );
    });

    test('returns undefined for a missing path instead of throwing', () => {
        expect(readPath({}, 'a.b.c')).toBeUndefined();
    });
});

describe('weather helpers', () => {
    test('maps WMO codes to icons', () => {
        expect(weatherIcon(0)).toBe('☀️');
        expect(weatherIcon(3)).toBe('☁️');
        expect(weatherIcon(95)).toBe('⛈️');
    });
});

describe('duration formatting', () => {
    test('session duration switches to hours past 60 minutes', () => {
        expect(formatSessionDuration(0)).toBe('0m');
        expect(formatSessionDuration(90 * 60000)).toBe('1h30m');
        expect(formatSessionDuration(45 * 60000)).toBe('45m');
    });

    test('playtime formatting switches unit at one hour', () => {
        expect(formatHours(30 * 60000)).toBe('30m');
        expect(formatHours(5400000)).toBe('1.5h');
    });

    test('day key is local and zero padded', () => {
        expect(localDayKey(new Date(2024, 0, 5))).toBe('2024-01-05');
    });
});
