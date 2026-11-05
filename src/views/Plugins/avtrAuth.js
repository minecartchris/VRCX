/**
 * OAuth 2.0 device-code client for avtr.zip.
 *
 * The device-code grant avoids needing a redirect listener in either the
 * Electron or the CefSharp build: the user presses Connect, VRCX shows a
 * nine-letter code, they approve it at https://avtr.zip/activate, and we poll
 * the token endpoint until it is granted.
 *
 * Both avtr.zip client types work here:
 *
 * - A **public** client sends `client_id` alone. This is the right type for a build you distribute, because there is no
 *   secret for anyone to extract.
 * - A **confidential** client must also authenticate to the device, token and revoke endpoints with its `avts_…` secret,
 *   so VRCX stores one when it is configured. Keep this for a build that stays on your own machine: the secret sits in
 *   the local config table in plaintext, and anyone who gets the config file — or a copy of a build that has it baked
 *   in — can act as your whole app. avtr.zip's own guidance is not to put a secret in a desktop app. The secret is
 *   deliberately never baked into the source: it is entered per install, and `clearStoredConnection` leaves it alone
 *   because it is app configuration rather than connection state.
 *
 * Tokens live in the config table, not in memory: an access token lasts an
 * hour, and the refresh token lasts 90 days and is *rotated on every use*.
 * Presenting a refresh token twice is treated as theft by avtr.zip and revokes
 * the whole grant, so two rules shape this module:
 *
 * 1. Only ever one refresh in flight (`refreshInFlight`).
 * 2. The new refresh token is persisted _before_ the new access token is handed to a caller, so a crash mid-refresh cannot
 *    leave us holding a retired token.
 *
 * @see https://avtr.zip/developers/authentication
 */

import configRepository from '../../services/config';

/** Where the OAuth endpoints live. The consent pages are on the website. */
export const AVTR_API_BASE = 'https://avtr.zip/v3';
export const AVTR_ACTIVATE_URL = 'https://avtr.zip/activate';

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Every scope avtr.zip defines. `likes:*` additionally need the user to have a
 * VRChat account linked on avtr.zip, which they do if they use the site.
 *
 * @see https://avtr.zip/developers/scopes
 */
export const AVTR_SCOPES = Object.freeze({
    search: 'search',
    searchImage: 'search:image',
    identify: 'identify',
    likesRead: 'likes:read',
    likesWrite: 'likes:write'
});

/** What VRCX asks for: search, image search, identity and likes. */
export const DEFAULT_SCOPES = Object.freeze([
    AVTR_SCOPES.search,
    AVTR_SCOPES.searchImage,
    AVTR_SCOPES.identify,
    AVTR_SCOPES.likesRead,
    AVTR_SCOPES.likesWrite
]);

/**
 * Baked-in client id for this fork's registered app.
 *
 * A client id is public — it is handed to anyone who opens the consent screen —
 * so committing it is fine, and it saves every user pasting the same string.
 * A secret never belongs here; see the note at the top. Setting a client id in
 * Plugins > Avatars overrides this one.
 */
export const DEFAULT_CLIENT_ID = 'avtc_Pb55L1zLReud-lfgkpUN3A';

const CLIENT_ID_KEY = 'VRCX_avtrClientId';
const CLIENT_SECRET_KEY = 'VRCX_avtrClientSecret';
const ACCESS_TOKEN_KEY = 'VRCX_avtrAccessToken';
const REFRESH_TOKEN_KEY = 'VRCX_avtrRefreshToken';
const EXPIRES_AT_KEY = 'VRCX_avtrTokenExpiresAt';
const SCOPES_KEY = 'VRCX_avtrGrantedScopes';
const ACCOUNT_KEY = 'VRCX_avtrAccount';

/**
 * Refresh this many milliseconds before the access token actually expires, so
 * a request that is already in flight when the clock runs out still lands.
 */
const EXPIRY_SKEW_MS = 60_000;

/** Avtr.zip tells us to add exactly this much on a `slow_down`. */
const SLOW_DOWN_STEP_MS = 5_000;

/**
 * An OAuth-protocol failure. These come back as `{ error, error_description }`
 * rather than the API's `{ success: false }` envelope.
 */
export class AvtrAuthError extends Error {
    /**
     * @param {string} error The OAuth error code, e.g. `invalid_grant`
     * @param {string} [description]
     * @param {number} [status]
     */
    constructor(error, description = '', status = 0) {
        super(description || error);
        this.name = 'AvtrAuthError';
        this.error = error;
        this.description = description;
        this.status = status;
    }
}

/**
 * The stored half of a connection.
 *
 * @typedef {object} AvtrTokenSet
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt Epoch milliseconds
 * @property {string[]} scopes The scopes actually granted
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * @param {unknown} value
 * @returns {string[]} Scopes from a space-separated `scope` string
 */
