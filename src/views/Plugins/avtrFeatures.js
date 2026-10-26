/**
 * Lookup helpers over avtr.zip's feature vocabulary.
 *
 * The vocabulary itself lives in `avtrFeatureCatalog.js` as a bundled snapshot.
 * Everything here is pure so the query engine and the filter panel can share it
 * and be tested on plain data.
 *
 * Feature ids are namespaced, `category:name` — `locomotion:gogoloco`. Users
 * should not have to type the namespace, so `resolveFeatureToken` accepts the
 * full id, the bare name, a whole category, or a label substring.
 */

import { FEATURE_CATALOG, FEATURE_CATALOG_URL, FEATURE_CATEGORIES } from './avtrFeatureCatalog';

export { FEATURE_CATALOG, FEATURE_CATALOG_URL, FEATURE_CATEGORIES };

/**
 * @param {string} value
 * @returns {string}
 */
function normalize(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase();
}

/**
 * Collapses the separators people mix up, so `face tracking`, `face_tracking`
 * and `face-tracking` all land on the same key.
 *
 * @param {string} value
 * @returns {string}
 */
function slug(value) {
    return normalize(value).replace(/[\s_]+/g, '-');
}

/**
 * Builds the lookup indexes for a catalog.
 *
 * @param {import('./avtrFeatureCatalog').AvtrFeature[]} [catalog]
 * @returns {{
 *     byId: Map<string, import('./avtrFeatureCatalog').AvtrFeature>;
 *     byName: Map<string, string[]>;
 *     byCategory: Map<string, import('./avtrFeatureCatalog').AvtrFeature[]>;
 * }}
 */
export function indexFeatures(catalog = FEATURE_CATALOG) {
    const byId = new Map();
    const byName = new Map();
    const byCategory = new Map();

    for (const feature of catalog) {
        if (!feature?.id) {
            continue;
        }
        const id = normalize(feature.id);
        byId.set(id, feature);

        // The bare name is ambiguous on purpose: `tail` is both a body feature
        // and a PhysBone one, and matching both is the helpful reading.
        const bare = slug(id.split(':').slice(1).join(':'));
        if (bare) {
            byName.set(bare, [...(byName.get(bare) ?? []), feature.id]);
        }

        const category = normalize(feature.category);
        byCategory.set(category, [...(byCategory.get(category) ?? []), feature]);
    }

    return { byId, byName, byCategory };
}

const DEFAULT_INDEX = indexFeatures();

/**
 * Turns one `feature:` token into the feature ids it means.
 *
 * Resolution order, first hit wins: exact id, whole category, bare name, then
 * a label or id substring. An unknown token resolves to itself so the matcher
 * can still compare it against an avatar's raw feature list.
 *
 * @param {string} token
 * @param {ReturnType<typeof indexFeatures>} [index]
 * @returns {string[]} Feature ids
 */
export function resolveFeatureToken(token, index = DEFAULT_INDEX) {
    const raw = normalize(token);
    if (!raw) {
        return [];
    }

    if (index.byId.has(raw)) {
        return [index.byId.get(raw).id];
    }

    // `feature:locomotion` — everything in that category.
    const category = index.byCategory.get(raw);
    if (category) {
        return category.map((feature) => feature.id);
    }

    const bare = index.byName.get(slug(raw));
    if (bare) {
        return bare;
    }

    const needle = slug(raw);
    const matches = [];
    for (const feature of index.byId.values()) {
        if (slug(feature.label).includes(needle) || slug(feature.id).includes(needle)) {
            matches.push(feature.id);
        }
    }
    return matches.length > 0 ? matches : [raw];
}

/**
 * Features whose label, id or category matches `text`, best first.
 *
 * Powers the filter panel's search box. An empty `text` returns the catalog in
 * its natural (most-used first, by category) order.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {import('./avtrFeatureCatalog').AvtrFeature[]} [options.catalog]
 * @returns {import('./avtrFeatureCatalog').AvtrFeature[]}
 */
export function searchFeatures(text, { limit = 0, catalog = FEATURE_CATALOG } = {}) {
    const needle = slug(text);
    if (!needle) {
        return limit > 0 ? catalog.slice(0, limit) : [...catalog];
    }

    const scored = [];
    for (const feature of catalog) {
        const label = slug(feature.label);
        const id = slug(feature.id);
        const bare = id.split(':').slice(1).join(':');

        let score = 0;
        if (label === needle || bare === needle) {
            score = 4;
        } else if (label.startsWith(needle) || bare.startsWith(needle)) {
            score = 3;
        } else if (label.includes(needle) || id.includes(needle)) {
            score = 2;
        } else if (slug(feature.category).startsWith(needle)) {
            score = 1;
        }

        if (score > 0) {
            scored.push({ feature, score });
        }
    }

    scored.sort((a, b) => b.score - a.score || b.feature.count - a.feature.count);
    const ordered = scored.map((entry) => entry.feature);
    return limit > 0 ? ordered.slice(0, limit) : ordered;
}

