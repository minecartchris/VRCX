import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
    clearRegistry,
    getAllPlugins,
    getPlugin,
    getPluginsByCategory,
    registerPlugin,
    resolveDependencies,
    resolveDependents,
    validateManifest
} from '../registry';

/**
 * @param {object} overrides
 * @returns {import('../registry').PluginManifest}
 */
function manifest(overrides) {
    return { id: 'test', name: 'Test', ...overrides };
}

describe('validateManifest', () => {
    beforeEach(clearRegistry);

    test('rejects a non kebab-case id', () => {
        expect(() => validateManifest(manifest({ id: 'Not Kebab' }))).toThrow(
            TypeError
        );
    });

    test('rejects an unknown category', () => {
        expect(() =>
            validateManifest(manifest({ category: 'nonsense' }))
        ).toThrow(TypeError);
    });

    test('rejects a missing name', () => {
        expect(() => validateManifest({ id: 'test' })).toThrow(TypeError);
    });

    test('accepts a minimal manifest', () => {
        expect(() => validateManifest(manifest({}))).not.toThrow();
    });
});

describe('registerPlugin', () => {
    beforeEach(clearRegistry);

    test('stores and retrieves by id', () => {
        registerPlugin(manifest({ id: 'a' }));
        expect(getPlugin('a')?.id).toBe('a');
        expect(getAllPlugins()).toHaveLength(1);
    });

    test('refuses duplicate ids', () => {
        registerPlugin(manifest({ id: 'a' }));
        expect(() => registerPlugin(manifest({ id: 'a' }))).toThrow(
            /already registered/
        );
    });

    test('filters by category', () => {
        registerPlugin(manifest({ id: 'a', category: 'chatbox' }));
        registerPlugin(manifest({ id: 'b', category: 'social' }));
        expect(getPluginsByCategory('chatbox').map((p) => p.id)).toEqual(['a']);
    });
});

describe('dependency resolution', () => {
    beforeEach(() => {
        clearRegistry();
        registerPlugin(manifest({ id: 'core' }));
        registerPlugin(manifest({ id: 'mid', requires: ['core'] }));
        registerPlugin(manifest({ id: 'leaf', requires: ['mid'] }));
    });

    test('returns transitive dependencies, deepest first', () => {
        expect(resolveDependencies('leaf')).toEqual(['core', 'mid']);
    });

    test('returns nothing for a plugin with no dependencies', () => {
        expect(resolveDependencies('core')).toEqual([]);
    });

    test('finds transitive dependents', () => {
        expect(resolveDependents('core').sort()).toEqual(['leaf', 'mid']);
    });

    test('survives a dependency cycle', () => {
        clearRegistry();
        registerPlugin(manifest({ id: 'a', requires: ['b'] }));
        registerPlugin(manifest({ id: 'b', requires: ['a'] }));
        expect(() => resolveDependencies('a')).not.toThrow();
    });

    test('warns about an unknown dependency instead of throwing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        clearRegistry();
        registerPlugin(manifest({ id: 'a', requires: ['missing'] }));
        expect(resolveDependencies('a')).toEqual([]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
