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
 * @param {number} [options.limit] 0 returns every author
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

    const ranked = Array.from(weights.entries()).sort((a, b) => b[1] - a[1]);
    return (limit > 0 ? ranked.slice(0, limit) : ranked).map(([authorId]) => authorId);
}

// Words that say nothing about what an avatar looks like.
const KEYWORD_STOPWORDS = new Set([
    'and',
    'the',
    'for',
    'with',
    'avatar',
    'avatars',
    'avtr',
    'base',
    'model',
    'edit',
    'edited',
    'version',
    'ver',
    'new',
    'old',
    'free',
    'public',
    'private',
    'quest',
    'android',
    'pc',
    'ios',
    'copy',
    'test',
    'fixed',
    'fix',
    'update',
    'updated',
    'mobile',
    'cross',
    'platform'
]);

/**
 * Tags worth searching on: creator-set ones, minus the author_tag_ prefix.
 * System tags (content_, admin_, etc.) describe ratings, not looks.
 *
 * @param {unknown} tags
 * @returns {string[]}
 */
function authorTags(tags) {
    if (!Array.isArray(tags)) {
        return [];
    }
    return tags
        .filter((tag) => typeof tag === 'string' && tag.startsWith('author_tag_'))
        .map((tag) => tag.slice('author_tag_'.length));
}

/**
 * Splits a name into searchable words: lowercase, letters only, no version
 * numbers, platform markers or filler.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractKeywords(text) {
    if (typeof text !== 'string') {
        return [];
    }
    const words = text.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
    return words.filter((word) => !KEYWORD_STOPWORDS.has(word));
}

/**
 * Picks keywords for exploring beyond the creators you already know: words
 * from the names and tags of avatars you wear the most, weighted the same way
 * as {@link pickTopAuthors}.
 *
 * Each avatar contributes a word once, so a name like "Fox Fox Fox" does not
 * outweigh three different fox avatars.
 *
 * @param {AvatarHistoryEntry[]} history
 * @param {{ name?: string; tags?: string[]; ref?: { name?: string; tags?: string[] } }[]} favorites
 * @param {object} [options]
 * @param {number} [options.limit] 0 returns every keyword
 * @returns {string[]} Strongest first
 */
export function pickKeywords(history, favorites, { limit = 10 } = {}) {
    /** @type {Map<string, number>} */
    const weights = new Map();

    /**
     * @param {{ name?: string; tags?: string[] } | undefined} avatar
     * @param {number} weight
     */
    function add(avatar, weight) {
        const words = new Set([...extractKeywords(avatar?.name), ...authorTags(avatar?.tags).flatMap(extractKeywords)]);
        for (const word of words) {
            weights.set(word, (weights.get(word) ?? 0) + weight);
        }
    }

    for (const entry of Array.isArray(history) ? history : []) {
        add(entry, Math.max(1, (entry?.timeSpent ?? 0) / 60000));
    }
    for (const favorite of Array.isArray(favorites) ? favorites : []) {
        add(favorite?.ref ?? favorite, 60);
    }

    const ranked = Array.from(weights.entries()).sort((a, b) => b[1] - a[1]);
    return (limit > 0 ? ranked.slice(0, limit) : ranked).map(([word]) => word);
}

/**
 * Reorders avatars so consecutive picks come from different creators, keeping
 * each creator's own order. Without this one prolific creator can fill a whole
 * page before anyone else gets a look in.
 *
 * @template {{ authorId?: string }} T
 * @param {T[]} avatars
 * @returns {T[]}
 */
export function interleaveByAuthor(avatars) {
    /** @type {Map<string, T[]>} */
    const byAuthor = new Map();
    const all = Array.isArray(avatars) ? avatars : [];
    for (const avatar of all) {
        const key = avatar?.authorId ?? '';
        let list = byAuthor.get(key);
        if (!list) {
            list = [];
            byAuthor.set(key, list);
        }
        list.push(avatar);
    }

    const queues = Array.from(byAuthor.values());
    const result = [];
    for (let round = 0; result.length < all.length; ++round) {
        for (const queue of queues) {
            if (round < queue.length) {
                result.push(queue[round]);
            }
        }
    }
    return result;
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
