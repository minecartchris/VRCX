/**
 * Client for the avtr.zip v3 HTTP API.
 *
 * Every route here needs an OAuth token; `avtrAuth` owns getting one. This
 * module is the layer above it: one request helper that attaches the bearer,
 * unwraps the `{ success: true, … }` envelope, turns `{ success: false, … }`
 * into a typed error, and one function per endpoint.
 *
 * The API returns its own "avatar card" shape. `normalizeAvatarCard` maps that
 * onto the shape the rest of VRCX (and `avatarQuery`) already works in, so the
 * local query engine, the feature filter and the suggestion cards keep working
 * unchanged against live results.
 *
 * Three behaviours of the API are easy to get wrong and are handled here:
 *
 * - `hasMore` is the only end-of-list signal. A page shorter than `limit` is not the end, because avatars hidden since
 *   the page was cached are dropped.
 * - Cursors are signed against the query that produced them, so paging keeps `q` and `sort` fixed and never rebuilds a
 *   cursor.
 * - Unknown facets and sorts are _not_ errors: they are dropped and reported in `warnings`, which callers are expected to
 *   show, or a typo'd query quietly means something narrower than the user typed.
 *
 * @see https://avtr.zip/developers/api
 */

import { AVTR_API_BASE, AvtrAuthError, getAccessToken } from './avtrAuth';

/** Where site-relative image and render URLs (`/i/…`, `/r/…`) resolve against. */
export const AVTR_SITE_BASE = 'https://avtr.zip';

/** The API's own cap on a page, and what it uses when `limit` is omitted. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 60;

/** Hard stop for `collectAll`, so a wide query cannot walk the whole index. */
const DEFAULT_MAX_PAGES = 10;

/**
 * A failed API call. `code` is avtr.zip's machine-readable reason
 * (`invalid_query`, `rate_limited`, `not_found`, …) and is the thing to branch
 * on; `status` and `message` are for logs and the UI.
 */
