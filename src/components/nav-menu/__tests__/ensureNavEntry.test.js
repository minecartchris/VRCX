import { describe, expect, test } from 'vitest';

import { ensureNavEntry } from '../navLayoutDefaults';

const layout = [
    { type: 'item', key: 'feed' },
    { type: 'item', key: 'search' },
    { type: 'item', key: 'tools' }
];

describe('ensureNavEntry', () => {
    test('inserts directly after the anchor', () => {
        const result = ensureNavEntry(layout, 'plugins', 'search');
        expect(result.map((entry) => entry.key)).toEqual(['feed', 'search', 'plugins', 'tools']);
    });

    test('does not mutate the original layout', () => {
        ensureNavEntry(layout, 'plugins', 'search');
        expect(layout).toHaveLength(3);
    });

    test('appends when the anchor is gone', () => {
        const withoutSearch = [{ type: 'item', key: 'feed' }];
        expect(ensureNavEntry(withoutSearch, 'plugins', 'search').map((e) => e.key)).toEqual(['feed', 'plugins']);
    });

    test('leaves a layout that already has the key alone', () => {
        const existing = [...layout, { type: 'item', key: 'plugins' }];
        expect(ensureNavEntry(existing, 'plugins', 'search')).toBe(existing);
    });

    test('counts a key inside a folder as already present', () => {
        const foldered = [
            { type: 'item', key: 'search' },
            { type: 'folder', id: 'f1', items: ['plugins'] }
        ];
        expect(ensureNavEntry(foldered, 'plugins', 'search')).toBe(foldered);
    });

    test('respects an explicitly hidden key', () => {
        expect(ensureNavEntry(layout, 'plugins', 'search', ['plugins'])).toBe(layout);
    });

    test('accepts hidden keys as a Set', () => {
        expect(ensureNavEntry(layout, 'plugins', 'search', new Set(['plugins']))).toBe(layout);
    });

    test('tolerates a non-array layout', () => {
        expect(ensureNavEntry(null, 'plugins', 'search')).toBeNull();
    });
});
