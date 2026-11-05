import { beforeEach, describe, expect, test, vi } from 'vitest';

// Hoisted, because vi.mock's factory runs before the module body.
const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }));

vi.mock('../avtrAuth', async () => {
    const actual = await vi.importActual('../avtrAuth');
    return { ...actual, getAccessToken };
});

import {
    AvtrApiError,
    MAX_LIMIT,
    avtrRequest,
    collectAllAvatars,
    extractFileId,
    getAvatar,
    getAvatarIdByFileId,
    getMyLikes,
    getRecommendations,
    getTags,
    normalizeAvatarCard,
    normalizeAvatarCards,
    resolveAvtrUrl,
    searchAvatars,
    setAvatarLiked
} from '../avtrApi';

/**
 * @param {number} status
 * @param {object | null} body
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function reply(status, body, headers = {}) {
    return /** @type {Response} */ ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers[name] ?? null },
        json: () => Promise.resolve(body)
    });
}

/** A card with every field the API documents. */
const fullCard = {
    id: 'avtr_1',
    name: 'Example Cat',
    description: 'A cat',
    authorId: 'usr_1',
    authorName: 'Example Author',
    tags: ['cat'],
    aiTags: ['kemono'],
    styles: ['anime'],
    features: ['locomotion:gogoloco'],
    performance: { pc: 'Good', quest: 'Medium', ios: null },
    hasImpostor: true,
    image: { thumb: '/i/1/256', medium: '/i/1/512', large: 'https://cdn.example/1024' },
    price: 1500,
    isPaid: true,
    useCount: 42,
    likeCount: 412,
    viewCount: 900,
    liked: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    changedAt: '2026-03-01T00:00:00.000Z',
    changesMade: 3,
    render: { url: '/r/1/512', large: '/r/1/1024', original: '/r/1/orig', width: 1024, height: 1536 }
};

beforeEach(() => {
    getAccessToken.mockClear();
    getAccessToken.mockResolvedValue('avto_test');
});

describe('resolveAvtrUrl', () => {
    test('makes a site-relative URL absolute', () => {
        expect(resolveAvtrUrl('/i/1/256')).toBe('https://avtr.zip/i/1/256');
    });

    test('leaves an absolute URL alone', () => {
        expect(resolveAvtrUrl('https://cdn.example/x.png')).toBe('https://cdn.example/x.png');
    });

    test('is empty for nothing', () => {
        expect(resolveAvtrUrl(undefined)).toBe('');
    });
});

describe('normalizeAvatarCard', () => {
    test('maps a card onto VRCX field names', () => {
        const avatar = normalizeAvatarCard(fullCard);

        expect(avatar).toMatchObject({
            id: 'avtr_1',
            name: 'Example Cat',
            authorName: 'Example Author',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z',
            releaseStatus: 'public',
            likes: 412,
            used: 42,
            price: 1500,
            isPaid: true,
            impostor: true,
            liked: true,
            source: 'avtr.zip'
        });
    });

    test('drops platforms with no build', () => {
        // The API uses null for "no build on this platform", and keeping the
        // key would read as a platform that exists.
        expect(normalizeAvatarCard(fullCard).performance).toEqual({ pc: 'Good', quest: 'Medium' });
    });

    test('resolves image and render URLs', () => {
        const avatar = normalizeAvatarCard(fullCard);
        expect(avatar.thumbnailImageUrl).toBe('https://avtr.zip/i/1/256');
        expect(avatar.imageUrl).toBe('https://cdn.example/1024');
        expect(avatar.render.large).toBe('https://avtr.zip/r/1/1024');
    });

    test('falls back through the image sizes', () => {
        const avatar = normalizeAvatarCard({ id: 'avtr_2', image: { medium: '/i/2/512' } });
        expect(avatar.thumbnailImageUrl).toBe('https://avtr.zip/i/2/512');
        expect(avatar.imageUrl).toBe('https://avtr.zip/i/2/512');
    });

    test('survives a card with nothing but an id', () => {
        const avatar = normalizeAvatarCard({ id: 'avtr_3' });
        expect(avatar).toMatchObject({ id: 'avtr_3', tags: [], features: [], performance: {}, render: null });
    });

    test('rejects a card with no id', () => {
        expect(normalizeAvatarCard({ name: 'nameless' })).toBeNull();
    });
});

describe('normalizeAvatarCards', () => {
    test('skips unusable records', () => {
        expect(normalizeAvatarCards([fullCard, {}, null])).toHaveLength(1);
    });

    test('is empty for a non-list', () => {
        expect(normalizeAvatarCards(undefined)).toEqual([]);
    });
});

