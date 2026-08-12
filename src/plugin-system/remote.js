/**
 * Importing community plugins from GitHub.
 *
 * The "code" a user pastes is deliberately short and GitHub-shaped:
 *
 *     owner/repo
 *     owner/repo@ref            (branch, tag or commit sha)
 *     owner/repo/sub/dir        (plugin lives in a subdirectory)
 *     owner/repo/sub/dir@ref
 *
 * A full https://github.com/... URL is accepted too and reduced to the same
 * thing. The code resolves to `vrcx-plugin.json` in that directory, which
 * declares the plugin and points at a single CommonJS entry file.
 *
 * SECURITY: an imported plugin is arbitrary code running with the same
 * privileges as VRCX itself. Nothing here sandboxes it — the protection is that
 * importing is explicit, the source is shown before it is installed, the
 * fetched source is pinned locally rather than re-fetched behind the user's
 * back, and a newly imported plugin starts disabled.
 */

import { getText } from './http';
import { pluginCategories } from './registry';

const RAW_HOST = 'https://raw.githubusercontent.com';
const MANIFEST_FILE = 'vrcx-plugin.json';
const MAX_SOURCE_BYTES = 1024 * 1024;

const CATEGORY_KEYS = new Set(pluginCategories.map((category) => category.key));

/**
 * @typedef {object} PluginCode
 * @property {string} owner
 * @property {string} repo
 * @property {string} path directory inside the repo, '' for the root
 * @property {string} ref branch/tag/sha, defaults to 'HEAD'
 */

/**
 * Works out what kind of thing the user pasted.
 *
 * Three shapes are accepted:
 *   - a bundle URL: any https link to a single-file plugin bundle
 *   - a gist: `gist:<id>` or a gist.github.com link
 *   - a repo folder: the owner/repo form handled by `parsePluginCode`
 *
 * The URL and gist forms exist so a one-file plugin can be shared without
 * laying out a whole repository.
 *
 * @param {string} input
 * @returns {{kind: 'bundle', url: string} | {kind: 'gist', id: string} | {kind: 'repo', parsed: PluginCode}}
 */
export function parsePluginSource(input) {
    const value = String(input ?? '').trim();
    if (!value) {
        throw new Error('Enter a plugin code, link or gist');
    }

    const gistPrefix = value.match(/^gist:(.+)$/i);
    if (gistPrefix) {
        return { kind: 'gist', id: gistIdFrom(gistPrefix[1]) };
    }
    if (/^https?:\/\/gist\.github\.com\//i.test(value)) {
        return { kind: 'gist', id: gistIdFrom(value) };
    }

    if (/^https?:\/\//i.test(value)) {
        // A github.com repo link is still a repo, not a bundle.
        if (/^https?:\/\/(www\.)?github\.com\//i.test(value)) {
            return { kind: 'repo', parsed: parsePluginCode(value) };
        }
        let url;
        try {
            url = new URL(value);
        } catch {
            throw new Error('That does not look like a valid link');
        }
        if (url.protocol !== 'https:') {
            throw new Error(
                'Only https links are allowed, so the download cannot be tampered with in transit'
            );
        }
        return { kind: 'bundle', url: url.toString() };
    }

    return { kind: 'repo', parsed: parsePluginCode(value) };
}

/**
 * @param {string} value gist id, or a URL containing one
 * @returns {string}
 */
function gistIdFrom(value) {
    const cleaned = String(value ?? '')
        .trim()
        .replace(/^https?:\/\/gist\.github\.com\//i, '')
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '');
    // Either "<id>" or "<user>/<id>".
    const parts = cleaned.split('/').filter(Boolean);
    const id = parts[parts.length - 1] ?? '';
    if (!/^[0-9a-f]+$/i.test(id)) {
        throw new Error(`"${id}" is not a gist id`);
    }
    return id;
}

/**
 * Validates a single-file plugin bundle.
 *
 * @param {*} data parsed bundle JSON
 * @returns {{manifest: object, source: string}}
 */
export function validateBundle(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('A plugin bundle must be a JSON object');
    }
    if (typeof data.source !== 'string' || !data.source.trim()) {
        throw new Error('The bundle has no "source"');
    }
    if (data.source.length > MAX_SOURCE_BYTES) {
        throw new Error(
            `The bundled source is larger than ${MAX_SOURCE_BYTES / 1024}KB`
        );
    }
    return {
        manifest: validateRemoteManifest(data.manifest),
        source: data.source
    };
}

/**
 * Parses an import code into its parts.
 *
 * @param {string} code
 * @returns {PluginCode}
 * @throws {Error} when the code is not a usable GitHub reference
 */
