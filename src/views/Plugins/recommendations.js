/**
 * Scoring for the recommended avatars panel.
 *
 * Kept free of stores and network calls so the ranking can be tested on plain
 * data; the component supplies the inputs and performs the lookups.
 */

const DAY_MS = 86400000;

/**
 * @typedef {object} AvatarHistoryEntry
 * @property {string} id
 * @property {string} [name]
 * @property {string} [authorId]
 * @property {string} [authorName]
 * @property {string} [thumbnailImageUrl]
 * @property {string} [imageUrl]
 * @property {string | number} [lastWornAt] When you last wore it
 * @property {number} [timeSpent] Total milliseconds worn
 */

/**
 * @param {string | number | undefined} value
 * @returns {number} Epoch ms, or 0 when unparseable
 */
export function toTimestamp(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    if (typeof value !== 'string' || value.length === 0) {
        return 0;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A history entry with its rediscovery ranking attached.
 *
 * @typedef {object} RediscoveryEntry
 * @property {string} id
 * @property {string} [name]
 * @property {string} [authorId]
 * @property {string} [authorName]
 * @property {string} [thumbnailImageUrl]
 * @property {string} [imageUrl]
 * @property {number} score
 * @property {number} daysSinceWorn
 * @property {number} minutesWorn
 */

/**
 * Ranks avatars you already own by "worth revisiting": ones you put real time
 * into but have not worn lately.
 *
 * Time worn is the main signal, nudged up by how long it has been. The nudge
 * is logarithmic so an avatar untouched for two years does not bury one you
 * genuinely wore more.
 *
 * @param {AvatarHistoryEntry[]} history
 * @param {object} [options]
 * @param {number} [options.now] Epoch ms, injectable for tests
 * @param {number} [options.minDaysSinceWorn] Anything worn more recently is not a rediscovery
 * @param {Set<string> | string[]} [options.excludeIds] E.g. the avatar you are wearing now
 * @param {number} [options.limit]
 * @returns {RediscoveryEntry[]}
 */
export function rankRediscoveries(
    history,
    { now = Date.now(), minDaysSinceWorn = 14, excludeIds = [], limit = 24 } = {}
) {
    if (!Array.isArray(history)) {
        return [];
    }
    const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds);

    /** @type {RediscoveryEntry[]} */
    const scored = [];
    const seen = new Set();
    for (const entry of history) {
        if (!entry?.id || excluded.has(entry.id) || seen.has(entry.id)) {
            continue;
        }
        seen.add(entry.id);

        const lastWornAt = toTimestamp(entry.lastWornAt);
        // Without a timestamp there is no way to tell a rediscovery from
        // something worn an hour ago, so leave it out rather than guess.
        if (lastWornAt === 0) {
            continue;
        }
        const daysSinceWorn = Math.max(0, (now - lastWornAt) / DAY_MS);
        if (daysSinceWorn < minDaysSinceWorn) {
            continue;
        }
        const minutesWorn = Math.max(0, (entry.timeSpent ?? 0) / 60000);
        if (minutesWorn <= 0) {
            continue;
        }

        scored.push({
            ...entry,
            minutesWorn,
            daysSinceWorn,
            score: minutesWorn * Math.log10(10 + daysSinceWorn)
        });
    }

    scored.sort((a, b) => b.score - a.score);
    return limit > 0 ? scored.slice(0, limit) : scored;
}

/**
 * Picks the authors worth querying the avatar database for: the creators you
 * have already spent the most time wearing, plus anyone you have favorited.
 *
 * Favorites count as a strong signal, so they are weighted as if worn for an
 * hour even when there is no history entry for them.
 *
 * @param {AvatarHistoryEntry[]} history
 * @param {{ authorId?: string; ref?: { authorId?: string } }[]} favorites
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {string} [options.excludeAuthorId] Normally your own id
 * @returns {string[]} Author ids, strongest first
 */
export function pickTopAuthors(history, favorites, { limit = 5, excludeAuthorId = '' } = {}) {
    /** @type {Map<string, number>} */
    const weights = new Map();

    /**
     * @param {string} authorId
     * @param {number} weight
     */
    function add(authorId, weight) {
        if (!authorId || authorId === excludeAuthorId) {
            return;
        }
        weights.set(authorId, (weights.get(authorId) ?? 0) + weight);
    }

    for (const entry of Array.isArray(history) ? history : []) {
        add(entry?.authorId, Math.max(1, (entry?.timeSpent ?? 0) / 60000));
    }
    for (const favorite of Array.isArray(favorites) ? favorites : []) {
        add(favorite?.authorId ?? favorite?.ref?.authorId, 60);
    }

    return Array.from(weights.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(0, limit))
        .map(([authorId]) => authorId);
}

/**
 * Drops avatars you already know about, plus anything not publicly usable.
 *
 * @param {Iterable<object>} candidates
 * @param {Set<string> | string[]} knownIds
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {object[]}
 */
export function filterNewAvatars(candidates, knownIds, { limit = 24 } = {}) {
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
    const result = [];
    const seen = new Set();

    for (const avatar of candidates ?? []) {
        const id = avatar?.id;
        if (!id || known.has(id) || seen.has(id)) {
            continue;
        }
        if (avatar.releaseStatus && avatar.releaseStatus !== 'public') {
            continue;
        }
        seen.add(id);
        result.push(avatar);
        if (limit > 0 && result.length >= limit) {
            break;
        }
    }
    return result;
}

/**
 * "3 months", "12 days" — a coarse age for the rediscovery cards.
 *
 * @param {number} days
 * @returns {string}
 */
export function formatAge(days) {
    if (!Number.isFinite(days) || days < 1) {
        return 'today';
    }
    if (days < 30) {
        const whole = Math.round(days);
        return `${whole} day${whole === 1 ? '' : 's'}`;
    }
    if (days < 365) {
        const months = Math.round(days / 30);
        return `${months} month${months === 1 ? '' : 's'}`;
    }
    const years = Math.round((days / 365) * 10) / 10;
    return `${years} year${years === 1 ? '' : 's'}`;
}