describe('avtrRequest', () => {
    test('sends the bearer token', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true }));

        await avtrRequest('/tags', { fetchImpl });

        expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer avto_test');
    });

    test('refuses when VRCX is not connected', async () => {
        getAccessToken.mockResolvedValue(null);
        await expect(avtrRequest('/tags', { fetchImpl: vi.fn() })).rejects.toThrow(/not connected/i);
    });

    test('maps an error body onto a typed error', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                reply(400, { success: false, error: 'q is too long', code: 'invalid_query', requestId: 'req_1' })
            );

        const error = await avtrRequest('/avatars/search', { fetchImpl }).catch((err) => err);

        expect(error).toBeInstanceOf(AvtrApiError);
        expect(error).toMatchObject({ status: 400, code: 'invalid_query', requestId: 'req_1' });
    });

    test('reads Retry-After off a 429', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(reply(429, { success: false, code: 'rate_limited' }, { 'Retry-After': '17' }));

        const error = await avtrRequest('/avatars/search', { fetchImpl }).catch((err) => err);

        expect(error.isRateLimited).toBe(true);
        expect(error.retryAfterSeconds).toBe(17);
    });

    test('retries once behind a forced refresh on a 401', async () => {
        getAccessToken.mockResolvedValueOnce('avto_stale').mockResolvedValueOnce('avto_fresh');
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(reply(401, { success: false, code: 'invalid_token' }))
            .mockResolvedValueOnce(reply(200, { success: true, items: [] }));

        await avtrRequest('/avatars/search', { fetchImpl });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer avto_fresh');
    });

    test('does not loop when the refreshed token fails too', async () => {
        getAccessToken.mockResolvedValueOnce('avto_stale').mockResolvedValueOnce('avto_fresh');
        const fetchImpl = vi.fn().mockResolvedValue(reply(401, { success: false, code: 'invalid_token' }));

        await expect(avtrRequest('/avatars/search', { fetchImpl })).rejects.toBeInstanceOf(AvtrApiError);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    test('leaves empty parameters off the query string', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true }));

        await avtrRequest('/avatars/search', { query: { q: 'cat', cursor: undefined }, fetchImpl });

        expect(fetchImpl.mock.calls[0][0]).toBe('https://avtr.zip/v3/avatars/search?q=cat');
    });
});

describe('searchAvatars', () => {
    test('reads the envelope', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            reply(200, {
                success: true,
                items: [fullCard],
                nextCursor: 'cur_1',
                hasMore: true,
                total: 4300,
                totalIsEstimate: true,
                warnings: ['Unknown sort "likez"; using the default.']
            })
        );

        const result = await searchAvatars({ q: 'cat', fetchImpl });

        expect(result.avatars).toHaveLength(1);
        expect(result).toMatchObject({
            nextCursor: 'cur_1',
            hasMore: true,
            total: 4300,
            totalIsEstimate: true
        });
        expect(result.warnings).toHaveLength(1);
    });

    test('reports a missing total as null rather than zero', async () => {
        // Defaulting it to 0 would read as "no matches".
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true, items: [], hasMore: false }));
        expect((await searchAvatars({ fetchImpl })).total).toBeNull();
    });

    test('clamps the limit to what the API accepts', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true, items: [] }));

        await searchAvatars({ limit: 5_000, fetchImpl });

        expect(fetchImpl.mock.calls[0][0]).toContain(`limit=${MAX_LIMIT}`);
    });

    test('passes similarTo through', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true, items: [] }));

        await searchAvatars({ q: 'cat', similarTo: 'avtr_1', fetchImpl });

        expect(fetchImpl.mock.calls[0][0]).toContain('similarTo=avtr_1');
    });
});

