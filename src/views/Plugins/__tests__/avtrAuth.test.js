import { beforeEach, describe, expect, test, vi } from 'vitest';

/** In-memory stand-in for the config table, so tokens round-trip. */
const store = new Map();

vi.mock('../../../services/config', () => ({
    default: {
        getString: vi.fn((key, fallback = null) => Promise.resolve(store.has(key) ? store.get(key) : fallback)),
        setString: vi.fn((key, value) => {
            store.set(key, String(value));
            return Promise.resolve();
        })
    }
}));

import {
    AVTR_SCOPES,
    AvtrAuthError,
    DEFAULT_CLIENT_ID,
    DEFAULT_SCOPES,
    clearStoredConnection,
    disconnect,
    getAccessToken,
    getClientId,
    getClientSecret,
    getStoredTokens,
    introspectToken,
    isConfidentialClient,
    isConnected,
    pollDeviceToken,
    refreshTokens,
    setClientId,
    setClientSecret,
    startDeviceAuthorization,
    tokenSetFromResponse
} from '../avtrAuth';

/**
 * @param {number} status
 * @param {object} body
 * @returns {Response}
 */
function reply(status, body) {
    return /** @type {Response} */ ({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body)
    });
}

/** Never actually waits, so the polling tests run instantly. */
const noWait = () => Promise.resolve();

beforeEach(async () => {
    store.clear();
    await setClientId('avtc_test');
});

describe('client id', () => {
    test('round-trips and trims', async () => {
        await setClientId('  avtc_padded  ');
        expect(await getClientId()).toBe('avtc_padded');
    });

    test('falls back to the baked-in id when unset', async () => {
        store.clear();
        expect(await getClientId()).toBe(DEFAULT_CLIENT_ID);
    });
});

describe('client secret', () => {
    test('is empty by default, so the client is public', async () => {
        expect(await getClientSecret()).toBe('');
        expect(await isConfidentialClient()).toBe(false);
    });

    test('round-trips and marks the client confidential', async () => {
        await setClientSecret('  avts_secret  ');
        expect(await getClientSecret()).toBe('avts_secret');
        expect(await isConfidentialClient()).toBe(true);
    });

    test('can be cleared back to a public client', async () => {
        await setClientSecret('avts_secret');
        await setClientSecret('');
        expect(await isConfidentialClient()).toBe(false);
    });
});

describe('client authentication', () => {
    const authorization = { deviceCode: 'avtd_1', expiresAt: Date.now() + 600_000, intervalMs: 1 };

    /**
     * @param {ReturnType<typeof vi.fn>} fetchImpl
     * @param {number} call
     * @returns {URLSearchParams}
     */
    function bodyOf(fetchImpl, call = 0) {
        return new URLSearchParams(fetchImpl.mock.calls[call][1].body);
    }

    test('a public client sends no secret at all', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { device_code: 'avtd_1', user_code: 'A' }));

        await startDeviceAuthorization({ fetchImpl });

        expect(bodyOf(fetchImpl).has('client_secret')).toBe(false);
    });

    test('a confidential client authenticates to the device endpoint', async () => {
        await setClientSecret('avts_secret');
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { device_code: 'avtd_1', user_code: 'A' }));

        await startDeviceAuthorization({ fetchImpl });

        expect(bodyOf(fetchImpl).get('client_secret')).toBe('avts_secret');
    });

    test('and to the token endpoint while polling', async () => {
        await setClientSecret('avts_secret');
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { access_token: 'avto_a', expires_in: 3600 }));

        await pollDeviceToken(authorization, { fetchImpl, sleep: noWait });

        expect(bodyOf(fetchImpl).get('client_secret')).toBe('avts_secret');
    });

    test('and when refreshing', async () => {
        await setClientSecret('avts_secret');
        const connect = vi
            .fn()
            .mockResolvedValue(
                reply(200, { access_token: 'avto_a', refresh_token: 'avtf_a', expires_in: 3600, scope: 'search' })
            );
        await pollDeviceToken(authorization, { fetchImpl: connect, sleep: noWait });

        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { access_token: 'avto_b', expires_in: 3600 }));
        await refreshTokens({ fetchImpl });

        expect(bodyOf(fetchImpl).get('client_secret')).toBe('avts_secret');
    });

    test('and when revoking', async () => {
        await setClientSecret('avts_secret');
        const connect = vi
            .fn()
            .mockResolvedValue(
                reply(200, { access_token: 'avto_a', refresh_token: 'avtf_a', expires_in: 3600, scope: 'search' })
            );
        await pollDeviceToken(authorization, { fetchImpl: connect, sleep: noWait });

        const fetchImpl = vi.fn().mockResolvedValue(reply(200, {}));
        await disconnect({ fetchImpl });

        expect(bodyOf(fetchImpl).get('client_secret')).toBe('avts_secret');
    });

    test('an explicit secret overrides the stored one', async () => {
        await setClientSecret('avts_stored');
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { device_code: 'avtd_1', user_code: 'A' }));

        await startDeviceAuthorization({ clientSecret: 'avts_passed', fetchImpl });

        expect(bodyOf(fetchImpl).get('client_secret')).toBe('avts_passed');
    });
});

