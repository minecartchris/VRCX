import { reactive } from 'vue';

/**
 * Registry of chatbox "sources".
 *
 * The OSC chatbox plugin owns the transport and the timing; every other chatbox
 * plugin just registers a source that returns a line of text. That keeps each
 * readout (clock, weather, heart rate, ...) independently toggleable while
 * still producing a single coherent chatbox message.
 */

/**
 * @typedef {object} ChatboxSource
 * @property {string} id
 * @property {string} label human readable, used in the settings UI
 * @property {number} [order] lower sorts first, default 100
 * @property {() => (string | null | undefined)} render returns the line, or a falsy value to contribute nothing
 */

/** @type {Map<string, ChatboxSource>} */
const sources = reactive(new Map());

/**
 * @param {ChatboxSource} source
 * @returns {() => void} unregister
 */
export function registerChatboxSource(source) {
    if (!source?.id || typeof source.render !== 'function') {
        throw new TypeError('chatbox source needs an id and a render function');
    }
    sources.set(source.id, { order: 100, label: source.id, ...source });
    return () => {
        sources.delete(source.id);
    };
}

/**
 * @param {string} id
 */
export function unregisterChatboxSource(id) {
    sources.delete(id);
}

/**
 * @returns {ChatboxSource[]} sources in display order
 */
export function getChatboxSources() {
    return Array.from(sources.values()).sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100)
    );
}

/**
 * Renders every source, dropping the ones that produced nothing and any that
 * threw — one broken source must not blank the whole chatbox.
 *
 * @returns {{id: string, text: string}[]}
 */
export function renderChatboxSources() {
    const lines = [];
    for (const source of getChatboxSources()) {
        let text;
        try {
            text = source.render();
        } catch (err) {
            console.error(`[chatbox] source "${source.id}" threw`, err);
            continue;
        }
        if (typeof text !== 'string') {
            continue;
        }
        const trimmed = text.trim();
        if (trimmed.length > 0) {
            lines.push({ id: source.id, text: trimmed });
        }
    }
    return lines;
}

/**
 * Builds the message that gets sent to VRChat.
 *
 * @param {{id: string, text: string}[]} lines
 * @param {object} options
 * @param {'stack'|'rotate'} options.mode
 * @param {string} options.separator
 * @param {number} options.maxLength
 * @param {number} [options.rotationIndex] which line to show in rotate mode
 * @returns {string}
 */
export function composeChatboxMessage(
    lines,
    { mode, separator, maxLength, rotationIndex = 0 }
) {
    if (lines.length === 0) {
        return '';
    }
    if (mode === 'rotate') {
        const index =
            ((rotationIndex % lines.length) + lines.length) % lines.length;
        return lines[index].text.slice(0, maxLength);
    }
    const joined = lines.map((line) => line.text).join(separator);
    return joined.slice(0, maxLength);
}

/** Test helper. */
export function clearChatboxSources() {
    sources.clear();
}
