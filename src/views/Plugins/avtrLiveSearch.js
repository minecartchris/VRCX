/**
 * Optional live avatar-search provider.
 *
 * Avtr.zip's own search sits behind a Cloudflare Turnstile challenge, so VRCX
 * cannot call it directly and nothing is configured by default. This module
 * exists so that if you do have a reachable endpoint — avtr.zip publishing a
 * VRCX-style route, a mirror, or your own proxy — you can point the Plugins
 * avatar search at it without touching the query language: results are mapped
 * into the same avatar shape the local engine already filters and sorts.
 *
 * Expected contract of whatever you configure:
 * GET <url>?q=<query>&n=<limit>
 * 200 with either a bare array of avatars or `{ items: [...] }`.
 * Field names may be camelCase or snake_case; both are accepted.
 */

import configRepository from '../../services/config';

export const LIVE_SEARCH_URL_KEY = 'VRCX_avtrLiveSearchUrl';

/** Matches the cap the local search already applies to a page of results. */
export const DEFAULT_LIMIT = 60;

/**
 * @returns {Promise<string>} The configured endpoint, or '' when unset
 */
export async function getLiveSearchUrl() {
    return (await configRepository.getString(LIVE_SEARCH_URL_KEY, '')) ?? '';
}

/**
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function setLiveSearchUrl(url) {
    await configRepository.setString(LIVE_SEARCH_URL_KEY, String(url ?? '').trim());
}

/**
 * Adds the query parameters to a configured base URL.
 *
 * Any query string already on the base is preserved, so an endpoint that needs
 * its own key or version parameter keeps working.
 *
 * @param {string} base
 * @param {string} query
 * @param {number} [limit]
 * @returns {string}
 */
export function buildSearchUrl(base, query, limit = DEFAULT_LIMIT) {
    const separator = String(base).includes('?') ? '&' : '?';
    return `${base}${separator}q=${encodeURIComponent(query)}&n=${encodeURIComponent(limit)}`;
}

/**
 * @param {object} source
 * @param {string[]} names
 * @returns {unknown}
 */
function pick(source, names) {
    for (const name of names) {
        const value = source?.[name];
        if (value !== undefined && value !== null && value !== '') {
            return value;
        }
    }
    return undefined;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function toList(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => (typeof entry === 'string' ? entry : (entry?.name ?? entry?.id ?? '')))
            .filter(Boolean);
    }
    if (typeof value === 'string' && value) {
        return value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
    }
    return [];
}

/**
 * Maps one provider record onto the avatar shape the query engine expects.
 *
 * @param {object} raw
 * @returns {object | null} Null when the record has no usable id
 */
export function normalizeLiveAvatar(raw) {
    const id = pick(raw, ['id', 'Id', 'avatar_id', 'avatarId']);
    if (!id) {
        return null;
    }

    return {
        id: String(id),
        name: String(pick(raw, ['name', 'Name', 'avatar_name']) ?? ''),
        description: String(pick(raw, ['description', 'Description']) ?? ''),
        authorId: String(pick(raw, ['authorId', 'author_id', 'AuthorId']) ?? ''),
        authorName: String(pick(raw, ['authorName', 'author_name', 'AuthorName', 'author']) ?? ''),
        imageUrl: String(pick(raw, ['imageUrl', 'image_url']) ?? ''),
        thumbnailImageUrl: String(
            pick(raw, ['thumbnailImageUrl', 'thumbnail_image_url', 'imageUrl', 'image_url']) ?? ''
        ),
        created_at: String(pick(raw, ['created_at', 'createdAt']) ?? '0001-01-01T00:00:00.0000000Z'),
        updated_at: String(pick(raw, ['updated_at', 'updatedAt']) ?? '0001-01-01T00:00:00.0000000Z'),
        releaseStatus: String(pick(raw, ['releaseStatus', 'release_status']) ?? 'public'),
        tags: toList(pick(raw, ['tags', 'Tags'])),
        aiTags: toList(pick(raw, ['aiTags', 'ai_tags'])),
        styles: toList(pick(raw, ['styles', 'style'])),
        features: toList(pick(raw, ['features', 'feature_ids', 'featureIds'])),
        platforms: toList(pick(raw, ['platforms', 'platform'])),
        performance: pick(raw, ['performance', 'performance_ratings', 'performanceRatings']) ?? undefined,
        unityPackages: Array.isArray(raw?.unityPackages) ? raw.unityPackages : undefined,
        price: Number(pick(raw, ['price', 'productPrice', 'product_price']) ?? 0) || 0,
        impostor: Boolean(pick(raw, ['impostor', 'hasImpostor', 'has_impostor']) ?? false),
        likes: Number(pick(raw, ['likes', 'like_count', 'likeCount']) ?? 0) || 0,
        used: Number(pick(raw, ['used', 'usage', 'wear_count', 'wearCount']) ?? 0) || 0
    };
}

/**
 * @param {unknown} payload
 * @returns {object[]} Avatars, skipping records without an id
 */
export function normalizeLiveResults(payload) {
    const envelope = /** @type {{ items?: unknown; results?: unknown; data?: unknown }} */ (payload);
    const items = Array.isArray(payload) ? payload : (envelope?.items ?? envelope?.results ?? envelope?.data ?? null);
    if (!Array.isArray(items)) {
        return [];
    }
    return items.map(normalizeLiveAvatar).filter(Boolean);
}

/**
 * Queries the configured provider.
 *
 * The raw query string is passed straight through: a provider that speaks the
 * same syntax can filter server side, and one that only does free text will
 * simply return a broader set, which the local engine then narrows.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.url] Overrides the configured endpoint
 * @param {number} [options.limit]
 * @returns {Promise<object[]>}
 * @throws {Error} When no endpoint is configured or the request fails
 */
export async function searchLiveAvatars(query, { fetchImpl = fetch, url, limit = DEFAULT_LIMIT } = {}) {
    const base = url ?? (await getLiveSearchUrl());
    if (!base) {
        throw new Error('No live avatar search endpoint is configured');
    }

    const response = await fetchImpl(buildSearchUrl(base, query, limit), {
        headers: { Accept: 'application/json' }
    });
    if (!response?.ok) {
        throw new Error(`Live avatar search failed (${response?.status ?? 'no response'})`);
    }
    return normalizeLiveResults(await response.json());
}
