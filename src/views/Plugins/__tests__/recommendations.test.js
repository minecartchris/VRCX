import { describe, expect, test } from 'vitest';

import { filterNewAvatars, formatAge, pickTopAuthors, rankRediscoveries, toTimestamp } from '../recommendations';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const DAY = 86400000;

/**
 * @param {object} overrides
 * @returns {object}
 */
function entry(overrides) {
    return {
        id: 'avtr_x',
        name: 'Avatar',
        authorId: 'usr_a',
        timeSpent: 60 * 60000,
        lastWornAt: new Date(NOW - 100 * DAY).toISOString(),
        ...overrides
    };
}

describe('toTimestamp', () => {
    test('passes through finite numbers', () => {
        expect(toTimestamp(123)).toBe(123);
    });

    test('parses ISO strings', () => {
        expect(toTimestamp('2026-01-01T00:00:00Z')).toBe(NOW);
    });

    test('returns 0 for junk', () => {
        expect(toTimestamp('not a date')).toBe(0);
        expect(toTimestamp(undefined)).toBe(0);
        expect(toTimestamp(NaN)).toBe(0);
    });
});

describe('rankRediscoveries', () => {
    test('ranks longer-worn avatars first', () => {
        const result = rankRediscoveries(
            [entry({ id: 'a', timeSpent: 30 * 60000 }), entry({ id: 'b', timeSpent: 600 * 60000 })],
            { now: NOW }
        );
        expect(result.map((r) => r.id)).toEqual(['b', 'a']);
    });

    test('breaks a tie towards the one left alone longer', () => {
        const result = rankRediscoveries(
            [
                entry({ id: 'recent', lastWornAt: new Date(NOW - 20 * DAY).toISOString() }),
                entry({ id: 'old', lastWornAt: new Date(NOW - 300 * DAY).toISOString() })
            ],
            { now: NOW }
        );
        expect(result[0].id).toBe('old');
    });

    test('skips avatars worn too recently to be a rediscovery', () => {
        const result = rankRediscoveries([entry({ lastWornAt: new Date(NOW - 2 * DAY).toISOString() })], { now: NOW });
        expect(result).toEqual([]);
    });

    test('skips avatars with no recorded time worn', () => {
        expect(rankRediscoveries([entry({ timeSpent: 0 })], { now: NOW })).toEqual([]);
    });

    test('skips avatars with an unusable timestamp rather than guessing', () => {
        expect(rankRediscoveries([entry({ lastWornAt: '' })], { now: NOW })).toEqual([]);
    });

    test('honours excludeIds', () => {
        const result = rankRediscoveries([entry({ id: 'worn-now' })], {
            now: NOW,
            excludeIds: ['worn-now']
        });
        expect(result).toEqual([]);
    });

    test('deduplicates repeated ids', () => {
        const result = rankRediscoveries([entry({ id: 'dupe' }), entry({ id: 'dupe' })], {
            now: NOW
        });
        expect(result).toHaveLength(1);
    });

    test('respects the limit', () => {
        const many = Array.from({ length: 50 }, (_, i) => entry({ id: `a${i}` }));
        expect(rankRediscoveries(many, { now: NOW, limit: 5 })).toHaveLength(5);
    });

    test('tolerates a missing history', () => {
        expect(rankRediscoveries(undefined, { now: NOW })).toEqual([]);
    });
});

describe('pickTopAuthors', () => {
    test('orders authors by time worn', () => {
        const authors = pickTopAuthors(
            [
                entry({ authorId: 'usr_small', timeSpent: 10 * 60000 }),
                entry({ authorId: 'usr_big', timeSpent: 900 * 60000 })
            ],
            []
        );
        expect(authors[0]).toBe('usr_big');
    });

    test('counts favorites even with no history', () => {
        expect(pickTopAuthors([], [{ authorId: 'usr_fav' }])).toEqual(['usr_fav']);
    });

    test('reads an author off a nested favorite ref', () => {
        expect(pickTopAuthors([], [{ ref: { authorId: 'usr_nested' } }])).toEqual(['usr_nested']);
    });

    test('excludes your own id', () => {
        const authors = pickTopAuthors([entry({ authorId: 'me' })], [], {
            excludeAuthorId: 'me'
        });
        expect(authors).toEqual([]);
    });

    test('respects the limit', () => {
        const history = Array.from({ length: 20 }, (_, i) => entry({ authorId: `usr_${i}`, timeSpent: i * 60000 }));
        expect(pickTopAuthors(history, [], { limit: 3 })).toHaveLength(3);
    });
});

describe('filterNewAvatars', () => {
    test('drops avatars you already have', () => {
        const result = filterNewAvatars([{ id: 'known' }, { id: 'fresh' }], new Set(['known']));
        expect(result.map((a) => a.id)).toEqual(['fresh']);
    });

    test('drops non-public avatars', () => {
        const result = filterNewAvatars([{ id: 'a', releaseStatus: 'private' }], []);
        expect(result).toEqual([]);
    });

    test('deduplicates', () => {
        const result = filterNewAvatars([{ id: 'a' }, { id: 'a' }], []);
        expect(result).toHaveLength(1);
    });

    test('respects the limit', () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}` }));
        expect(filterNewAvatars(many, [], { limit: 4 })).toHaveLength(4);
    });

    test('tolerates a nullish candidate list', () => {
        expect(filterNewAvatars(null, [])).toEqual([]);
    });
});

describe('formatAge', () => {
    test('describes days, months and years', () => {
        expect(formatAge(0.5)).toBe('today');
        expect(formatAge(1)).toBe('1 day');
        expect(formatAge(12)).toBe('12 days');
        expect(formatAge(60)).toBe('2 months');
        expect(formatAge(400)).toBe('1.1 years');
    });
});
