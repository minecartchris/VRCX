import { describe, expect, test } from 'vitest';

import {
    buildMixedPage,
    extractKeywords,
    filterNewAvatars,
    interleaveByAuthor,
    pickKeywords,
    pickTopAuthors,
    pruneSeen,
    sortByRecent,
    toTimestamp,
    uploadedAt
} from '../recommendations';

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

describe('pickTopAuthors with no limit', () => {
    test('returns every author when limit is 0', () => {
        const history = Array.from({ length: 8 }, (_, i) => entry({ id: `avtr_${i}`, authorId: `usr_${i}` }));
        expect(pickTopAuthors(history, [], { limit: 0 })).toHaveLength(8);
    });
});

describe('extractKeywords', () => {
    test('keeps descriptive words and drops filler, numbers and platform markers', () => {
        expect(extractKeywords('Kitsune Fox V2 [Quest] Avatar')).toEqual(['kitsune', 'fox']);
    });

    test('handles non-latin names', () => {
        expect(extractKeywords('きつね 狐狸狐')).toEqual(['きつね', '狐狸狐']);
    });

    test('returns nothing for non-strings', () => {
        expect(extractKeywords(undefined)).toEqual([]);
    });
});

describe('pickKeywords', () => {
    test('weights words by time worn', () => {
        const history = [
            entry({ id: 'avtr_1', name: 'Protogen', timeSpent: 5 * 60000 }),
            entry({ id: 'avtr_2', name: 'Kitsune', timeSpent: 500 * 60000 })
        ];
        expect(pickKeywords(history, [])).toEqual(['kitsune', 'protogen']);
    });

    test('counts a word once per avatar', () => {
        const history = [
            entry({ id: 'avtr_1', name: 'Fox Fox Fox', timeSpent: 10 * 60000 }),
            entry({ id: 'avtr_2', name: 'Cat', timeSpent: 20 * 60000 })
        ];
        expect(pickKeywords(history, [])[0]).toBe('cat');
    });

    test('uses favorites and their author tags', () => {
        const favorites = [{ ref: { name: 'Something', tags: ['author_tag_kemono', 'content_sex'] } }];
        const words = pickKeywords([], favorites);
        expect(words).toContain('kemono');
        expect(words).not.toContain('content');
    });

    test('respects the limit', () => {
        const history = [entry({ name: 'alpha bravo charlie delta' })];
        expect(pickKeywords(history, [], { limit: 2 })).toHaveLength(2);
        expect(pickKeywords(history, [], { limit: 0 })).toHaveLength(4);
    });
});

describe('interleaveByAuthor', () => {
    test('alternates creators while keeping each one in order', () => {
        const avatars = [
            { id: 'a1', authorId: 'a' },
            { id: 'a2', authorId: 'a' },
            { id: 'a3', authorId: 'a' },
            { id: 'b1', authorId: 'b' },
            { id: 'c1', authorId: 'c' }
        ];
        expect(interleaveByAuthor(avatars).map((a) => a.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'a3']);
    });

    test('tolerates junk input', () => {
        expect(interleaveByAuthor(undefined)).toEqual([]);
    });
});

describe('filterNewAvatars with excluded creators', () => {
    test('drops avatars by those creators', () => {
        const result = filterNewAvatars(
            [
                { id: 'a1', authorId: 'known' },
                { id: 'b1', authorId: 'stranger' }
            ],
            [],
            { excludeAuthorIds: ['known'] }
        );
        expect(result.map((a) => a.id)).toEqual(['b1']);
    });
});

describe('uploadedAt', () => {
    test('uses whichever of created and updated is later', () => {
        expect(uploadedAt({ created_at: '2025-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })).toBe(NOW);
        expect(uploadedAt({ created_at: '2026-01-01T00:00:00Z' })).toBe(NOW);
    });

    test('treats the provider placeholder date as unknown', () => {
        expect(uploadedAt({ created_at: '0001-01-01T00:00:00.0000000Z' })).toBe(0);
        expect(uploadedAt(undefined)).toBe(0);
    });
});

describe('sortByRecent', () => {
    test('puts the newest uploads first and keeps undated ones in order', () => {
        const avatars = [
            { id: 'undated1' },
            { id: 'old', updated_at: '2024-01-01T00:00:00Z' },
            { id: 'new', updated_at: '2026-01-01T00:00:00Z' },
            { id: 'undated2' }
        ];
        expect(sortByRecent(avatars).map((a) => a.id)).toEqual(['new', 'old', 'undated1', 'undated2']);
    });
});

describe('pruneSeen', () => {
    test('forgets avatars shown longer ago than the cutoff', () => {
        const seen = { recent: NOW - 5 * DAY, stale: NOW - 31 * DAY, junk: 'x' };
        expect(pruneSeen(seen, { now: NOW, maxAgeDays: 30 })).toEqual({ recent: NOW - 5 * DAY });
    });

    test('tolerates junk input', () => {
        expect(pruneSeen(null)).toEqual({});
    });
});

describe('buildMixedPage', () => {
    test('alternates familiar and new creators', () => {
        const familiar = [
            { id: 'f1', authorId: 'a' },
            { id: 'f2', authorId: 'b' }
        ];
        const discovery = [
            { id: 'd1', authorId: 'x' },
            { id: 'd2', authorId: 'y' }
        ];
        const { page } = buildMixedPage(familiar, discovery, { size: 4 });
        expect(page.map((a) => a.id)).toEqual(['f1', 'd1', 'f2', 'd2']);
    });

    test('fills from the other side when one runs dry, and returns the rest', () => {
        const familiar = [{ id: 'f1', authorId: 'a' }];
        const discovery = [
            { id: 'd1', authorId: 'x' },
            { id: 'd2', authorId: 'y' },
            { id: 'd3', authorId: 'z' }
        ];
        const result = buildMixedPage(familiar, discovery, { size: 3 });
        expect(result.page.map((a) => a.id)).toEqual(['f1', 'd1', 'd2']);
        expect(result.familiar).toEqual([]);
        expect(result.discovery.map((a) => a.id)).toEqual(['d3']);
    });

    test('spreads one creator out instead of stacking their uploads', () => {
        const familiar = [
            { id: 'a1', authorId: 'a' },
            { id: 'a2', authorId: 'a' },
            { id: 'a3', authorId: 'a' },
            { id: 'b1', authorId: 'b' },
            { id: 'c1', authorId: 'c' }
        ];
        const { page } = buildMixedPage(familiar, [], { size: 5, gap: 2 });
        expect(page.map((a) => a.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'a3']);
    });

    test('does not modify the queues it was given', () => {
        const familiar = [{ id: 'f1', authorId: 'a' }];
        buildMixedPage(familiar, [], { size: 1 });
        expect(familiar).toHaveLength(1);
    });
});