export class AvtrApiError extends Error {
    /**
     * @param {object} init
     * @param {number} init.status
     * @param {string} init.code
     * @param {string} init.message
     * @param {string} [init.requestId]
     * @param {number} [init.retryAfterSeconds]
     */
    constructor({ status, code, message, requestId = '', retryAfterSeconds = 0 }) {
        super(message);
        this.name = 'AvtrApiError';
        this.status = status;
        this.code = code;
        this.requestId = requestId;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    /** @returns {boolean} Whether the token needs refreshing or re-granting */
    get isAuthFailure() {
        return this.status === 401 || this.code === 'invalid_token';
    }

    /** @returns {boolean} Whether backing off and retrying is the right move */
    get isRateLimited() {
        return this.status === 429;
    }
}

/**
 * @param {string | null | undefined} url
 * @returns {string} An absolute URL, or '' when there was nothing to resolve
 */
export function resolveAvtrUrl(url) {
    const value = String(url ?? '').trim();
    if (!value) {
        return '';
    }
    if (/^https?:\/\//i.test(value)) {
        return value;
    }
    return `${AVTR_SITE_BASE}${value.startsWith('/') ? '' : '/'}${value}`;
}

/**
 * @param {number | undefined} limit
 * @returns {number} Clamped into the range the API accepts
 */
function clampLimit(limit) {
    const value = Number(limit);
    if (!Number.isFinite(value)) {
        return DEFAULT_LIMIT;
    }
    return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

/**
 * @param {Response} response
 * @param {any} payload
 * @returns {AvtrApiError}
 */
function errorFromResponse(response, payload) {
    const header = Number(response?.headers?.get?.('Retry-After'));
    return new AvtrApiError({
        status: response?.status ?? 0,
        code: String(payload?.code ?? 'http_error'),
        message: String(payload?.error ?? `avtr.zip request failed (${response?.status ?? 'no response'})`),
        requestId: String(payload?.requestId ?? ''),
        retryAfterSeconds: Number(payload?.retryAfterSeconds) || (Number.isFinite(header) ? header : 0)
    });
}

/**
 * One authenticated call.
 *
 * A 401 is retried exactly once behind a forced token refresh, which covers
 * the ordinary case of an access token that expired between two requests. A
 * second 401 is reported, because retrying further would just loop.
 *
 * @param {string} path Below `AVTR_API_BASE`, e.g. `/avatars/search`
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, unknown>} [options.query]
 * @param {BodyInit} [options.body]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.accessToken] Skips the token lookup
 * @param {boolean} [options.retryOnAuthFailure]
 * @returns {Promise<any>} The parsed body, envelope included
 * @throws {AvtrApiError} On any non-2xx response
 * @throws {AvtrAuthError} When VRCX is not connected
 */
export async function avtrRequest(
    path,
    { method = 'GET', query, body, fetchImpl = fetch, accessToken, retryOnAuthFailure = true } = {}
) {
    const token = accessToken ?? (await getAccessToken({ fetchImpl }));
    if (!token) {
        throw new AvtrAuthError('invalid_token', 'VRCX is not connected to avtr.zip');
    }

    const url = new URL(`${AVTR_API_BASE}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(name, String(value));
        }
    }

    const response = await fetchImpl(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        body
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (response?.ok) {
        return payload;
    }

    const error = errorFromResponse(response, payload);
    if (error.isAuthFailure && retryOnAuthFailure) {
        const fresh = await getAccessToken({ fetchImpl, forceRefresh: true });
        if (fresh && fresh !== token) {
            return avtrRequest(path, {
                method,
                query,
                body,
                fetchImpl,
                accessToken: fresh,
                retryOnAuthFailure: false
            });
        }
    }
    throw error;
}

/**
 * Maps one avatar card onto VRCX's avatar shape.
 *
 * Field names follow what VRCX already uses for VRChat avatars
 * (`thumbnailImageUrl`, `created_at`, `likes`, `used`) so cards from here drop
 * straight into the same components and the same query engine. The card's own
 * extras that have no VRChat equivalent are kept under their API names.
 *
 * @param {object} card A `/v3` avatar card
 * @returns {object | null} Null when the card has no id
 */
export function normalizeAvatarCard(card) {
    const id = card?.id;
    if (!id) {
        return null;
    }

    const image = card?.image ?? {};
    const thumb = resolveAvtrUrl(image.thumb);
    const medium = resolveAvtrUrl(image.medium);
    const large = resolveAvtrUrl(image.large);

    // Only platforms with a build: the API uses null for "no build on this
    // platform", and a null kept here would read as a platform that exists.
    const performance = {};
    for (const platform of ['pc', 'quest', 'ios']) {
        const rating = card?.performance?.[platform];
        if (rating) {
            performance[platform] = rating;
        }
    }

    const render = card?.render
        ? {
              url: resolveAvtrUrl(card.render.url),
              large: resolveAvtrUrl(card.render.large),
              original: resolveAvtrUrl(card.render.original),
              width: Number(card.render.width) || 0,
              height: Number(card.render.height) || 0
          }
        : null;

    return {
        id: String(id),
        name: String(card.name ?? ''),
        description: String(card.description ?? ''),
        authorId: String(card.authorId ?? ''),
        authorName: String(card.authorName ?? ''),
        imageUrl: large || medium || thumb,
        thumbnailImageUrl: thumb || medium || large,
        created_at: String(card.createdAt ?? '0001-01-01T00:00:00.0000000Z'),
        updated_at: String(card.updatedAt ?? '0001-01-01T00:00:00.0000000Z'),
        // Everything the API lists is public; it has no notion of private.
        releaseStatus: 'public',
        tags: Array.isArray(card.tags) ? card.tags : [],
        aiTags: Array.isArray(card.aiTags) ? card.aiTags : [],
        styles: Array.isArray(card.styles) ? card.styles : [],
        features: Array.isArray(card.features) ? card.features : [],
        performance,
        price: Number(card.price) || 0,
        isPaid: Boolean(card.isPaid),
        impostor: Boolean(card.hasImpostor),
        likes: Number(card.likeCount) || 0,
        used: Number(card.useCount) || 0,
        // Card extras with no VRChat counterpart.
        viewCount: Number(card.viewCount) || 0,
        changedAt: String(card.changedAt ?? ''),
        changesMade: Number(card.changesMade) || 0,
        liked: Boolean(card.liked),
        render,
        /** Where this record came from, so the UI can label it. */
        source: 'avtr.zip'
    };
}

/**
 * @param {unknown} items
 * @returns {object[]} Normalized avatars, skipping unusable records
 */
export function normalizeAvatarCards(items) {
    if (!Array.isArray(items)) {
        return [];
    }
    return items.map(normalizeAvatarCard).filter(Boolean);
}

/**
 * `GET /v3/avatars/search` — the main search. Needs `search`.
 *
 * @param {object} [options]
 * @param {string} [options.q] A query in avtr.zip's query language
 * @param {number} [options.limit]
 * @param {string} [options.cursor] From a previous page's `nextCursor`
 * @param {string} [options.similarTo] Restrict to one avatar's nearest 500
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{
 *     avatars: object[];
 *     nextCursor: string | null;
 *     hasMore: boolean;
 *     total: number | null;
 *     totalIsEstimate: boolean;
 *     warnings: string[];
 * }>}
 */
export async function searchAvatars({ q = '', limit = DEFAULT_LIMIT, cursor, similarTo, fetchImpl = fetch } = {}) {
    const payload = await avtrRequest('/avatars/search', {
        query: { q, limit: clampLimit(limit), cursor, similarTo },
        fetchImpl
    });

    return {
        avatars: normalizeAvatarCards(payload?.items),
        nextCursor: payload?.nextCursor ?? null,
        hasMore: Boolean(payload?.hasMore),
        // `total` is sometimes absent, and defaulting it to 0 would read as
        // "no matches"; null says "not reported".
        total: Object.hasOwn(payload ?? {}, 'total') ? Number(payload.total) : null,
        totalIsEstimate: Boolean(payload?.totalIsEstimate),
        warnings: Array.isArray(payload?.warnings) ? payload.warnings : []
    };
}

/**
 * Pages a search while `hasMore` holds, up to `maxPages`.
 *
 * The cursor is passed back untouched and `q` never changes between pages,
 * which is what keeps the signed cursor valid.
 *
 * @param {object} [options] As `searchAvatars`, plus:
 * @param {string} [options.q]
 * @param {number} [options.limit]
 * @param {number} [options.maxPages]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ avatars: object[]; warnings: string[]; hasMore: boolean }>}
 */
export async function collectAllAvatars({
    q = '',
    limit = DEFAULT_LIMIT,
    maxPages = DEFAULT_MAX_PAGES,
    fetchImpl = fetch
} = {}) {
    const avatars = [];
    const warnings = new Set();
    let cursor;
    let hasMore = false;

    for (let page = 0; page < maxPages; page += 1) {
        const result = await searchAvatars({ q, limit, cursor, fetchImpl });
        avatars.push(...result.avatars);
        for (const warning of result.warnings) {
            warnings.add(warning);
        }
        hasMore = result.hasMore;
        cursor = result.nextCursor ?? undefined;
        // A short page is not the end; only hasMore is.
        if (!hasMore || !cursor) {
            break;
        }
    }

    return { avatars, warnings: [...warnings], hasMore };
}

/**
 * `GET /v3/avatars/:id`. Needs `search`.
 *
 * An unknown avatar and a hidden one both answer 404, so this is not an
 * existence check.
 *
 * @param {string} avatarId
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<object | null>} Null on 404
 */
export async function getAvatar(avatarId, { fetchImpl = fetch } = {}) {
    try {
        const payload = await avtrRequest(`/avatars/${encodeURIComponent(avatarId)}`, { fetchImpl });
        return normalizeAvatarCard(payload?.avatar);
    } catch (err) {
        if (err instanceof AvtrApiError && err.status === 404) {
            return null;
        }
        throw err;
    }
}

/**
 * `GET /v3/avatars/:id/similar` — visually similar, most similar first.
 * Needs `search`.
 *
 * @param {string} avatarId
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {string} [options.cursor]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ avatars: object[]; nextCursor: string | null; hasMore: boolean }>}
 */
export async function getSimilarAvatars(avatarId, { limit = DEFAULT_LIMIT, cursor, fetchImpl = fetch } = {}) {
    const payload = await avtrRequest(`/avatars/${encodeURIComponent(avatarId)}/similar`, {
        query: { limit: clampLimit(limit), cursor },
        fetchImpl
    });
    return {
        avatars: normalizeAvatarCards(payload?.items),
        nextCursor: payload?.nextCursor ?? null,
        hasMore: Boolean(payload?.hasMore)
    };
}

/**
 * Pulls the VRChat image file id out of a thumbnail URL.
 *
 * VRChat image URLs carry the id as `file_<uuid>` in the path; the API takes
 * either that or the bare uuid.
 *
 * @param {string} url
 * @returns {string} The file id, or '' when there is none
 */
export function extractFileId(url) {
    const match = String(url ?? '').match(/file_[0-9a-f-]{36}/i);
    return match ? match[0] : '';
}

/**
 * `GET /v3/avatars/by-file/:fileId` — "which avatar is this picture?" as an
 * exact lookup. Needs `search`.
 *
 * @param {string} fileId `file_<uuid>` or the bare uuid
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<string | null>} The avatar id, or null when nothing uses it
 */
export async function getAvatarIdByFileId(fileId, { fetchImpl = fetch } = {}) {
    try {
        const payload = await avtrRequest(`/avatars/by-file/${encodeURIComponent(fileId)}`, { fetchImpl });
        return payload?.avatarId ?? null;
    } catch (err) {
        if (err instanceof AvtrApiError && (err.status === 404 || err.code === 'invalid_file_id')) {
            return null;
        }
        throw err;
    }
}

/**
 * `POST /v3/avatars/search-by-image` — reverse image search. Needs
 * `search:image`.
 *
 * `q` filters the 500 nearest matches rather than the whole index, and results
 * stay in similarity order unless `q` carries a `sort:`. One page only.
 *
 * @param {Blob | File} image PNG, JPEG, GIF or WebP, up to 10 MiB
 * @param {object} [options]
 * @param {string} [options.q]
 * @param {number} [options.limit]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ avatars: object[]; tookMs: number; warnings: string[] }>}
 */
export async function searchAvatarsByImage(image, { q = '', limit = DEFAULT_LIMIT, fetchImpl = fetch } = {}) {
    const form = new FormData();
    form.append('image', image);

    const payload = await avtrRequest('/avatars/search-by-image', {
        method: 'POST',
        query: { limit: clampLimit(limit), q },
        body: form,
        fetchImpl
    });

    return {
        avatars: normalizeAvatarCards(payload?.items),
        tookMs: Number(payload?.tookMs) || 0,
        warnings: Array.isArray(payload?.warnings) ? payload.warnings : []
    };
}

/**
 * `GET /v3/tags` — the most common tags by avatar count. Needs `search`.
 *
 * @param {object} [options]
 * @param {'tag' | 'aiTag'} [options.kind] Omit for both
 * @param {number} [options.limit] 1–500
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ name: string; kind: string; count: number }[]>}
 */
export async function getTags({ kind, limit = 100, fetchImpl = fetch } = {}) {
    const payload = await avtrRequest('/tags', {
        query: { kind, limit: Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))) },
        fetchImpl
    });
    return Array.isArray(payload?.items) ? payload.items : [];
}

/**
 * `GET /v3/features` — every catalogued feature with counts. Needs `search`.
 *
 * An OAuth token always gets the full list, NSFW entries included, so callers
 * showing this to other people filter on `nsfw` themselves.
 *
 * @param {object} [options]
 * @param {string} [options.category]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ id: string; label: string; category: string; nsfw: boolean; count: number }[]>}
 */
export async function getFeatures({ category, fetchImpl = fetch } = {}) {
    const payload = await avtrRequest('/features', { query: { category }, fetchImpl });
    return Array.isArray(payload?.items) ? payload.items : [];
}

/**
 * `GET /v3/authors` — the author directory. Needs `search`.
 *
 * @param {object} [options]
 * @param {string} [options.q] Matched against the author's name
 * @param {'avatars' | 'uses' | 'likes' | 'name'} [options.sort]
 * @param {number} [options.limit]
 * @param {string} [options.cursor] Bound to the sort it came from
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ authors: object[]; nextCursor: string | null; hasMore: boolean }>}
 */
export async function getAuthors({ q, sort = 'avatars', limit = 48, cursor, fetchImpl = fetch } = {}) {
    const payload = await avtrRequest('/authors', {
        query: { q, sort, limit: clampLimit(limit), cursor },
        fetchImpl
    });
    return {
        authors: Array.isArray(payload?.items) ? payload.items : [],
        nextCursor: payload?.nextCursor ?? null,
        hasMore: Boolean(payload?.hasMore)
    };
}

/**
 * `GET /v3/authors/:id` — one author's page. Needs `search`.
 *
 * Merged pages answer with the primary author, so `author.id` can differ from
 * the id asked for. `bioMarkdown` is author-written: render it with a
 * sanitizing renderer, never as raw HTML.
 *
 * @param {string} authorId
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<object | null>} Null on 404
 */
export async function getAuthor(authorId, { fetchImpl = fetch } = {}) {
    try {
        const payload = await avtrRequest(`/authors/${encodeURIComponent(authorId)}`, { fetchImpl });
        return payload?.author ?? null;
    } catch (err) {
        if (err instanceof AvtrApiError && err.status === 404) {
            return null;
        }
        throw err;
    }
}

/**
 * `PUT`/`DELETE /v3/avatars/:id/like`. Needs `likes:write` and a live VRChat
 * link on the user's avtr.zip account.
 *
 * Both are idempotent. `liked` is the state after the call, so paint the UI
 * from it; `changed` says whether this call caused it, and only `changed`
 * should trigger a side effect, or a retry fires it twice.
 *
 * @param {string} avatarId
 * @param {boolean} liked Desired state
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ liked: boolean; changed: boolean }>}
 */
export async function setAvatarLiked(avatarId, liked, { fetchImpl = fetch } = {}) {
    const payload = await avtrRequest(`/avatars/${encodeURIComponent(avatarId)}/like`, {
        method: liked ? 'PUT' : 'DELETE',
        fetchImpl
    });
    return { liked: Boolean(payload?.liked), changed: Boolean(payload?.changed) };
}

/**
 * `GET /v3/me/likes` — the user's likes, newest first. Needs `likes:read`.
 *
 * Items are ids and timestamps, not cards.
 *
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {string} [options.cursor]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{
 *     likes: { avatarId: string; createdAt: string }[];
 *     nextCursor: string | null;
 *     hasMore: boolean;
 * }>}
 */
export async function getMyLikes({ limit = 50, cursor, fetchImpl = fetch } = {}) {
    const payload = await avtrRequest('/me/likes', {
        query: { limit: clampLimit(limit), cursor },
        fetchImpl
    });
    return {
        likes: Array.isArray(payload?.items) ? payload.items : [],
        nextCursor: payload?.nextCursor ?? null,
        hasMore: Boolean(payload?.hasMore)
    };
}

/**
 * `GET /v3/recommendations` — avatars picked from the user's likes and recent
 * use. Needs `likes:read`.
 *
 * Returns ids and scores, with no cursor: the list changes whenever the user
 * likes something, so it cannot page stably. An empty list is a normal answer
 * for a user with no likes yet, not an error.
 *
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ items: { avatarId: string; score: number }[]; hasMore: boolean }>}
 */
export async function getRecommendations({ limit = DEFAULT_LIMIT, fetchImpl = fetch } = {}) {
    const payload = await avtrRequest('/recommendations', {
        query: { limit: clampLimit(limit) },
        fetchImpl
    });
    return {
        items: Array.isArray(payload?.items) ? payload.items : [],
        hasMore: Boolean(payload?.hasMore)
    };
}

/**
 * `GET /v3/oauth/userinfo` — who the token acts for. Needs `identify`.
 *
 * `sub` is the stable avtr.zip account id; key stored records on it. The
 * VRChat display name is whatever avtr.zip last saw and may be out of date.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<object | null>}
 */
export async function getUserInfo({ fetchImpl = fetch } = {}) {
    const payload = await avtrRequest('/oauth/userinfo', { fetchImpl });
    return payload?.user ?? null;
}
