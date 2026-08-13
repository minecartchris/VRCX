/**
 * The `vrcx://import-plugin/...` deep link.
 *
 * Deliberately dependency free: these are pure string functions, and keeping
 * them out of `external.js` means neither the protocol handler nor the tests
 * have to pull the plugin manager and the store graph in behind them.
 *
 * A link only ever carries a code. Installing stays a separate, deliberate
 * click in the import dialog, so following a link cannot run someone else's
 * code on your account.
 */

const PREFIX = 'import-plugin/';

/**
 * Builds the deep link that opens a plugin in VRCX's import dialog.
 *
 * @param {string} code a bundle URL, gist reference or owner/repo code
 * @returns {string}
 */
export function pluginImportLink(code) {
    return `vrcx://${PREFIX}${encodeURIComponent(String(code ?? '').trim())}`;
}

/**
 * Reads a code back out of a launch command.
 *
 * The whole remainder is taken rather than splitting on `/`, because the
 * payload is usually a URL and would otherwise be truncated at its first
 * slash.
 *
 * @param {string} input the launch command, with the `vrcx://` scheme removed
 * @returns {string} the code, or '' when this is not an import command
 */
export function parsePluginImportCommand(input) {
    const value = String(input ?? '').trim();
    if (!value.toLowerCase().startsWith(PREFIX)) {
        return '';
    }
    const payload = value.slice(PREFIX.length).trim();
    if (!payload) {
        return '';
    }
    try {
        return decodeURIComponent(payload);
    } catch {
        // A payload that was never percent-encoded is still usable as-is.
        return payload;
    }
}
