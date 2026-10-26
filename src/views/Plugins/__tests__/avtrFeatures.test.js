import { describe, expect, test, vi } from 'vitest';

import {
    FEATURE_CATALOG,
    FEATURE_CATEGORIES,
    buildFeatureQuery,
    fetchFeatureCatalog,
    groupFeaturesByCategory,
    indexFeatures,
    normalizeAvatarFeatures,
    parseFeatureCatalog,
    resolveFeatureToken,
    searchFeatures
} from '../avtrFeatures';

const sample = [
    { id: 'locomotion:gogoloco', label: 'GoGoLoco', category: 'locomotion', count: 52017 },
    { id: 'locomotion:dash', label: 'Dash', category: 'locomotion', count: 22819 },
    { id: 'body:tail', label: 'Tail', category: 'body', count: 17151 },
    { id: 'physbone:tail', label: 'Tail PhysBones', category: 'physbone', count: 9000 }
];

describe('the bundled catalog', () => {
    test('is a non-trivial snapshot', () => {
        expect(FEATURE_CATALOG.length).toBeGreaterThan(300);
    });

    test('every entry has a namespaced id and a category that matches it', () => {
        for (const feature of FEATURE_CATALOG) {
            expect(feature.id).toContain(':');
            expect(feature.id.split(':')[0]).toBe(feature.category);
            expect(typeof feature.label).toBe('string');
            expect(feature.label.length).toBeGreaterThan(0);
        }
    });

    test('ids are unique', () => {
        expect(new Set(FEATURE_CATALOG.map((f) => f.id)).size).toBe(FEATURE_CATALOG.length);
    });

    test('every catalog category is listed in FEATURE_CATEGORIES', () => {
        const listed = new Set(FEATURE_CATEGORIES.map((c) => c.id));
        for (const feature of FEATURE_CATALOG) {
            expect(listed.has(feature.category)).toBe(true);
        }
    });
});

describe('resolveFeatureToken', () => {
    const index = indexFeatures(sample);

    test('matches a full id', () => {
        expect(resolveFeatureToken('locomotion:gogoloco', index)).toEqual(['locomotion:gogoloco']);
    });

    test('matches a bare name across namespaces', () => {
        expect(resolveFeatureToken('tail', index).sort()).toEqual(['body:tail', 'physbone:tail']);
    });

    test('matches a whole category', () => {
        expect(resolveFeatureToken('locomotion', index).sort()).toEqual(['locomotion:dash', 'locomotion:gogoloco']);
    });

    test('matches a label, case and separators aside', () => {
        expect(resolveFeatureToken('GoGoLoco', index)).toEqual(['locomotion:gogoloco']);
        expect(resolveFeatureToken('tail physbones', index)).toEqual(['physbone:tail']);
    });

    test('falls back to the raw token when nothing matches', () => {
        expect(resolveFeatureToken('nonsense', index)).toEqual(['nonsense']);
    });

    test('an empty token resolves to nothing', () => {
        expect(resolveFeatureToken('   ', index)).toEqual([]);
    });
});

describe('searchFeatures', () => {
    test('ranks an exact label above a substring hit', () => {
        const results = searchFeatures('tail', { catalog: sample });
        expect(results[0].id).toBe('body:tail');
    });

    test('ties break on popularity', () => {
        const results = searchFeatures('locomotion', { catalog: sample });
        expect(results.map((f) => f.id)).toEqual(['locomotion:gogoloco', 'locomotion:dash']);
    });

    test('an empty search returns the catalog in order', () => {
        expect(searchFeatures('', { catalog: sample })).toHaveLength(sample.length);
    });

    test('honours a limit', () => {
        expect(searchFeatures('', { catalog: sample, limit: 2 })).toHaveLength(2);
    });

    test('returns nothing for a miss', () => {
        expect(searchFeatures('zzzz', { catalog: sample })).toEqual([]);
    });
});

