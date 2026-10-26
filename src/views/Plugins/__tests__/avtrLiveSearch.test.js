import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../services/config', () => ({
    default: {
        getString: vi.fn().mockResolvedValue(''),
        setString: vi.fn().mockResolvedValue(undefined)
    }
}));

import {
    DEFAULT_LIMIT,
    buildSearchUrl,
    normalizeLiveAvatar,
    normalizeLiveResults,
    searchLiveAvatars
} from '../avtrLiveSearch';

describe('buildSearchUrl', () => {
    test('adds the query parameters', () => {
        expect(buildSearchUrl('https://example.test/search', 'cat ears', 10)).toBe(
            'https://example.test/search?q=cat%20ears&n=10'
        );
    });

    test('keeps an existing query string', () => {
        expect(buildSearchUrl('https://example.test/search?key=abc', 'fox', 5)).toBe(
            'https://example.test/search?key=abc&q=fox&n=5'
        );
    });

    test('defaults the limit', () => {
        expect(buildSearchUrl('https://example.test/s', 'x')).toContain(`n=${DEFAULT_LIMIT}`);
    });

    test('escapes syntax characters', () => {
        expect(buildSearchUrl('https://example.test/s', 'quest:>=Good & free')).toContain(
            'q=quest%3A%3E%3DGood%20%26%20free'
        );
    });
});

describe('normalizeLiveAvatar', () => {
    test('maps camelCase fields', () => {
        const avatar = normalizeLiveAvatar({
            id: 'avtr_1',
            name: 'Fox',
            authorName: 'Someone',
            thumbnailImageUrl: 'https://img.test/a.png',
            tags: ['fox'],
            features: ['locomotion:gogoloco'],
            price: 500,
            likes: 12
        });
        expect(avatar.id).toBe('avtr_1');
        expect(avatar.authorName).toBe('Someone');
        expect(avatar.features).toEqual(['locomotion:gogoloco']);
        expect(avatar.price).toBe(500);
        expect(avatar.likes).toBe(12);
    });

    test('maps snake_case fields', () => {
        const avatar = normalizeLiveAvatar({
            avatar_id: 'avtr_2',
            avatar_name: 'Cat',
            author_name: 'Else',
            thumbnail_image_url: 'https://img.test/b.png',
            ai_tags: ['cute'],
            feature_ids: ['body:tail'],
            product_price: 1000,
            has_impostor: true
        });
        expect(avatar.id).toBe('avtr_2');
        expect(avatar.name).toBe('Cat');
        expect(avatar.aiTags).toEqual(['cute']);
        expect(avatar.features).toEqual(['body:tail']);
        expect(avatar.price).toBe(1000);
        expect(avatar.impostor).toBe(true);
    });

    test('accepts tag objects as well as strings', () => {
        expect(normalizeLiveAvatar({ id: 'a', tags: [{ name: 'fox' }, 'cat'] }).tags).toEqual(['fox', 'cat']);
    });

    test('accepts a comma separated list', () => {
        expect(normalizeLiveAvatar({ id: 'a', platforms: 'standalonewindows, android' }).platforms).toEqual([
            'standalonewindows',
            'android'
        ]);
    });

    test('falls back to the image url for a missing thumbnail', () => {
        expect(normalizeLiveAvatar({ id: 'a', image_url: 'https://img.test/c.png' }).thumbnailImageUrl).toBe(
            'https://img.test/c.png'
        );
    });

    test('returns null without an id', () => {
        expect(normalizeLiveAvatar({ name: 'nameless' })).toBeNull();
    });

    test('fills the fields the query engine reads', () => {
        const avatar = normalizeLiveAvatar({ id: 'a' });
        expect(avatar.tags).toEqual([]);
        expect(avatar.price).toBe(0);
        expect(avatar.impostor).toBe(false);
        expect(avatar.releaseStatus).toBe('public');
    });
});

describe('normalizeLiveResults', () => {
    test('accepts a bare array', () => {
        expect(normalizeLiveResults([{ id: 'a' }, { id: 'b' }])).toHaveLength(2);
    });

    test.each(['items', 'results', 'data'])('accepts an envelope keyed by %s', (envelopeKey) => {
        expect(normalizeLiveResults({ [envelopeKey]: [{ id: 'a' }] })).toHaveLength(1);
    });

    test('drops records without an id', () => {
        expect(normalizeLiveResults([{ id: 'a' }, { name: 'no id' }])).toHaveLength(1);
    });

    test('anything unrecognised is no results', () => {
        expect(normalizeLiveResults(null)).toEqual([]);
        expect(normalizeLiveResults({ success: false })).toEqual([]);
    });
});

describe('searchLiveAvatars', () => {
    test('fetches and normalizes', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ id: 'avtr_1' }] }) });
        const results = await searchLiveAvatars('fox', { fetchImpl, url: 'https://example.test/s' });
        expect(results).toHaveLength(1);
        expect(fetchImpl.mock.calls[0][0]).toContain('q=fox');
    });

    test('throws when nothing is configured', async () => {
        await expect(searchLiveAvatars('fox', { fetchImpl: vi.fn() })).rejects.toThrow(/No live avatar search/);
    });

    test('throws on a failed request', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });
        await expect(searchLiveAvatars('fox', { fetchImpl, url: 'https://example.test/s' })).rejects.toThrow(/429/);
    });
});
