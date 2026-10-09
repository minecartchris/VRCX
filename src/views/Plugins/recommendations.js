/**
 * Ranking for the recommended avatars panel.
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
 * @param {Set<string> | string[]} [options.excludeAuthorIds] Creators to leave out entirely
 * @returns {object[]}
 */
export function filterNewAvatars(candidates, knownIds, { limit = 24, excludeAuthorIds = [] } = {}) {
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
    const excludedAuthors = excludeAuthorIds instanceof Set ? excludeAuthorIds : new Set(excludeAuthorIds);
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
        if (avatar.authorId && excludedAuthors.has(avatar.authorId)) {
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
 * When an avatar was last uploaded or updated, whichever is later. Providers
 * fill unknown dates with year 0001, which counts as never.
 *
 * @param {{ created_at?: string; updated_at?: string }} avatar
 * @returns {number} Epoch ms, or 0 when unknown
 */
export function uploadedAt(avatar) {
    return Math.max(0, toTimestamp(avatar?.updated_at), toTimestamp(avatar?.created_at));
}

/**
 * Newest uploads first. Stable, so avatars with no date keep their order.
 *
 * @template T
 * @param {T[]} avatars
 * @returns {T[]}
 */
export function sortByRecent(avatars) {
    return (Array.isArray(avatars) ? avatars : [])
        .map((avatar, index) => ({ avatar, index, at: uploadedAt(avatar) }))
        .sort((a, b) => b.at - a.at || a.index - b.index)
        .map(({ avatar }) => avatar);
}

/**
 * Drops "already shown you" entries older than the cutoff, so those avatars
 * can come back around.
 *
 * @param {Record<string, number>} seen Avatar id to epoch ms it was shown
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxAgeDays]
 * @returns {Record<string, number>}
 */
export function pruneSeen(seen, { now = Date.now(), maxAgeDays = 30 } = {}) {
    const cutoff = now - maxAgeDays * DAY_MS;
    /** @type {Record<string, number>} */
    const result = {};
    if (!seen || typeof seen !== 'object') {
        return result;
    }
    for (const [id, at] of Object.entries(seen)) {
        if (typeof at === 'number' && at >= cutoff) {
            result[id] = at;
        }
    }
    return result;
}

/**
 * Builds one page by alternating between avatars from creators you know and
 * avatars from creators you have never worn, so the two come out about half
 * and half. When one side runs dry the other fills the rest.
 *
 * Picks also avoid any creator used in the last `gap` cards, looking a little
 * way down the queue for someone else before giving in, so a page is not a
 * run of one creator's uploads.
 *
 * @template {{ authorId?: string }} T
 * @param {T[]} familiar
 * @param {T[]} discovery
 * @param {object} [options]
 * @param {number} [options.size]
 * @param {number} [options.gap]
 * @param {number} [options.lookahead] How far down a queue to search for a different creator
 * @returns {{ page: T[]; familiar: T[]; discovery: T[] }} The page, plus what is left of each queue
 */
export function buildMixedPage(familiar, discovery, { size = 24, gap = 3, lookahead = 40 } = {}) {
    const queues = [
        Array.isArray(familiar) ? [...familiar] : [],
        Array.isArray(discovery) ? [...discovery] : []
    ];
    const page = [];
    /** @type {string[]} */
    const recentAuthors = [];

    for (let turn = 0; page.length < size && (queues[0].length > 0 || queues[1].length > 0); ++turn) {
        const preferred = queues[turn % 2].length > 0 ? queues[turn % 2] : queues[(turn + 1) % 2];
        const limit = Math.min(preferred.length, lookahead);
        let pick = 0;
        for (let i = 0; i < limit; ++i) {
            if (!recentAuthors.includes(preferred[i]?.authorId ?? '')) {
                pick = i;
                break;
            }
        }
        const [avatar] = preferred.splice(pick, 1);
        page.push(avatar);
        recentAuthors.push(avatar?.authorId ?? '');
        if (recentAuthors.length > gap) {
            recentAuthors.shift();
        }
    }
    return { page, familiar: queues[0], discovery: queues[1] };
}