describe('introspectToken', () => {
    test('is unavailable to a public client, which avtr.zip would refuse', async () => {
        const fetchImpl = vi.fn();
        expect(await introspectToken('avto_a', { fetchImpl })).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('asks about a token for a confidential client', async () => {
        await setClientSecret('avts_secret');
        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { active: true, scope: 'search', sub: 'acct_1' }));

        const result = await introspectToken('avto_a', { fetchImpl });

        expect(result).toMatchObject({ active: true, sub: 'acct_1' });
        expect(new URLSearchParams(fetchImpl.mock.calls[0][1].body).get('token')).toBe('avto_a');
    });

    test('falls back to the stored access token', async () => {
        await setClientSecret('avts_secret');
        const connect = vi.fn().mockResolvedValue(reply(200, { access_token: 'avto_stored', expires_in: 3600 }));
        await pollDeviceToken(
            { deviceCode: 'avtd_1', expiresAt: Date.now() + 600_000, intervalMs: 1 },
            { fetchImpl: connect, sleep: noWait }
        );

        const fetchImpl = vi.fn().mockResolvedValue(reply(200, { active: true }));
        await introspectToken('', { fetchImpl });

        expect(new URLSearchParams(fetchImpl.mock.calls[0][1].body).get('token')).toBe('avto_stored');
    });

    test('answers null when there is no token to ask about', async () => {
        await setClientSecret('avts_secret');
        expect(await introspectToken('', { fetchImpl: vi.fn() })).toBeNull();
    });
});

describe('tokenSetFromResponse', () => {
    test('reads the granted scopes rather than the requested ones', () => {
        const tokens = tokenSetFromResponse({
            access_token: 'avto_a',
            refresh_token: 'avtf_a',
            expires_in: 3600,
            scope: 'search identify'
        });
        expect(tokens.scopes).toEqual(['search', 'identify']);
    });

    test('keeps the previous refresh token when the response omits one', () => {
        const previous = { accessToken: 'avto_old', refreshToken: 'avtf_old', expiresAt: 0, scopes: ['search'] };
        const tokens = tokenSetFromResponse({ access_token: 'avto_new', expires_in: 3600 }, previous);
        expect(tokens.refreshToken).toBe('avtf_old');
        expect(tokens.scopes).toEqual(['search']);
    });

    test('turns expires_in into an absolute time', () => {
        const tokens = tokenSetFromResponse({ access_token: 'avto_a', expires_in: 60 }, null, 1_000);
        expect(tokens.expiresAt).toBe(61_000);
    });

    test('falls back to an hour when expires_in is missing', () => {
        expect(tokenSetFromResponse({ access_token: 'avto_a' }, null, 0).expiresAt).toBe(3_600_000);
    });
});

