import { describe, expect, test } from 'vitest';

import {
    PERFORMANCE_RANKS,
    avatarPerformance,
    avatarPlatforms,
    jaccard,
    normalizePlatform,
    parseQuery,
    performanceRank,
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
 * @returns {string[]} Matching ids, in result order
 */
function ids(query, options) {
    return searchAvatars(avatars, query, options).map((a) => a.id);
}

describe('tokenizeQuery', () => {
    test('keeps parenthesised groups together', () => {
        expect(tokenizeQuery('tag:any(a, b) cute')).toEqual(['tag:any(a, b)', 'cute']);
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
        expect(parseQuery('author:someone').fields).toEqual([{ field: 'author', mode: 'all', values: ['someone'] }]);
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
        expect(parseQuery('sort:name').sorts).toEqual([{ field: 'name', direction: 'asc' }]);
    });

    test('ignores an unknown sort field', () => {
        expect(parseQuery('sort:nonsense(asc)').sorts).toEqual([]);
    });

    test('parses similar-to-tags', () => {
        expect(parseQuery('similar to tags fox, kemono').similarTags).toEqual(['fox', 'kemono']);
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
        expect(ids('tag:any(protogen, cat_ears)').sort()).toEqual(['avtr_2', 'avtr_3']);
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
        expect(ids('sort:name(asc) creator')).toEqual(['avtr_2', 'avtr_1', 'avtr_3']);
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

// ── avtr.zip's newer facets ────────────────────────────────

/**
 * A second fixture set, with the fields avtr.zip filters on that the original
 * three do not carry.
 */
const faceted = [
    {
        id: 'avtr_pc',
        name: 'PC Only Excellent',
        tags: [],
        features: ['locomotion:gogoloco', 'tracking:face-tracking'],
        platforms: ['standalonewindows'],
        performance: { standalonewindows: 'Excellent' },
        price: 0,
        likes: 10,
        used: 500
    },
    {
        id: 'avtr_quest',
        name: 'Cross Platform Good',
        tags: [],
        features: ['locomotion:gogoloco', 'body:tail'],
        unityPackages: [
            { platform: 'standalonewindows', performanceRating: 'Good' },
            { platform: 'android', performanceRating: 'Good' }
        ],
        price: 1500,
        impostor: true,
        likes: 300,
        used: 20
    },
    {
        id: 'avtr_poor',
        name: 'Quest Poor',
        tags: [],
        features: ['physbone:tail'],
        platforms: ['android'],
        performance: { android: 'Very Poor' },
        price: 500,
        likes: 50,
        used: 100
    }
];

/**
 * @param {string} query
 * @returns {string[]} Matching ids, in result order
 */
function facetIds(query) {
    return searchAvatars(faceted, query).map((a) => a.id);
}

describe('feature queries', () => {
    test('resolves a full feature id', () => {
        expect(parseQuery('feature:locomotion:gogoloco').features).toEqual([
            { mode: 'any', ids: ['locomotion:gogoloco'] }
        ]);
    });

    test('resolves a bare feature name to every namespace that has it', () => {
        const [clause] = parseQuery('feature:tail').features;
        expect(clause.ids).toContain('body:tail');
        expect(clause.ids).toContain('physbone:tail');
    });

    test('resolves a whole category', () => {
        const [clause] = parseQuery('feature:tracking').features;
        expect(clause.ids.length).toBeGreaterThan(1);
        expect(clause.ids.every((id) => id.startsWith('tracking:'))).toBe(true);
    });

    test('resolves a human label', () => {
        expect(parseQuery('feature:"GoGoLoco"').features[0].ids).toContain('locomotion:gogoloco');
    });

    test('filters by a single feature', () => {
        expect(facetIds('feature:gogoloco').sort()).toEqual(['avtr_pc', 'avtr_quest']);
    });

    test('a bare name matches either namespace', () => {
        expect(facetIds('feature:tail').sort()).toEqual(['avtr_poor', 'avtr_quest']);
    });

    test('all() requires every listed feature', () => {
        expect(facetIds('feature:all(gogoloco, face-tracking)')).toEqual(['avtr_pc']);
        expect(facetIds('feature:all(gogoloco, headpat)')).toEqual([]);
    });

    test('any() takes either', () => {
        expect(facetIds('feature:any(face-tracking, physbone:tail)').sort()).toEqual(['avtr_pc', 'avtr_poor']);
    });

    test('an unknown feature matches nothing rather than erroring', () => {
        expect(facetIds('feature:not-a-real-feature')).toEqual([]);
    });

    test('free text reaches feature ids', () => {
        expect(facetIds('gogoloco').sort()).toEqual(['avtr_pc', 'avtr_quest']);
    });
});

describe('platform and performance queries', () => {
    test('parses a platform build check', () => {
        expect(parseQuery('quest:true').platforms).toEqual([{ platform: 'quest', present: true }]);
    });

    test('parses a performance comparison', () => {
        expect(parseQuery('quest:>=Good').platforms).toEqual([{ platform: 'quest', op: '>=', rating: 'good' }]);
    });

    test('filters by having a build for a platform', () => {
        expect(facetIds('quest:true').sort()).toEqual(['avtr_poor', 'avtr_quest']);
        expect(facetIds('quest:none')).toEqual(['avtr_pc']);
    });

    test('>= reads as quality, so it includes better ratings', () => {
        expect(facetIds('pc:>=Good').sort()).toEqual(['avtr_pc', 'avtr_quest']);
    });

    test('> excludes the named rating itself', () => {
        expect(facetIds('pc:>Good')).toEqual(['avtr_pc']);
    });

    test('<= reads as quality too', () => {
        expect(facetIds('quest:<=Good').sort()).toEqual(['avtr_poor', 'avtr_quest']);
    });

    test('a bare rating is an exact match', () => {
        expect(facetIds('quest:Good')).toEqual(['avtr_quest']);
    });

    test('reads ratings from unityPackages as well as a performance map', () => {
        expect(avatarPerformance(faceted[1], 'quest')).toBe('good');
        expect(avatarPerformance(faceted[0], 'pc')).toBe('excellent');
    });

    test('normalizes the spelling of a two-word rating', () => {
        expect(facetIds('quest:VeryPoor')).toEqual(['avtr_poor']);
    });

    test('platform aliases agree', () => {
        expect(facetIds('android:true').sort()).toEqual(facetIds('quest:true').sort());
        expect(facetIds('windows:true').sort()).toEqual(facetIds('pc:true').sort());
    });

    test('an avatar with no rating for a platform does not match a comparison', () => {
        expect(facetIds('ios:>=Good')).toEqual([]);
    });
});

describe('price, paid and impostor queries', () => {
    test('paid:false keeps only free avatars', () => {
        expect(facetIds('paid:false')).toEqual(['avtr_pc']);
    });

    test('free:true is the inverse of paid:true', () => {
        expect(facetIds('free:true')).toEqual(facetIds('paid:false'));
    });

    test('price comparisons', () => {
        expect(facetIds('price:<1000').sort()).toEqual(['avtr_pc', 'avtr_poor']);
        expect(facetIds('price:>=1500')).toEqual(['avtr_quest']);
        expect(facetIds('price:0')).toEqual(['avtr_pc']);
    });

    test('price accepts a min-max range', () => {
        expect(parseQuery('price:100-600').price).toEqual({ op: 'range', min: 100, max: 600 });
        expect(facetIds('price:100-600')).toEqual(['avtr_poor']);
    });

    test('price:free is a shorthand for zero', () => {
        expect(facetIds('price:free')).toEqual(['avtr_pc']);
    });

    test('impostor filtering', () => {
        expect(facetIds('impostor:true')).toEqual(['avtr_quest']);
        expect(facetIds('impostor:false').sort()).toEqual(['avtr_pc', 'avtr_poor']);
    });
});

describe('sort directives', () => {
    test('sort:likes defaults to most liked first', () => {
        expect(parseQuery('sort:likes').sorts).toEqual([{ field: 'likes', direction: 'desc' }]);
        expect(facetIds('sort:likes')).toEqual(['avtr_quest', 'avtr_poor', 'avtr_pc']);
    });

    test('sort:used defaults to most worn first', () => {
        expect(facetIds('sort:used')).toEqual(['avtr_pc', 'avtr_poor', 'avtr_quest']);
    });

    test('sort:price defaults to cheapest first', () => {
        expect(facetIds('sort:price')).toEqual(['avtr_pc', 'avtr_poor', 'avtr_quest']);
    });

    test('an explicit direction overrides the natural one', () => {
        expect(parseQuery('sort:likes(asc)').sorts).toEqual([{ field: 'likes', direction: 'asc' }]);
        expect(facetIds('sort:likes(asc)')).toEqual(['avtr_pc', 'avtr_poor', 'avtr_quest']);
    });

    test('numeric sorts compare as numbers, not strings', () => {
        // String ordering would put 500 before 1500 here.
        expect(facetIds('sort:price(desc)')).toEqual(['avtr_quest', 'avtr_poor', 'avtr_pc']);
    });

    test('sort:newest reads created_at descending', () => {
        expect(parseQuery('sort:newest').sorts).toEqual([{ field: 'created_at', direction: 'desc' }]);
    });
});

describe('combined queries', () => {
    test('facets narrow each other', () => {
        expect(facetIds('feature:gogoloco quest:true paid:true')).toEqual(['avtr_quest']);
    });

    test('a facet query with no text still returns matches', () => {
        expect(facetIds('pc:>=Good').length).toBe(2);
    });
});

describe('helpers', () => {
    test('searchableText joins the searchable fields', () => {
        expect(searchableText(avatars[0])).toContain('glowing_eyes');
    });

    test('avatarPlatforms reads a platforms list, unityPackages and a performance map', () => {
        expect(Array.from(avatarPlatforms(faceted[0])).sort()).toEqual(['pc']);
        expect(Array.from(avatarPlatforms(faceted[1])).sort()).toEqual(['pc', 'quest']);
    });

    test('performanceRank orders best to worst', () => {
        expect(performanceRank('Excellent')).toBeLessThan(performanceRank('Good'));
        expect(performanceRank('Very Poor')).toBe(PERFORMANCE_RANKS.length - 1);
        expect(performanceRank('nonsense')).toBe(-1);
    });

    test('normalizePlatform folds the aliases', () => {
        expect(normalizePlatform('StandaloneWindows')).toBe('pc');
        expect(normalizePlatform('android')).toBe('quest');
        expect(normalizePlatform('switch')).toBeNull();
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
