import { describe, expect, test } from 'vitest';

import { buildDefaultSettings } from '../settingsSchema';
import { builtinPlugins } from '../plugins';
import { validateManifest } from '../registry';
import { entryToSearchableText, findKeyword } from '../plugins/keywordAlerts';
import {
    formatChange,
    normalizeAvatarChange,
    pushHistory,
    shouldRecord
} from '../plugins/avatarChangeLog';
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

describe('avatar change log helpers', () => {
    test('normalizes a full photon payload', () => {
        const record = normalizeAvatarChange({
            userId: 'usr_1',
            displayName: 'Alice',
            avatarName: 'CoolAvatar',
            avatarId: 'avtr_1',
            authorId: 'usr_2',
            createdAt: '2024-01-05T10:00:00.000Z'
        });
        expect(record).toEqual({
            userId: 'usr_1',
            displayName: 'Alice',
            avatarName: 'CoolAvatar',
            avatarId: 'avtr_1',
            authorId: 'usr_2',
            at: Date.parse('2024-01-05T10:00:00.000Z')
        });
    });

    test('fills in the gaps left by the log-file parser', () => {
        const record = normalizeAvatarChange(
            { displayName: 'Alice', avatarName: 'CoolAvatar' },
            1000
        );
        expect(record.avatarId).toBe('');
        expect(record.authorId).toBe('');
        expect(record.at).toBe(1000);
    });

    test('rejects an entry that identifies nobody', () => {
        expect(normalizeAvatarChange({ avatarName: 'X' })).toBeNull();
        expect(normalizeAvatarChange(null)).toBeNull();
    });

    test('rate limits repeat changes by the same person', () => {
        const lastSeen = new Map();
        const base = { userId: 'usr_1', displayName: 'Alice' };
        expect(shouldRecord(lastSeen, { ...base, at: 0 }, 10000)).toBe(true);
        expect(shouldRecord(lastSeen, { ...base, at: 5000 }, 10000)).toBe(
            false
        );
        expect(shouldRecord(lastSeen, { ...base, at: 10000 }, 10000)).toBe(
            true
        );
    });

    test('rate limits each person independently', () => {
        const lastSeen = new Map();
        expect(shouldRecord(lastSeen, { userId: 'usr_1', at: 0 }, 10000)).toBe(
            true
        );
        expect(shouldRecord(lastSeen, { userId: 'usr_2', at: 0 }, 10000)).toBe(
            true
        );
    });

    test('falls back to display name when there is no user id', () => {
        const lastSeen = new Map();
        const record = { userId: '', displayName: 'Alice', at: 0 };
        expect(shouldRecord(lastSeen, record, 10000)).toBe(true);
        expect(shouldRecord(lastSeen, { ...record, at: 1 }, 10000)).toBe(false);
    });

    test('history keeps the newest entries within the limit', () => {
        let history = [];
        for (let i = 0; i < 5; i += 1) {
            history = pushHistory(history, { at: i }, 3);
        }
        expect(history.map((entry) => entry.at)).toEqual([2, 3, 4]);
    });

    test('history tolerates a corrupt stored value', () => {
        expect(pushHistory(null, { at: 1 }, 10)).toEqual([{ at: 1 }]);
    });

    test('formats with and without an avatar name', () => {
        expect(
            formatChange({ displayName: 'Alice', avatarName: 'CoolAvatar' })
        ).toBe('Alice → CoolAvatar');
        expect(formatChange({ displayName: 'Alice', avatarName: '' })).toBe(
            'Alice changed avatar'
        );
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