describe('startDeviceAuthorization', () => {
    test('asks for every scope and reads the code back', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            reply(200, {
                device_code: 'avtd_1',
                user_code: 'BCD-FGH-JKL',
                verification_uri: 'https://avtr.zip/activate',
                verification_uri_complete: 'https://avtr.zip/activate?code=BCD-FGH-JKL',
                expires_in: 600,
                interval: 5
            })
        );

        const authorization = await startDeviceAuthorization({ fetchImpl });

        expect(authorization.userCode).toBe('BCD-FGH-JKL');
        expect(authorization.intervalMs).toBe(5_000);
        const body = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
        expect(body.get('client_id')).toBe('avtc_test');
        expect(body.get('scope')).toBe(DEFAULT_SCOPES.join(' '));
    });

    test('refuses without a client id', async () => {
        // Passed explicitly, since a fork that strips DEFAULT_CLIENT_ID is the
        // only way the stored id resolves to nothing.
        await expect(startDeviceAuthorization({ clientId: '', fetchImpl: vi.fn() })).rejects.toThrow(/client id/i);
    });
});

describe('pollDeviceToken', () => {
    const authorization = { deviceCode: 'avtd_1', expiresAt: Date.now() + 600_000, intervalMs: 1 };

    test('keeps polling while the user has not approved yet', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(reply(400, { error: 'authorization_pending' }))
            .mockResolvedValueOnce(reply(400, { error: 'authorization_pending' }))
            .mockResolvedValueOnce(
                reply(200, { access_token: 'avto_a', refresh_token: 'avtf_a', expires_in: 3600, scope: 'search' })
            );

        const tokens = await pollDeviceToken(authorization, { fetchImpl, sleep: noWait });

        expect(tokens.accessToken).toBe('avto_a');
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        // Stored, so a reload stays connected.
        expect((await getStoredTokens())?.refreshToken).toBe('avtf_a');
    });

    test('backs off permanently on slow_down', async () => {
        const sleeps = [];
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(reply(400, { error: 'slow_down' }))
            .mockResolvedValueOnce(reply(400, { error: 'authorization_pending' }))
            .mockResolvedValueOnce(reply(200, { access_token: 'avto_a', expires_in: 3600 }));

        await pollDeviceToken(authorization, {
            fetchImpl,
            sleep: (ms) => {
                sleeps.push(ms);
                return Promise.resolve();
            }
        });

        // The raised interval sticks for the rest of the session, as avtr.zip
        // asks, rather than applying to one round.
        expect(sleeps).toEqual([1, 5_001, 5_001]);
    });

    test('stops when the user denies', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(400, { error: 'access_denied' }));
        await expect(pollDeviceToken(authorization, { fetchImpl, sleep: noWait })).rejects.toMatchObject({
            error: 'access_denied'
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('gives up once the code has expired', async () => {
        const expired = { deviceCode: 'avtd_1', expiresAt: Date.now() - 1, intervalMs: 1 };
        const fetchImpl = vi.fn();
        await expect(pollDeviceToken(expired, { fetchImpl, sleep: noWait })).rejects.toMatchObject({
            error: 'expired_token'
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('can be cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            pollDeviceToken(authorization, { fetchImpl: vi.fn(), sleep: noWait, signal: controller.signal })
        ).rejects.toMatchObject({ error: 'cancelled' });
    });
});

describe('refreshTokens', () => {
    beforeEach(async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                reply(200, { access_token: 'avto_a', refresh_token: 'avtf_a', expires_in: 3600, scope: 'search' })
            );
        await pollDeviceToken(
            { deviceCode: 'avtd_1', expiresAt: Date.now() + 600_000, intervalMs: 1 },
            { fetchImpl, sleep: noWait }
        );
    });

    test('stores the rotated refresh token', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                reply(200, { access_token: 'avto_b', refresh_token: 'avtf_b', expires_in: 3600, scope: 'search' })
            );

        await refreshTokens({ fetchImpl });

        const stored = await getStoredTokens();
        expect(stored?.accessToken).toBe('avto_b');
        expect(stored?.refreshToken).toBe('avtf_b');
    });

    test('only one refresh is in flight at a time', async () => {
        // Replaying a rotated refresh token makes avtr.zip revoke the whole
        // grant, so two concurrent callers must share one request.
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                reply(200, { access_token: 'avto_b', refresh_token: 'avtf_b', expires_in: 3600, scope: 'search' })
            );

        const [first, second] = await Promise.all([refreshTokens({ fetchImpl }), refreshTokens({ fetchImpl })]);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(first.accessToken).toBe(second.accessToken);
    });

    test('forgets the connection when the grant is gone', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(400, { error: 'invalid_grant' }));

        await expect(refreshTokens({ fetchImpl })).rejects.toBeInstanceOf(AvtrAuthError);

        expect(await isConnected()).toBe(false);
    });
});

