import webApiService from '../services/webapi';

/**
 * HTTP helpers for plugins.
 *
 * Requests go through the native WebApi bridge rather than `fetch` so plugins
 * are not subject to the renderer's CORS rules, matching how the rest of VRCX
 * talks to third-party services.
 */

const DEFAULT_HEADERS = { Referer: 'https://vrcx.app' };

/**
 * @param {string} url
 * @param {{headers?: Record<string, string>}} [options]
 * @returns {Promise<*>} decoded JSON body
 */
export async function getJson(url, { headers } = {}) {
    const response = await webApiService.execute({
        url,
        method: 'GET',
        headers: { ...DEFAULT_HEADERS, ...headers }
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`GET ${url} failed with status ${response.status}`);
    }
    return response.data ? JSON.parse(response.data) : null;
}

/**
 * @param {string} url
 * @param {*} body serialised as JSON
 * @param {{headers?: Record<string, string>}} [options]
 * @returns {Promise<{status: number, data?: string}>}
 */
export async function postJson(url, body, { headers } = {}) {
    const response = await webApiService.execute({
        url,
        method: 'POST',
        headers: {
            ...DEFAULT_HEADERS,
            'Content-Type': 'application/json',
            ...headers
        },
        body: JSON.stringify(body)
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`POST ${url} failed with status ${response.status}`);
    }
    return response;
}