describe('groupFeaturesByCategory', () => {
    test('groups in FEATURE_CATEGORIES order', () => {
        const groups = groupFeaturesByCategory(sample);
        expect(groups.map((g) => g.id)).toEqual(['locomotion', 'body', 'physbone']);
        expect(groups[0].features).toHaveLength(2);
    });

    test('keeps a category the bundled list does not know about', () => {
        const groups = groupFeaturesByCategory([
            ...sample,
            { id: 'brandnew:thing', label: 'Thing', category: 'brandnew', count: 1 }
        ]);
        expect(groups.map((g) => g.id)).toContain('brandnew');
    });
});

describe('buildFeatureQuery', () => {
    test('is empty when nothing is selected', () => {
        expect(buildFeatureQuery([])).toBe('');
        expect(buildFeatureQuery(undefined)).toBe('');
    });

    test('a single feature needs no group wrapper', () => {
        expect(buildFeatureQuery(['body:tail'])).toBe('feature:body:tail');
    });

    test('wraps several in all() by default', () => {
        expect(buildFeatureQuery(['body:tail', 'locomotion:dash'])).toBe('feature:all(body:tail, locomotion:dash)');
    });

    test('honours any mode', () => {
        expect(buildFeatureQuery(['body:tail', 'locomotion:dash'], 'any')).toBe(
            'feature:any(body:tail, locomotion:dash)'
        );
    });

    test('drops duplicates and blanks', () => {
        expect(buildFeatureQuery(['body:tail', 'body:tail', '  '])).toBe('feature:body:tail');
    });

    test('round-trips through the parser', async () => {
        const { parseQuery } = await import('../avatarQuery');
        const plan = parseQuery(buildFeatureQuery(['locomotion:gogoloco', 'body:tail'], 'any'));
        expect(plan.features).toEqual([{ mode: 'any', ids: ['locomotion:gogoloco', 'body:tail'] }]);
    });
});

describe('normalizeAvatarFeatures', () => {
    test('reads a list of ids', () => {
        expect(normalizeAvatarFeatures(['Body:Tail', 'locomotion:dash'])).toEqual(['body:tail', 'locomotion:dash']);
    });

    test('reads a list of objects', () => {
        expect(normalizeAvatarFeatures([{ id: 'body:tail' }, { feature: 'locomotion:dash' }])).toEqual([
            'body:tail',
            'locomotion:dash'
        ]);
    });

    test('reads an object keyed by id, keeping only the enabled ones', () => {
        expect(normalizeAvatarFeatures({ 'body:tail': true, 'locomotion:dash': false })).toEqual(['body:tail']);
    });

    test('anything else is no features', () => {
        expect(normalizeAvatarFeatures(undefined)).toEqual([]);
        expect(normalizeAvatarFeatures('body:tail')).toEqual([]);
    });
});

describe('parseFeatureCatalog', () => {
    test('accepts the documented envelope', () => {
        expect(parseFeatureCatalog({ success: true, items: sample })).toHaveLength(4);
    });

    test('accepts a bare array', () => {
        expect(parseFeatureCatalog(sample)).toHaveLength(4);
    });

    test('fills in a missing label and category from the id', () => {
        const [feature] = parseFeatureCatalog([{ id: 'visual:hue-shift' }]);
        expect(feature.category).toBe('visual');
        expect(feature.label).toBe('hue-shift');
        expect(feature.count).toBe(0);
    });

    test('drops entries without a namespaced id', () => {
        expect(parseFeatureCatalog([...sample, { id: 'bare' }, {}])).toHaveLength(4);
    });

    test('throws when the payload is not a listing', () => {
        expect(() => parseFeatureCatalog({ success: false })).toThrow(/items array/);
    });

    test('throws when nothing in the listing is usable', () => {
        expect(() => parseFeatureCatalog({ items: [{ id: 'bare' }] })).toThrow(/no usable features/);
    });
});

describe('fetchFeatureCatalog', () => {
    test('parses a successful response', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: sample }) });
        await expect(fetchFeatureCatalog({ fetchImpl })).resolves.toHaveLength(4);
        expect(fetchImpl).toHaveBeenCalledWith('https://avtr.zip/v3/features', expect.any(Object));
    });

    test('rejects on a non-ok response', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
        await expect(fetchFeatureCatalog({ fetchImpl })).rejects.toThrow(/503/);
    });
});