/**
 * The catalog grouped for the filter panel, in `FEATURE_CATEGORIES` order.
 *
 * @param {import('./avtrFeatureCatalog').AvtrFeature[]} [catalog]
 * @returns {{ id: string; label: string; features: import('./avtrFeatureCatalog').AvtrFeature[] }[]}
 */
export function groupFeaturesByCategory(catalog = FEATURE_CATALOG) {
    const { byCategory } = indexFeatures(catalog);
    const groups = [];

    for (const category of FEATURE_CATEGORIES) {
        const features = byCategory.get(normalize(category.id));
        if (features?.length) {
            groups.push({ ...category, features });
            byCategory.delete(normalize(category.id));
        }
    }

    // Anything a refresh introduced that the bundled category list predates.
    for (const [id, features] of byCategory) {
        groups.push({ id, label: id, features });
    }

    return groups;
}

/**
 * Builds the `feature:` fragment for a set of selected features.
 *
 * Ids are emitted in full (`locomotion:gogoloco`) rather than by bare name, so
 * what the filter panel produces means exactly one thing when it is read back
 * out of the search box.
 *
 * @param {string[]} ids
 * @param {'any' | 'all'} [mode]
 * @returns {string} A query fragment, or '' when nothing is selected
 */
export function buildFeatureQuery(ids, mode = 'all') {
    const unique = [...new Set((ids ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (unique.length === 0) {
        return '';
    }
    if (unique.length === 1) {
        return `feature:${unique[0]}`;
    }
    return `feature:${mode === 'any' ? 'any' : 'all'}(${unique.join(', ')})`;
}

/**
 * Normalizes an avatar's features into comparable ids.
 *
 * Accepts the shapes a provider might realistically hand back: a list of ids,
 * a list of `{ id }` objects, or an object keyed by id.
 *
 * @param {unknown} value
 * @returns {string[]} Lowercased feature ids
 */
export function normalizeAvatarFeatures(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => (typeof entry === 'string' ? entry : (entry?.id ?? entry?.feature ?? '')))
            .map(normalize)
            .filter(Boolean);
    }
    if (value && typeof value === 'object') {
        return Object.entries(value)
            .filter(([, enabled]) => Boolean(enabled))
            .map(([id]) => normalize(id))
            .filter(Boolean);
    }
    return [];
}

/**
 * Validates and normalizes a `/v3/features` payload.
 *
 * Exported separately from the fetch so the parsing can be tested without a
 * network stub.
 *
 * @param {unknown} payload
 * @returns {import('./avtrFeatureCatalog').AvtrFeature[]}
 * @throws {Error} When the payload is not a feature listing
 */
export function parseFeatureCatalog(payload) {
    const envelope = /** @type {{ items?: unknown }} */ (payload);
    const items = Array.isArray(payload) ? payload : (envelope?.items ?? null);
    if (!Array.isArray(items)) {
        throw new Error('Feature catalog response had no items array');
    }

    const features = [];
    for (const item of items) {
        const id = normalize(item?.id);
        if (!id || !id.includes(':')) {
            continue;
        }
        features.push({
            id: item.id,
            label: String(item?.label ?? id.split(':').slice(1).join(':')),
            category: String(item?.category ?? id.split(':')[0]),
            count: Number.isFinite(item?.count) ? item.count : 0
        });
    }

    if (features.length === 0) {
        throw new Error('Feature catalog response contained no usable features');
    }
    return features;
}

/**
 * Refreshes the vocabulary from avtr.zip.
 *
 * This is the one open endpoint avtr.zip serves without a challenge; their
 * avatar search is not callable this way. Callers should fall back to the
 * bundled snapshot on failure rather than surfacing an error.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.url]
 * @returns {Promise<import('./avtrFeatureCatalog').AvtrFeature[]>}
 */
export async function fetchFeatureCatalog({ fetchImpl = fetch, url = FEATURE_CATALOG_URL } = {}) {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response?.ok) {
        throw new Error(`Feature catalog request failed (${response?.status ?? 'no response'})`);
    }
    return parseFeatureCatalog(await response.json());
}
