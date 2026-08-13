import { describe, expect, test } from 'vitest';

import { parsePluginImportCommand, pluginImportLink } from '../importLink';
import {
    compileRemotePlugin,
    formatPluginCode,
    parsePluginCode,
    parsePluginSource,
    rawUrlFor,
    validateBundle,
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

describe('vrcx://import-plugin links', () => {
    test('a link round trips back to the code', () => {
        for (const code of [
            'https://gist.github.com/someone/abc123',
            'https://example.com/a b/plugin.json?v=1#x',
            'someone/repo/plugins/clock@main',
            'gist:abc123'
        ]) {
            const link = pluginImportLink(code);
            expect(link.startsWith('vrcx://import-plugin/')).toBe(true);
            expect(parsePluginImportCommand(link.replace('vrcx://', ''))).toBe(
                code
            );
        }
    });

    test('slashes in the payload survive, since it is usually a URL', () => {
        const code = 'https://example.com/deep/path/plugin.json';
        expect(
            parsePluginImportCommand(
                pluginImportLink(code).replace('vrcx://', '')
            )
        ).toBe(code);
    });

    test('an unencoded payload is still accepted', () => {
        expect(
            parsePluginImportCommand('import-plugin/https://example.com/p.json')
        ).toBe('https://example.com/p.json');
    });

    test('other commands and empty payloads yield nothing', () => {
        expect(parsePluginImportCommand('world/wrld_1')).toBe('');
        expect(parsePluginImportCommand('import-plugin/')).toBe('');
        expect(parsePluginImportCommand('import-plugin/   ')).toBe('');
        expect(parsePluginImportCommand('')).toBe('');
        expect(parsePluginImportCommand(null)).toBe('');
    });

    test('a malformed percent escape does not throw', () => {
        expect(() =>
            parsePluginImportCommand('import-plugin/%E0%A4%A')
        ).not.toThrow();
        expect(parsePluginImportCommand('import-plugin/%E0%A4%A')).toBe(
            '%E0%A4%A'
        );
    });

    test('a link only ever yields a code, never an install', () => {
        // The parser hands back a string. Nothing here can install anything —
        // that is the whole point of keeping the confirm step.
        expect(
            typeof parsePluginImportCommand('import-plugin/gist%3Aabc123')
        ).toBe('string');
    });
});

describe('plugin source detection', () => {
    test('an owner/repo code is still a repo', () => {
        expect(parsePluginSource('someone/my-plugin')).toEqual({
            kind: 'repo',
            parsed: {
                owner: 'someone',
                repo: 'my-plugin',
                path: '',
                ref: 'HEAD'
            }
        });
    });

    test('a github.com link is a repo, not a bundle', () => {
        const source = parsePluginSource(
            'https://github.com/someone/my-plugin'
        );
        expect(source.kind).toBe('repo');
    });

    test('any other https link is a bundle', () => {
        expect(
            parsePluginSource('https://example.com/plugins/clock.json')
        ).toEqual({
            kind: 'bundle',
            url: 'https://example.com/plugins/clock.json'
        });
    });

    test('http is refused so the download cannot be tampered with', () => {
        expect(() => parsePluginSource('http://example.com/p.json')).toThrow(
            /https/
        );
    });

    test('gist forms all resolve to the same id', () => {
        const expected = { kind: 'gist', id: 'abc123def456' };
        expect(parsePluginSource('gist:abc123def456')).toEqual(expected);
        expect(
            parsePluginSource('https://gist.github.com/someone/abc123def456')
        ).toEqual(expected);
        expect(
            parsePluginSource(
                'https://gist.github.com/someone/abc123def456#file-x'
            )
        ).toEqual(expected);
    });

    test('a gist id that is not hex is refused', () => {
        expect(() => parsePluginSource('gist:not a gist')).toThrow(/gist id/);
    });

    test('an empty input is refused', () => {
        expect(() => parsePluginSource('   ')).toThrow();
    });
});

describe('bundle validation', () => {
    const good = {
        vrcxPlugin: 1,
        manifest: { id: 'bundled', name: 'Bundled' },
        source: 'module.exports = { setup() {} };'
    };

    test('accepts a well formed bundle', () => {
        const { manifest, source } = validateBundle(good);
        expect(manifest.id).toBe('bundled');
        expect(source).toContain('setup');
    });

    test('rejects a bundle with no source', () => {
        expect(() => validateBundle({ ...good, source: '' })).toThrow(/source/);
        expect(() => validateBundle({ ...good, source: 42 })).toThrow(/source/);
    });

    test('rejects a bundle whose manifest is invalid', () => {
        expect(() =>
            validateBundle({ ...good, manifest: { id: 'Bad Id', name: 'x' } })
        ).toThrow(/kebab-case/);
    });

    test('rejects a non object', () => {
        expect(() => validateBundle(null)).toThrow();
        expect(() => validateBundle([])).toThrow();
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
