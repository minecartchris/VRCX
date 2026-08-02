/**
 * Magic ChatBox status import for VRCX.
 *
 * MagicChatbox and VRCX both write to VRChat's chatbox on port 9000, so running
 * both makes them fight over it. This plugin takes MagicChatbox out of that
 * loop: export your statuses from MagicChatbox, paste the JSON into this
 * plugin's settings, and VRCX cycles them as one of its own chatbox sources.
 *
 * Export format (Version 2):
 *   { "Version": 2,
 *     "Groups": [{ "GroupId", "Name", "IsActiveForCycle" }],
 *     "Items":  [{ "MSGID", "msg", "GroupId", "IsFavorite", "UseInCycle" }] }
 *
 * Imported plugins are plain CommonJS with no imports — `ctx` is the whole API.
 */

/**
 * Parses a pasted export, tolerating the whitespace a copy-paste adds.
 *
 * @param {string} raw
 * @returns {{groups: object[], items: object[]}}
 * @throws {Error} with a message meant for the settings UI
 */
function parseStatusExport(raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
        throw new Error('Paste your MagicChatbox status export first.');
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('That is not valid JSON.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Expected a JSON object with Groups and Items.');
    }
    const items = Array.isArray(data.Items) ? data.Items : null;
    if (!items) {
        throw new Error('No "Items" array in that export.');
    }
    return {
        groups: Array.isArray(data.Groups) ? data.Groups : [],
        items
    };
}

/**
 * Applies the export's own cycling flags to produce the status list.
 *
 * @param {{groups: object[], items: object[]}} parsed
 * @param {{onlyActiveGroups?: boolean, onlyUseInCycle?: boolean}} [options]
 * @returns {string[]} status texts, in export order, de-duplicated
 */
function selectStatuses(parsed, options = {}) {
    const activeGroupIds = new Set(
        parsed.groups
            .filter((group) => group && group.IsActiveForCycle)
            .map((group) => group.GroupId)
    );
    const seen = new Set();
    const result = [];

    for (const item of parsed.items) {
        const msg = String(item?.msg ?? '').trim();
        if (!msg || seen.has(msg)) {
            continue;
        }
        if (options.onlyUseInCycle && !item.UseInCycle) {
            continue;
        }
        // A group filter is only meaningful when the export actually declares
        // groups; otherwise every item would be dropped.
        if (
            options.onlyActiveGroups &&
            activeGroupIds.size > 0 &&
            !activeGroupIds.has(item.GroupId)
        ) {
            continue;
        }
        seen.add(msg);
        result.push(msg);
    }
    return result;
}

/**
 * @param {number} count
 * @param {number} current
 * @param {boolean} random
 * @param {() => number} [rng]
 * @returns {number} next index
 */
function nextIndex(count, current, random, rng = Math.random) {
    if (count <= 1) {
        return 0;
    }
    if (!random) {
        return (current + 1) % count;
    }
    // Avoid repeating the current entry, which reads as the cycle being stuck.
    let candidate = Math.floor(rng() * (count - 1));
    if (candidate >= current) {
        candidate += 1;
    }
    return candidate;
}

module.exports = {
    setup(ctx) {
        const settings = ctx.settings;

        let statuses = [];
        let index = 0;

        try {
            const parsed = parseStatusExport(settings.statusJson);
            statuses = selectStatuses(parsed, {
                onlyActiveGroups: settings.onlyActiveGroups,
                onlyUseInCycle: settings.onlyUseInCycle
            });
        } catch (err) {
            ctx.setStatus(err.message, 'error');
            return;
        }

        if (statuses.length === 0) {
            ctx.setStatus(
                'The export parsed, but no statuses matched the filters. Try turning off "Only statuses marked for cycling".',
                'warning'
            );
            return;
        }

        function current() {
            return statuses[Math.min(index, statuses.length - 1)] ?? '';
        }

        function refreshStatus() {
            ctx.setStatus(
                statuses.length === 1
                    ? `Showing: ${current()}`
                    : `${statuses.length} statuses · now: ${current()}`,
                'ok'
            );
        }

        ctx.chatbox(() => `${settings.prefix || ''}${current()}`, {
            label: 'Magic ChatBox status',
            order: settings.order
        });

        if (settings.cycle && statuses.length > 1) {
            ctx.interval(
                () => {
                    index = nextIndex(
                        statuses.length,
                        index,
                        settings.random
                    );
                    refreshStatus();
                },
                Math.max(1, Number(settings.intervalSeconds) || 4) * 1000
            );
        }

        refreshStatus();
    },

    // Exported for the test suite; harmless at runtime.
    parseStatusExport,
    selectStatuses,
    nextIndex
};
