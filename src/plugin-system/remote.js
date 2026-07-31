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
    const parsed = parsePluginCode(code);
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