function parseScopes(value) {
    return String(value ?? '')
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean);
}

/**
 * Posts a form to one of the OAuth endpoints.
 *
 * Client credentials go in the form body rather than an `Authorization: Basic`
 * header. avtr.zip accepts either, but forbids using both or repeating a
 * parameter, so picking one and sticking to it is the safe reading.
 *
 * @param {string} path Below `AVTR_API_BASE`, e.g. `/oauth/token`
 * @param {Record<string, string>} fields
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<any>} The parsed JSON body
 * @throws {AvtrAuthError} On a non-2xx response
 */
async function postForm(path, fields, { fetchImpl = fetch } = {}) {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null && value !== '') {
            body.set(name, String(value));
        }
    }

    const response = await fetchImpl(`${AVTR_API_BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body: body.toString()
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response?.ok) {
        throw new AvtrAuthError(
            payload?.error ?? 'http_error',
            payload?.error_description ?? `Request to ${path} failed (${response?.status ?? 'no response'})`,
            response?.status ?? 0
        );
    }
    return payload;
}

/**
 * @returns {Promise<string>} The configured client id, or '' when unset
 */
export async function getClientId() {
    const stored = (await configRepository.getString(CLIENT_ID_KEY, '')) ?? '';
    return stored.trim() || DEFAULT_CLIENT_ID;
}

/**
 * @param {string} clientId
 * @returns {Promise<void>}
 */
export async function setClientId(clientId) {
    await configRepository.setString(CLIENT_ID_KEY, String(clientId ?? '').trim());
}

/**
 * The stored client secret, for a confidential app.
 *
 * Empty means a public client, which is the type avtr.zip recommends for a
 * desktop app; see the note at the top of this module before setting one.
 *
 * @returns {Promise<string>} The secret, or '' when there is none
 */
export async function getClientSecret() {
    return ((await configRepository.getString(CLIENT_SECRET_KEY, '')) ?? '').trim();
}

/**
 * @param {string} clientSecret Pass '' to go back to a public client
 * @returns {Promise<void>}
 */
export async function setClientSecret(clientSecret) {
    await configRepository.setString(CLIENT_SECRET_KEY, String(clientSecret ?? '').trim());
}

/**
 * @returns {Promise<boolean>} Whether a client secret is configured
 */
export async function isConfidentialClient() {
    return (await getClientSecret()) !== '';
}

/**
 * The credential fields every OAuth call needs.
 *
 * A public client sends `client_id` alone; a confidential one must also
 * authenticate, or avtr.zip answers `invalid_client`. `postForm` drops empty
 * values, so an unset secret simply never reaches the wire.
 *
 * @param {object} [options]
 * @param {string} [options.clientId] Overrides the configured id
 * @param {string} [options.clientSecret] Overrides the configured secret
 * @returns {Promise<{ client_id: string; client_secret: string }>}
 */
async function clientAuthFields({ clientId, clientSecret } = {}) {
    return {
        client_id: clientId ?? (await getClientId()),
        client_secret: clientSecret ?? (await getClientSecret())
    };
}

/**
 * @returns {Promise<AvtrTokenSet | null>} Null when VRCX is not connected
 */
export async function getStoredTokens() {
    const accessToken = (await configRepository.getString(ACCESS_TOKEN_KEY, '')) ?? '';
    const refreshToken = (await configRepository.getString(REFRESH_TOKEN_KEY, '')) ?? '';
    if (!accessToken && !refreshToken) {
        return null;
    }
    return {
        accessToken,
        refreshToken,
        expiresAt: Number((await configRepository.getString(EXPIRES_AT_KEY, '0')) ?? 0) || 0,
        scopes: parseScopes(await configRepository.getString(SCOPES_KEY, ''))
    };
}

/**
 * @param {AvtrTokenSet} tokens
 * @returns {Promise<void>}
 */
async function storeTokens(tokens) {
    await configRepository.setString(ACCESS_TOKEN_KEY, tokens.accessToken);
    await configRepository.setString(REFRESH_TOKEN_KEY, tokens.refreshToken);
    await configRepository.setString(EXPIRES_AT_KEY, String(tokens.expiresAt));
    await configRepository.setString(SCOPES_KEY, tokens.scopes.join(' '));
}

/**
 * Turns a token-endpoint response into what we persist.
 *
 * `scope` is what was *actually* granted, which can be narrower than what was
 * asked for, so it is read rather than assumed.
 *
 * @param {any} payload
 * @param {AvtrTokenSet | null} [previous] Kept for the refresh token when a
 *   response omits it
 * @param {number} [now]
 * @returns {AvtrTokenSet}
 */
export function tokenSetFromResponse(payload, previous = null, now = Date.now()) {
    const expiresIn = Number(payload?.expires_in);
    return {
        accessToken: String(payload?.access_token ?? ''),
        refreshToken: String(payload?.refresh_token ?? previous?.refreshToken ?? ''),
        expiresAt: now + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
        scopes: payload?.scope ? parseScopes(payload.scope) : (previous?.scopes ?? [])
    };
}

/**
 * Asks avtr.zip for a device code.
 *
 * @param {object} [options]
 * @param {string} [options.clientId] Defaults to the configured one
 * @param {string} [options.clientSecret] Defaults to the configured one
 * @param {readonly string[]} [options.scopes]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{
 *     deviceCode: string;
 *     userCode: string;
 *     verificationUri: string;
 *     verificationUriComplete: string;
 *     expiresAt: number;
 *     intervalMs: number;
 * }>}
 * @throws {Error} When no client id is configured
 * @throws {AvtrAuthError} When avtr.zip refuses the request
 */
export async function startDeviceAuthorization({
    clientId,
    clientSecret,
    scopes = DEFAULT_SCOPES,
    fetchImpl = fetch
} = {}) {
    const auth = await clientAuthFields({ clientId, clientSecret });
    if (!auth.client_id) {
        throw new Error('No avtr.zip client id is configured');
    }

    const payload = await postForm('/oauth/device', { ...auth, scope: scopes.join(' ') }, { fetchImpl });

    const expiresIn = Number(payload?.expires_in);
    const interval = Number(payload?.interval);
    return {
        deviceCode: String(payload?.device_code ?? ''),
        userCode: String(payload?.user_code ?? ''),
        verificationUri: String(payload?.verification_uri ?? AVTR_ACTIVATE_URL),
        verificationUriComplete: String(payload?.verification_uri_complete ?? ''),
        expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 600) * 1000,
        intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000
    };
}

/**
 * Polls the token endpoint until the user approves the device, or it fails.
 *
 * `slow_down` raises the interval for the rest of the session rather than for
 * one round, which is what avtr.zip asks for.
 *
 * @param {object} authorization The result of `startDeviceAuthorization`
 * @param {string} authorization.deviceCode
 * @param {number} authorization.expiresAt
 * @param {number} authorization.intervalMs
 * @param {object} [options]
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {AbortSignal} [options.signal] Aborts the polling loop
 * @returns {Promise<AvtrTokenSet>}
 * @throws {AvtrAuthError} `access_denied`, `expired_token` or `invalid_grant`
 */
export async function pollDeviceToken(
    { deviceCode, expiresAt, intervalMs },
    { clientId, clientSecret, fetchImpl = fetch, sleep = wait, signal } = {}
) {
    const auth = await clientAuthFields({ clientId, clientSecret });
    let interval = intervalMs;

    for (;;) {
        if (signal?.aborted) {
            throw new AvtrAuthError('cancelled', 'Device authorization was cancelled');
        }
        await sleep(interval);
        if (signal?.aborted) {
            throw new AvtrAuthError('cancelled', 'Device authorization was cancelled');
        }
        if (Date.now() > expiresAt) {
            throw new AvtrAuthError('expired_token', 'The device code expired before it was approved');
        }

        try {
            const payload = await postForm(
                '/oauth/token',
                { grant_type: DEVICE_GRANT_TYPE, ...auth, device_code: deviceCode },
                { fetchImpl }
            );
            const tokens = tokenSetFromResponse(payload);
            await storeTokens(tokens);
            return tokens;
        } catch (err) {
            if (!(err instanceof AvtrAuthError)) {
                throw err;
            }
            if (err.error === 'authorization_pending') {
                continue;
            }
            if (err.error === 'slow_down') {
                interval += SLOW_DOWN_STEP_MS;
                continue;
            }
            // access_denied, expired_token, invalid_grant: all terminal.
            throw err;
        }
    }
}

/** Guarantees one refresh at a time; see the rotation note at the top. */
let refreshInFlight = /** @type {Promise<AvtrTokenSet> | null} */ (null);

/**
 * Trades the stored refresh token for a new pair.
 *
 * On `invalid_grant` the grant is gone for good — the user revoked VRCX, or a
 * rotated token was replayed — so everything stored is cleared and the caller
 * sees a disconnected state rather than a retry loop.
 *
 * @param {object} [options]
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<AvtrTokenSet>}
 * @throws {AvtrAuthError}
 */
export function refreshTokens({ clientId, clientSecret, fetchImpl = fetch } = {}) {
    refreshInFlight ??= (async () => {
        try {
            const stored = await getStoredTokens();
            if (!stored?.refreshToken) {
                throw new AvtrAuthError('invalid_grant', 'VRCX is not connected to avtr.zip');
            }
            const auth = await clientAuthFields({ clientId, clientSecret });

            let payload;
            try {
                payload = await postForm(
                    '/oauth/token',
                    { grant_type: 'refresh_token', ...auth, refresh_token: stored.refreshToken },
                    { fetchImpl }
                );
            } catch (err) {
                if (err instanceof AvtrAuthError && (err.error === 'invalid_grant' || err.error === 'invalid_client')) {
                    await clearStoredConnection();
                }
                throw err;
            }

            const tokens = tokenSetFromResponse(payload, stored);
            // Persist before returning: the token we just sent is now retired,
            // and replaying it would revoke the whole grant.
            await storeTokens(tokens);
            return tokens;
        } finally {
            refreshInFlight = null;
        }
    })();
    return refreshInFlight;
}

/**
 * A valid access token, refreshing first when the stored one is close to
 * expiring.
 *
 * @param {object} [options]
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {boolean} [options.forceRefresh] Refresh even if it looks valid
 * @returns {Promise<string | null>} Null when VRCX is not connected
 */
export async function getAccessToken({ clientId, clientSecret, fetchImpl = fetch, forceRefresh = false } = {}) {
    const stored = await getStoredTokens();
    if (!stored) {
        return null;
    }

    const stale = !stored.accessToken || stored.expiresAt - EXPIRY_SKEW_MS <= Date.now();
    if (!forceRefresh && !stale) {
        return stored.accessToken;
    }
    if (!stored.refreshToken) {
        return stored.accessToken || null;
    }

    try {
        return (await refreshTokens({ clientId, clientSecret, fetchImpl })).accessToken;
    } catch (err) {
        if (err instanceof AvtrAuthError && err.error === 'invalid_grant') {
            return null;
        }
        throw err;
    }
}

/**
 * @returns {Promise<boolean>} Whether a token set is stored
 */
export async function isConnected() {
    return (await getStoredTokens()) !== null;
}

/**
 * @param {string} scope
 * @returns {Promise<boolean>} Whether the granted scopes include `scope`
 */
export async function hasScope(scope) {
    return ((await getStoredTokens())?.scopes ?? []).includes(scope);
}

/**
 * The cached `/v3/oauth/userinfo` result, so the UI can name the connected
 * account without a request on every mount.
 *
 * @returns {Promise<object | null>}
 */
export async function getStoredAccount() {
    try {
        return JSON.parse((await configRepository.getString(ACCOUNT_KEY, '')) || 'null');
    } catch {
        return null;
    }
}

/**
 * @param {object | null} account
 * @returns {Promise<void>}
 */
export async function setStoredAccount(account) {
    await configRepository.setString(ACCOUNT_KEY, account ? JSON.stringify(account) : '');
}

/**
 * Forgets the connection locally, without telling avtr.zip.
 *
 * @returns {Promise<void>}
 */
export async function clearStoredConnection() {
    await configRepository.setString(ACCESS_TOKEN_KEY, '');
    await configRepository.setString(REFRESH_TOKEN_KEY, '');
    await configRepository.setString(EXPIRES_AT_KEY, '0');
    await configRepository.setString(SCOPES_KEY, '');
    await configRepository.setString(ACCOUNT_KEY, '');
}

/**
 * Disconnects: revokes the refresh token at avtr.zip, which kills every token
 * on the grant, then clears what is stored.
 *
 * Revocation answers 200 even for a token that is already dead, so a failure
 * here is a network problem; the local state is cleared regardless so the user
 * is not stuck "connected" to a grant they cannot use.
 *
 * @param {object} [options]
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<void>}
 */
export async function disconnect({ clientId, clientSecret, fetchImpl = fetch } = {}) {
    const stored = await getStoredTokens();
    const token = stored?.refreshToken || stored?.accessToken;
    if (token) {
        try {
            await postForm(
                '/oauth/revoke',
                { ...(await clientAuthFields({ clientId, clientSecret })), token },
                { fetchImpl }
            );
        } catch (err) {
            console.error('Could not revoke the avtr.zip token', err);
        }
    }
    await clearStoredConnection();
}

/**
 * Asks avtr.zip whether a token is still live, and what it holds.
 *
 * Confidential clients only — a public one gets 401 `invalid_client` — and only
 * for tokens issued to this app; anything else is reported as inactive rather
 * than refused. Works on access and refresh tokens.
 *
 * @param {string} token The token to ask about; defaults to the stored access token
 * @param {object} [options]
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ active: boolean; scope?: string; exp?: number; sub?: string } | null>} Null when there is nothing
 *   to ask about, or this is a public client
 * @throws {AvtrAuthError} When avtr.zip refuses the request
 */
export async function introspectToken(token, { clientId, clientSecret, fetchImpl = fetch } = {}) {
    const auth = await clientAuthFields({ clientId, clientSecret });
    if (!auth.client_secret) {
        return null;
    }

    const subject = token || (await getStoredTokens())?.accessToken;
    if (!subject) {
        return null;
    }

    return await postForm('/oauth/introspect', { ...auth, token: subject }, { fetchImpl });
}