export function parsePluginCode(code) {
    let value = String(code ?? '').trim();
    if (!value) {
        throw new Error('Enter a plugin code, for example owner/repo');
    }
    // Accept the URL people will naturally copy out of the address bar.
    // Trailing slashes go first, otherwise a ".git/" suffix survives the strip.
    value = value
        .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
        .replace(/^git@github\.com:/i, '')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\.git$/i, '');
    // ...including the /tree/<ref>/<path> form.
    const tree = value.match(/^([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/);
    if (tree) {
        value = `${tree[1]}/${tree[2]}${tree[4] ? `/${tree[4]}` : ''}@${tree[3]}`;
    }

    let ref = 'HEAD';
    const at = value.lastIndexOf('@');
    if (at > 0) {
        ref = value.slice(at + 1).trim();
        value = value.slice(0, at);
        if (!ref) {
            throw new Error('The ref after "@" is empty');
        }
    }

    const segments = value.split('/').filter(Boolean);
    if (segments.length < 2) {
        throw new Error(
            'Expected owner/repo, optionally followed by a path and @ref'
        );
    }
    const [owner, repo, ...rest] = segments;
    const invalid = /[^\w.-]/;
    if (invalid.test(owner) || invalid.test(repo) || invalid.test(ref)) {
        throw new Error('The code contains characters that are not allowed');
    }
    if (rest.some((segment) => segment === '..')) {
        throw new Error('The path may not contain ".."');
    }
    return { owner, repo, path: rest.join('/'), ref };
}

/**
 * @param {PluginCode} parsed
 * @param {string} file
 * @returns {string}
 */
export function rawUrlFor(parsed, file) {
    const parts = [parsed.owner, parsed.repo, parsed.ref];
    const dir = parsed.path ? `${parsed.path}/` : '';
    return `${RAW_HOST}/${parts.map(encodeURIComponent).join('/')}/${dir}${file}`;
}

/**
 * Canonical form of a code, used as the stored identity of an import.
 *
 * @param {PluginCode} parsed
 * @returns {string}
 */
export function formatPluginCode(parsed) {
    const dir = parsed.path ? `/${parsed.path}` : '';
    return `${parsed.owner}/${parsed.repo}${dir}@${parsed.ref}`;
}

/**
 * Validates a fetched `vrcx-plugin.json`.
 *
 * @param {*} manifest
 * @returns {{id: string, name: string, description: string, version: string, icon: string, category: string, entry: string, settingsSchema: object[]}}
 * @throws {Error} on anything that would break the registry or the settings UI
 */
export function validateRemoteManifest(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error(`${MANIFEST_FILE} must contain a JSON object`);
    }
    const id = String(manifest.id ?? '').trim();
    if (!/^[a-z0-9-]+$/.test(id)) {
        throw new Error(
            `"id" must be kebab-case (a-z, 0-9, -), got "${manifest.id ?? ''}"`
        );
    }
    const name = String(manifest.name ?? '').trim();
    if (!name) {
        throw new Error('"name" is required');
    }
    const entry = String(manifest.entry ?? 'index.js').trim();
    if (!entry || entry.includes('..') || entry.startsWith('/')) {
        throw new Error('"entry" must be a relative file path inside the repo');
    }
    const category = String(manifest.category ?? 'automation').trim();
    if (!CATEGORY_KEYS.has(category)) {
        throw new Error(
            `"category" must be one of: ${Array.from(CATEGORY_KEYS).join(', ')}`
        );
    }
    if (
        manifest.settingsSchema !== undefined &&
        !Array.isArray(manifest.settingsSchema)
    ) {
        throw new Error('"settingsSchema" must be an array when present');
    }
    return {
        id,
        name,
        description: String(manifest.description ?? '').trim(),
        version: String(manifest.version ?? '').trim(),
        icon: String(manifest.icon ?? 'ri-puzzle-line').trim(),
        category,
        entry,
        settingsSchema: Array.isArray(manifest.settingsSchema)
            ? manifest.settingsSchema
            : []
    };
}

/**
 * Fetches the manifest and entry source for a code, without running anything.
 *
 * @param {string} code
 * @returns {Promise<{code: string, parsed: PluginCode, manifest: object, source: string, manifestUrl: string, sourceUrl: string}>}
 */
export async function fetchRemotePlugin(code) {
    const source = parsePluginSource(code);
    if (source.kind === 'bundle') {
        return fetchBundlePlugin(source.url);
    }
    if (source.kind === 'gist') {
        return fetchGistPlugin(source.id);
    }
    return fetchRepoPlugin(source.parsed);
}

/**
 * A whole plugin from one URL.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
async function fetchBundlePlugin(url) {
    let raw;
    try {
        raw = await getText(url);
    } catch (err) {
        throw new Error(`Could not download ${url}. (${err.message})`, {
            cause: err
        });
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error(
            `${url} did not return a plugin bundle. Link directly to the bundle file, not to a web page showing it.`
        );
    }
    const { manifest, source } = validateBundle(data);
    return {
        code: url,
        parsed: null,
        manifest,
        source,
        manifestUrl: url,
        sourceUrl: url
    };
}

/**
 * A plugin from a gist holding the two files, or a single bundle file.
 *
 * @param {string} id
 * @returns {Promise<object>}
 */
