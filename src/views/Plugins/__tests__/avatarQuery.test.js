import { describe, expect, test } from 'vitest';

import {
    jaccard,
    parseQuery,
    runQuery,
    searchAvatars,
    searchableText,
    tokenizeQuery,
    trigramSimilarity
} from '../avatarQuery';

const avatars = [
    {
        id: 'avtr_1',
        name: 'Neon Fox',
        description: 'A glowing kemono fox',
        authorName: 'Creator A',
        authorId: 'usr_a',
        tags: ['fox', 'kemono'],
        aiTags: ['neon', 'glowing_eyes'],
        created_at: '2024-01-01',
        updated_at: '2024-06-01'
    },
    {
        id: 'avtr_2',
        name: 'Cat Ears Girl',
        description: 'cute nsfw variant',
        authorName: 'Creator B',
        authorId: 'usr_b',
        tags: ['cat_ears'],
        aiTags: ['cute'],
        created_at: '2023-01-01',
        updated_at: '2023-06-01'
    },
    {
        id: 'avtr_3',
        name: 'Protogen',
        description: 'robot friend',
        authorName: 'Creator A',
        authorId: 'usr_a',
        tags: ['protogen', 'robot'],
        aiTags: [],
        created_at: '2025-01-01',
        updated_at: '2025-06-01'
    }
];

/**
 * @param {string} query
 * @returns {string[]} matching ids, in result order
 */
function ids(query, options) {
    return searchAvatars(avatars, query, options).map((a) => a.id);
}

describe('tokenizeQuery', () => {
    test('keeps parenthesised groups together', () => {
        expect(tokenizeQuery('tag:any(a, b) cute')).toEqual([
            'tag:any(a, b)',
            'cute'
        ]);
    });

    test('keeps quoted phrases together', () => {
        expect(tokenizeQuery('"cat ears" fox')).toEqual(['cat ears', 'fox']);
    });

    test('tolerates an unclosed group', () => {
        expect(() => tokenizeQuery('tag:any(a,')).not.toThrow();
    });
});

describe('parseQuery', () => {
    test('separates includes and excludes', () => {
        const plan = parseQuery('cute -nsfw');
        expect(plan.include).toEqual(['cute']);
        expect(plan.exclude).toEqual(['nsfw']);
    });

    test('parses any/all field groups', () => {
        const plan = parseQuery('tag:any(fox, cat) aiTag:all(neon, glowing_eyes)');
        expect(plan.fields).toEqual([
            { field: 'tags', mode: 'any', values: ['fox', 'cat'] },
            {
                field: 'aiTags',
                mode: 'all',
                values: ['neon', 'glowing_eyes']
            }
        ]);
    });

    test('parses a bare field as an exact-ish single value', () => {
        expect(parseQuery('author:someone').fields).toEqual([
            { field: 'author', mode: 'all', values: ['someone'] }
        ]);
    });

    test('clamps the fuzzy threshold into 0..1', () => {
        expect(parseQuery('fuzzy:5 x').fuzzy).toBe(1);
        expect(parseQuery('fuzzy:-2 x').fuzzy).toBe(0);
    });

    test('parses sort directives in order', () => {
        const plan = parseQuery('sort:updatedAt(desc) sort:name(asc)');
        expect(plan.sorts).toEqual([
            { field: 'updated_at', direction: 'desc' },
            { field: 'name', direction: 'asc' }
        ]);
    });

    test('defaults a sort without a direction to ascending', () => {
        expect(parseQuery('sort:name').sorts).toEqual([
            { field: 'name', direction: 'asc' }
        ]);
    });

    test('ignores an unknown sort field', () => {
        expect(parseQuery('sort:nonsense(asc)').sorts).toEqual([]);
    });

    test('parses similar-to-tags', () => {
        expect(parseQuery('similar to tags fox, kemono').similarTags).toEqual([
            'fox',
            'kemono'
        ]);
    });

    test('treats and/or as joiners rather than search terms', () => {
        expect(parseQuery('fox and robot').include).toEqual(['fox', 'robot']);
    });
});

describe('searchAvatars', () => {
    test('returns everything for an empty query', () => {
        expect(ids('')).toHaveLength(3);
    });

    test('matches free text across fields', () => {
        expect(ids('kemono')).toEqual(['avtr_1']);
    });

    test('requires every positive term', () => {
        expect(ids('fox robot')).toEqual([]);
    });

    test('excludes with a leading minus', () => {
        expect(ids('cute -nsfw')).toEqual([]);
        expect(ids('cute')).toEqual(['avtr_2']);
    });

    test('ranks a name hit above a description-only hit', () => {
        const result = ids('fox');
        // avtr_1 matches in both name and description.
        expect(result[0]).toBe('avtr_1');
    });

    test('filters by tag with any()', () => {
        expect(ids('tag:any(protogen, cat_ears)').sort()).toEqual([
            'avtr_2',
            'avtr_3'
        ]);
    });

    test('filters by tag with all()', () => {
        expect(ids('aiTag:all(neon, glowing_eyes)')).toEqual(['avtr_1']);
        expect(ids('aiTag:all(neon, missing)')).toEqual([]);
    });

    test('matches an author by name or id', () => {
        expect(ids('author:usr_a').sort()).toEqual(['avtr_1', 'avtr_3']);
        expect(ids('author:"creator b"')).toEqual(['avtr_2']);
    });

    test('a multi-word field value needs quoting', () => {
        // Unquoted, "b" is a separate free-text term, and it substring-matches
        // "robot" — quoting is what keeps the value together.
        expect(ids('author:creator b').sort()).toEqual(['avtr_2', 'avtr_3']);
    });

    test('fuzzy matching tolerates a typo that substring matching would miss', () => {
        expect(ids('protogn')).toEqual([]);
        expect(ids('fuzzy:0.4 protogn')).toContain('avtr_3');
    });

    test('applies sort directives ahead of score', () => {
        expect(ids('sort:name(asc) creator')).toEqual([
            'avtr_2',
            'avtr_1',
            'avtr_3'
        ]);
    });

    test('similar-to-tags ranks by tag overlap', () => {
        expect(ids('similar to tags fox, kemono')).toEqual(['avtr_1']);
    });

    test('random:true keeps the same set', () => {
        const shuffled = ids('random:true', { random: () => 0 });
        expect(shuffled.sort()).toEqual(['avtr_1', 'avtr_2', 'avtr_3']);
    });

    test('skips entries without an id', () => {
        expect(runQuery([{ name: 'no id' }], parseQuery('no'))).toEqual([]);
    });
});

describe('helpers', () => {
    test('searchableText joins the searchable fields', () => {
        expect(searchableText(avatars[0])).toContain('glowing_eyes');
    });

    test('trigramSimilarity is 1 for identical strings and 0 for empty', () => {
        expect(trigramSimilarity('fox', 'fox')).toBe(1);
        expect(trigramSimilarity('', 'fox')).toBe(0);
    });

    test('jaccard measures overlap', () => {
        expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
        expect(jaccard(['a'], ['b'])).toBe(0);
        expect(jaccard([], ['b'])).toBe(0);
    });
});