describe('collectAllAvatars', () => {
    test('pages while hasMore holds, keeping the query fixed', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(reply(200, { success: true, items: [fullCard], nextCursor: 'cur_1', hasMore: true }))
            .mockResolvedValueOnce(
                reply(200, { success: true, items: [{ ...fullCard, id: 'avtr_2' }], nextCursor: null, hasMore: false })
            );

        const result = await collectAllAvatars({ q: 'cat', fetchImpl });

        expect(result.avatars.map((a) => a.id)).toEqual(['avtr_1', 'avtr_2']);
        // The cursor is only valid for the query that produced it.
        expect(fetchImpl.mock.calls[1][0]).toContain('q=cat');
        expect(fetchImpl.mock.calls[1][0]).toContain('cursor=cur_1');
    });

    test('keeps going on a short page, because only hasMore is the end', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(reply(200, { success: true, items: [], nextCursor: 'cur_1', hasMore: true }))
            .mockResolvedValueOnce(reply(200, { success: true, items: [fullCard], hasMore: false }));

        const result = await collectAllAvatars({ q: 'cat', limit: 60, fetchImpl });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(result.avatars).toHaveLength(1);
    });

    test('stops at maxPages so a wide query cannot walk the index', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(reply(200, { success: true, items: [fullCard], nextCursor: 'cur', hasMore: true }));

        const result = await collectAllAvatars({ q: '', maxPages: 3, fetchImpl });

        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(result.hasMore).toBe(true);
    });

    test('collects warnings once each', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                reply(200, { success: true, items: [], nextCursor: 'c', hasMore: true, warnings: ['dropped x'] })
            )
            .mockResolvedValueOnce(reply(200, { success: true, items: [], hasMore: false, warnings: ['dropped x'] }));

        expect((await collectAllAvatars({ fetchImpl })).warnings).toEqual(['dropped x']);
    });
});

describe('getAvatar', () => {
    test('unwraps the avatar', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true, avatar: fullCard }));
        expect((await getAvatar('avtr_1', { fetchImpl }))?.id).toBe('avtr_1');
    });

    test('answers null for an unknown or hidden avatar', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(404, { success: false, code: 'not_found' }));
        expect(await getAvatar('avtr_x', { fetchImpl })).toBeNull();
    });

    test('still throws on a real failure', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(500, { success: false, code: 'internal_error' }));
        await expect(getAvatar('avtr_1', { fetchImpl })).rejects.toBeInstanceOf(AvtrApiError);
    });
});

describe('extractFileId', () => {
    test('pulls the file id out of a VRChat image URL', () => {
        expect(
            extractFileId('https://api.vrchat.cloud/api/1/file/file_0fd54378-1111-2222-3333-444455556666/1/file')
        ).toBe('file_0fd54378-1111-2222-3333-444455556666');
    });

    test('is empty when there is none', () => {
        expect(extractFileId('https://example.com/not-a-file')).toBe('');
    });
});

describe('getAvatarIdByFileId', () => {
    test('returns the avatar id', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true, fileId: '0fd', avatarId: 'avtr_1' }));
        expect(await getAvatarIdByFileId('file_0fd', { fetchImpl })).toBe('avtr_1');
    });

    test('answers null when nothing uses the image', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(404, { success: false, code: 'not_found' }));
        expect(await getAvatarIdByFileId('file_0fd', { fetchImpl })).toBeNull();
    });

    test('answers null for a malformed id', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(400, { success: false, code: 'invalid_file_id' }));
        expect(await getAvatarIdByFileId('nope', { fetchImpl })).toBeNull();
    });
});

describe('setAvatarLiked', () => {
    test('likes with PUT and reports whether it changed anything', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true, liked: true, changed: true }));

        const result = await setAvatarLiked('avtr_1', true, { fetchImpl });

        expect(fetchImpl.mock.calls[0][1].method).toBe('PUT');
        expect(result).toEqual({ liked: true, changed: true });
    });

    test('unlikes with DELETE', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true, liked: false, changed: false }));

        const result = await setAvatarLiked('avtr_1', false, { fetchImpl });

        expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE');
        // Unliking something never liked is a 200 that changed nothing.
        expect(result.changed).toBe(false);
    });
});

describe('getMyLikes', () => {
    test('reads ids and timestamps', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            reply(200, {
                success: true,
                items: [{ avatarId: 'avtr_1', createdAt: '2026-10-20T18:31:02.000Z' }],
                nextCursor: null,
                hasMore: false
            })
        );

        const result = await getMyLikes({ fetchImpl });

        expect(result.likes[0].avatarId).toBe('avtr_1');
        expect(result.hasMore).toBe(false);
    });
});

describe('getRecommendations', () => {
    test('reads ids and scores', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(reply(200, { success: true, items: [{ avatarId: 'avtr_1', score: 0.83 }] }));

        expect((await getRecommendations({ fetchImpl })).items[0].score).toBe(0.83);
    });

    test('an empty list is a normal answer, not an error', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true, items: [], hasMore: false }));
        expect((await getRecommendations({ fetchImpl })).items).toEqual([]);
    });
});

describe('getTags', () => {
    test('passes the kind through and clamps the limit', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { success: true, items: [] }));

        await getTags({ kind: 'aiTag', limit: 9_000, fetchImpl });

        expect(fetchImpl.mock.calls[0][0]).toContain('kind=aiTag');
        expect(fetchImpl.mock.calls[0][0]).toContain('limit=500');
    });
});