async function fetchGistPlugin(id) {
    const apiUrl = `https://api.github.com/gists/${encodeURIComponent(id)}`;
    let gist;
    try {
        gist = JSON.parse(await getText(apiUrl));
    } catch (err) {
        throw new Error(
            `Could not read gist ${id} — check the id and that the gist is public. (${err.message})`,
            { cause: err }
        );
    }
    const files = gist?.files;
    if (!files || typeof files !== 'object') {
        throw new Error(`Gist ${id} has no files`);
    }

    // A gist can carry either the two-file layout or a single bundle.
    const manifestFile = files[MANIFEST_FILE];
    if (!manifestFile) {
        const bundleFile = Object.values(files).find(
            (file) =>
                typeof file?.content === 'string' &&
                file.content.includes('"vrcxPlugin"')
        );
        if (!bundleFile) {
            throw new Error(
                `Gist ${id} needs either a ${MANIFEST_FILE} plus its entry file, or a single bundle file`
            );
        }
        const { manifest, source } = validateBundle(
            JSON.parse(bundleFile.content)
        );
        return {
            code: `gist:${id}`,
            parsed: null,
            manifest,
            source,
            manifestUrl: gist.html_url ?? apiUrl,
            sourceUrl: bundleFile.raw_url ?? apiUrl
        };
    }

    const manifest = validateRemoteManifest(JSON.parse(manifestFile.content));
    const entryFile = files[manifest.entry];
    if (!entryFile?.content) {
        throw new Error(
            `Gist ${id} has no file named "${manifest.entry}", which its ${MANIFEST_FILE} points at`
        );
    }
    return {
        code: `gist:${id}`,
        parsed: null,
        manifest,
        source: entryFile.content,
        manifestUrl: gist.html_url ?? apiUrl,
        sourceUrl: entryFile.raw_url ?? apiUrl
    };
}

/**
 * @param {PluginCode} parsed
 * @returns {Promise<object>}
 */
async function fetchRepoPlugin(parsed) {
    const manifestUrl = rawUrlFor(parsed, MANIFEST_FILE);

    let raw;
    try {
        raw = await getText(manifestUrl);
    } catch (err) {
        throw new Error(
            `Could not read ${MANIFEST_FILE} at ${manifestUrl} — check the code and that the repository is public. (${err.message})`,
            { cause: err }
        );
    }
    let parsedManifest;
    try {
        parsedManifest = JSON.parse(raw);
    } catch {
        throw new Error(`${MANIFEST_FILE} is not valid JSON`);
    }
    const manifest = validateRemoteManifest(parsedManifest);

    const sourceUrl = rawUrlFor(parsed, manifest.entry);
    const source = await getText(sourceUrl);
    if (!source.trim()) {
        throw new Error(`The entry file ${manifest.entry} is empty`);
    }
    if (source.length > MAX_SOURCE_BYTES) {
        throw new Error(
            `The entry file is larger than ${MAX_SOURCE_BYTES / 1024}KB`
        );
    }

    return {
        code: formatPluginCode(parsed),
        parsed,
        manifest,
        source,
        manifestUrl,
        sourceUrl
    };
}

/**
 * Evaluates plugin source and pulls out its hooks.
 *
 * The contract is CommonJS: the entry file assigns an object with `setup` and
 * optionally `teardown` to `module.exports`.
 *
 * @param {string} source
 * @param {string} id used only in error messages
 * @returns {{setup?: Function, teardown?: Function}}
 */
export function compileRemotePlugin(source, id) {
    const module = { exports: {} };
    const factory = new Function(
        'module',
        'exports',
        `"use strict";\n${source}\n`
    );
    factory(module, module.exports);

    const exported = module.exports?.default ?? module.exports;
    if (!exported || typeof exported !== 'object') {
        throw new Error(
            `"${id}" did not assign an object to module.exports — expected { setup(ctx) {} }`
        );
    }
    if (typeof exported.setup !== 'function') {
        throw new Error(`"${id}" does not export a setup(ctx) function`);
    }
    return {
        setup: exported.setup,
        teardown:
            typeof exported.teardown === 'function'
                ? exported.teardown
                : undefined
    };
}

/**
 * Turns a stored import into a manifest the registry accepts.
 *
 * @param {{code: string, manifest: object, source: string, sourceUrl: string}} installed
 * @returns {import('./registry').PluginManifest}
 */
export function toPluginManifest(installed) {
    const { manifest, source, code, sourceUrl } = installed;
    /** @type {{setup?: Function, teardown?: Function} | null} */
    let hooks = null;

    /**
     * Compiling lazily means a plugin whose source is broken shows up in the
     * list with an error instead of taking down the whole plugin screen.
     */
    function ensureCompiled() {
        if (!hooks) {
            hooks = compileRemotePlugin(source, manifest.id);
        }
        return hooks;
    }

    return {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        icon: manifest.icon,
        category: manifest.category,
        settingsSchema: manifest.settingsSchema,
        external: true,
        source: code,
        sourceUrl,
        version: manifest.version,
        setup: (ctx) => ensureCompiled().setup(ctx),
        teardown: (ctx) => ensureCompiled().teardown?.(ctx)
    };
}