describe('getAccessToken', () => {
    test('returns null when nothing is stored', async () => {
        expect(await getAccessToken({ fetchImpl: vi.fn() })).toBeNull();
    });

    test('uses a stored token that is still fresh', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                reply(200, { access_token: 'avto_a', refresh_token: 'avtf_a', expires_in: 3600, scope: 'search' })
            );
        await pollDeviceToken(
            { deviceCode: 'avtd_1', expiresAt: Date.now() + 600_000, intervalMs: 1 },
            { fetchImpl, sleep: noWait }
        );
        fetchImpl.mockClear();

        expect(await getAccessToken({ fetchImpl })).toBe('avto_a');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('refreshes a token that is about to expire', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                // One second left: inside the skew window, so it counts as stale.
                reply(200, { access_token: 'avto_a', refresh_token: 'avtf_a', expires_in: 1, scope: 'search' })
            )
            .mockResolvedValueOnce(
                reply(200, { access_token: 'avto_b', refresh_token: 'avtf_b', expires_in: 3600, scope: 'search' })
            );
        await pollDeviceToken(
            { deviceCode: 'avtd_1', expiresAt: Date.now() + 600_000, intervalMs: 1 },
            { fetchImpl, sleep: noWait }
        );

        expect(await getAccessToken({ fetchImpl })).toBe('avto_b');
    });
});

describe('disconnect', () => {
    test('revokes the refresh token and clears what is stored', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                reply(200, { access_token: 'avto_a', refresh_token: 'avtf_a', expires_in: 3600, scope: 'search' })
            );
        await pollDeviceToken(
            { deviceCode: 'avtd_1', expiresAt: Date.now() + 600_000, intervalMs: 1 },
            { fetchImpl, sleep: noWait }
        );

        const revoke = vi.fn().mockResolvedValue(reply(200, {}));
        await disconnect({ fetchImpl: revoke });

        const body = new URLSearchParams(revoke.mock.calls[0][1].body);
        // The refresh token, which takes every token on the grant with it.
        expect(body.get('token')).toBe('avtf_a');
        expect(await isConnected()).toBe(false);
    });

    test('clears locally even when revocation fails', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                reply(200, { access_token: 'avto_a', refresh_token: 'avtf_a', expires_in: 3600, scope: 'search' })
            );
        await pollDeviceToken(
            { deviceCode: 'avtd_1', expiresAt: Date.now() + 600_000, intervalMs: 1 },
            { fetchImpl, sleep: noWait }
        );

        await disconnect({ fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) });

        expect(await isConnected()).toBe(false);
    });
});

describe('scopes', () => {
    test('names every scope avtr.zip defines', () => {
        expect(Object.values(AVTR_SCOPES)).toEqual(['search', 'search:image', 'identify', 'likes:read', 'likes:write']);
    });
});

describe('clearStoredConnection', () => {
    test('leaves nothing behind', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                reply(200, { access_token: 'avto_a', refresh_token: 'avtf_a', expires_in: 3600, scope: 'search' })
            );
        await pollDeviceToken(
            { deviceCode: 'avtd_1', expiresAt: Date.now() + 600_000, intervalMs: 1 },
            { fetchImpl, sleep: noWait }
        );

        await clearStoredConnection();

        expect(await getStoredTokens()).toBeNull();
    });

    test('keeps the client secret, which is app config rather than a token', async () => {
        await setClientSecret('avts_secret');

        await clearStoredConnection();

        expect(await getClientSecret()).toBe('avts_secret');
    });
});
