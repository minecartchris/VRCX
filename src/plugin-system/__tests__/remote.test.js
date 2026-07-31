import { describe, expect, test } from 'vitest';

import {
    compileRemotePlugin,
    formatPluginCode,
    parsePluginCode,
    rawUrlFor,
    validateRemoteManifest
} from '../remote';

describe('plugin code parsing', () => {
    test('parses owner/repo', () => {
        expect(parsePluginCode('someone/my-plugin')).toEqual({
            owner: 'someone',
            repo: 'my-plugin',
            path: '',
            ref: 'HEAD'
        });
    });

    test('parses a ref', () => {
        expect(parsePluginCode('someone/my-plugin@v1.2.0').ref).toBe('v1.2.0');
    });

    test('parses a subdirectory', () => {
        expect(parsePluginCode('someone/repo/plugins/clock@main')).toEqual({
            owner: 'someone',
            repo: 'repo',
            path: 'plugins/clock',
            ref: 'main'
        });
    });

    test('accepts a github.com url', () => {
        expect(parsePluginCode('https://github.com/someone/my-plugin')).toEqual(
            {
                owner: 'someone',
                repo: 'my-plugin',
                path: '',
                ref: 'HEAD'
            }
        );
    });

    test('accepts a .git suffix and trailing slash', () => {
        expect(
            parsePluginCode('https://github.com/someone/my-plugin.git/')
        ).toEqual({
            owner: 'someone',
            repo: 'my-plugin',
            path: '',
            ref: 'HEAD'
        });
    });

    test('accepts the /tree/<ref>/<path> browse url', () => {
        expect(
            parsePluginCode(
                'https://github.com/someone/repo/tree/main/plugins/clock'
            )
        ).toEqual({
            owner: 'someone',
            repo: 'repo',
            path: 'plugins/clock',
            ref: 'main'
        });
    });

    test('rejects an incomplete code', () => {
        expect(() => parsePluginCode('someone')).toThrow(/owner\/repo/);
        expect(() => parsePluginCode('')).toThrow();
    });

    test('rejects path traversal', () => {
        expect(() => parsePluginCode('someone/repo/../secrets')).toThrow(
            /\.\./
        );
    });

    test('rejects an empty ref', () => {
        expect(() => parsePluginCode('someone/repo@')).toThrow(/empty/);
    });

    test('builds a raw url', () => {
        const parsed = parsePluginCode('someone/repo/plugins/clock@main');
        expect(rawUrlFor(parsed, 'vrcx-plugin.json')).toBe(
            'https://raw.githubusercontent.com/someone/repo/main/plugins/clock/vrcx-plugin.json'
        );
    });

    test('round trips to a canonical code', () => {
        expect(formatPluginCode(parsePluginCode('someone/repo'))).toBe(
            'someone/repo@HEAD'
        );
        expect(formatPluginCode(parsePluginCode('someone/repo/sub@v1'))).toBe(
            'someone/repo/sub@v1'
        );
    });
});

describe('remote manifest validation', () => {
    const valid = {
        id: 'my-plugin',
        name: 'My plugin',
        entry: 'index.js',
        category: 'automation'
    };

    test('accepts a minimal manifest and fills defaults', () => {
        const manifest = validateRemoteManifest(valid);
        expect(manifest.icon).toBe('ri-puzzle-line');
        expect(manifest.settingsSchema).toEqual([]);
        expect(manifest.description).toBe('');
    });

    test('defaults entry and category when omitted', () => {
        const manifest = validateRemoteManifest({
            id: 'p',
            name: 'P'
        });
        expect(manifest.entry).toBe('index.js');
        expect(manifest.category).toBe('automation');
    });

    test('rejects a non kebab-case id', () => {
        expect(() =>
            validateRemoteManifest({ ...valid, id: 'My_Plugin' })
        ).toThrow(/kebab-case/);
    });

    test('rejects a missing name', () => {
        expect(() => validateRemoteManifest({ ...valid, name: '' })).toThrow(
            /name/
        );
    });

    test('rejects an unknown category', () => {
        expect(() =>
            validateRemoteManifest({ ...valid, category: 'malware' })
        ).toThrow(/category/);
    });

    test('rejects an entry that escapes the repo', () => {
        expect(() =>
            validateRemoteManifest({ ...valid, entry: '../../etc/passwd' })
        ).toThrow(/relative/);
        expect(() =>
            validateRemoteManifest({ ...valid, entry: '/abs.js' })
        ).toThrow(/relative/);
    });

    test('rejects a settingsSchema that is not an array', () => {
        expect(() =>
            validateRemoteManifest({ ...valid, settingsSchema: {} })
        ).toThrow(/array/);
    });

    test('rejects a non object', () => {
        expect(() => validateRemoteManifest(null)).toThrow();
        expect(() => validateRemoteManifest([])).toThrow();
    });
});

describe('compiling imported source', () => {
    test('pulls setup and teardown off module.exports', () => {
        const compiled = compileRemotePlugin(
            'module.exports = { setup() { return 1 }, teardown() { return 2 } };',
            'p'
        );
        expect(compiled.setup()).toBe(1);
        expect(compiled.teardown()).toBe(2);
    });

    test('accepts an exports.default object', () => {
        const compiled = compileRemotePlugin(
            'module.exports.default = { setup() { return 42 } };',
            'p'
        );
        expect(compiled.setup()).toBe(42);
        expect(compiled.teardown).toBeUndefined();
    });

    test('rejects source that exports no setup', () => {
        expect(() =>
            compileRemotePlugin('module.exports = { name: "x" };', 'p')
        ).toThrow(/setup/);
    });

    test('rejects source that exports nothing usable', () => {
        expect(() => compileRemotePlugin('module.exports = 5;', 'p')).toThrow(
            /module.exports/
        );
    });

    test('propagates a syntax error rather than swallowing it', () => {
        expect(() => compileRemotePlugin('this is not js', 'p')).toThrow();
    });
});
