/**
 * Avatar search query engine.
 *
 * Implements the query syntax published for avtr.zip's full-text search, run
 * locally against whatever avatars VRCX knows about (your history, favorites,
 * cached avatars, and anything pulled from the configured avatar database).
 *
 * Avtr.zip's own search endpoint sits behind a bot challenge and is not
 * callable from here, so this is a reimplementation of the language rather
 * than a client for their service. The one thing we do take from them live is
 * the feature vocabulary, which they publish openly (see `avtrFeatures.js`).
 * If a callable search endpoint ever appears it can be slotted in as another
 * candidate source without changing the query language.
 *
 * Supported:
 * free text            substring match across name/description/tags/author/features
 * -term                exclude
 * fuzzy:0.75           switch free text to trigram similarity at a threshold
 * tag:x                field match; also aiTag, author, authorName,
 * authorId, platforms, performance, style, name, description
 * tag:any(a, b)        at least one
 * tag:all(a, b)        all of them
 * feature:gogoloco     avatar feature, by id, bare name, category or label
 * feature:all(a, b)    every one of those features
 * pc:>=Good            per-platform performance, also quest: and ios:
 * quest:true           has (or, with false/none, lacks) a build for a platform
 * paid:false           free avatars only
 * price:<1000          price comparison; also price:100-500 and price:free
 * impostor:true        has an impostor
 * sort:likes           sort directives, applied left to right
 * random:true          shuffle within the current filters
 * similar to tags a, b Jaccard tag similarity ranking
 */

import { normalizeAvatarFeatures, resolveFeatureToken } from './avtrFeatures';

const FIELD_ALIASES = {
    tag: 'tags',
    tags: 'tags',
    aitag: 'aiTags',
    aitags: 'aiTags',
    author: 'author',
    authorname: 'authorName',
    authorid: 'authorId',
    platform: 'platforms',
    platforms: 'platforms',
    performance: 'performance',
    style: 'styles',
    styles: 'styles',
    name: 'name',
    description: 'description'
};

/**
 * Sort keys and the direction each one means when you do not say.
 *
 * Avtr.zip's `sort:likes` means most-liked first, while `sort:name` means A to
 * Z, so the natural direction travels with the key.
 */
const SORTABLE = {
    name: { field: 'name', direction: 'asc' },
    authorname: { field: 'authorName', direction: 'asc' },
    author: { field: 'authorName', direction: 'asc' },
    createdat: { field: 'created_at', direction: 'asc' },
    updatedat: { field: 'updated_at', direction: 'asc' },
    created: { field: 'created_at', direction: 'desc' },
    newest: { field: 'created_at', direction: 'desc' },
    updated: { field: 'updated_at', direction: 'desc' },
    changed: { field: 'updated_at', direction: 'desc' },
    likes: { field: 'likes', direction: 'desc' },
    used: { field: 'used', direction: 'desc' },
    worn: { field: 'used', direction: 'desc' },
    price: { field: 'price', direction: 'asc' }
};

/** Numeric fields, which must not be compared as strings. */
const NUMERIC_SORT_FIELDS = new Set(['likes', 'used', 'price']);

/** Best to worst. Index is the rank, so lower is better. */
export const PERFORMANCE_RANKS = ['excellent', 'good', 'medium', 'poor', 'verypoor'];

const PLATFORM_ALIASES = {
    pc: 'pc',
    windows: 'pc',
    standalonewindows: 'pc',
    desktop: 'pc',
    quest: 'quest',
    android: 'quest',
    oculus: 'quest',
    ios: 'ios',
    iphone: 'ios'
};

/**
 * @param {unknown} value
 * @returns {string}
 */
function lower(value) {
    return String(value ?? '').toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {string} Lowercased with separators stripped, for key lookups
 */
function key(value) {
    return lower(value).replace(/[\s_-]+/g, '');
}

/**
 * @param {string} value
 * @returns {string | null} Canonical platform key, or null when unrecognised
 */
export function normalizePlatform(value) {
    return PLATFORM_ALIASES[key(value)] ?? null;
}

/**
 * @param {string} value
 * @returns {number} Rank index, or -1 when unrecognised
 */
export function performanceRank(value) {
    return PERFORMANCE_RANKS.indexOf(key(value));
}

/**
 * Splits on whitespace while keeping `any(a, b)` groups and "quoted phrases"
 * in one piece.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeQuery(input) {
    const tokens = [];
    let current = '';
    let depth = 0;
    let quoted = false;

    for (const char of String(input ?? '')) {
        if (char === '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted) {
            if (char === '(') {
                depth += 1;
            } else if (char === ')') {
                depth = Math.max(0, depth - 1);
            } else if (/\s/.test(char) && depth === 0) {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
                continue;
            }
        }
        current += char;
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitList(value) {
    return value
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Pulls an `any(...)` / `all(...)` wrapper off a value.
 *
 * @param {string} value
 * @returns {{ mode: 'any' | 'all'; values: string[] }}
 */
function parseGroup(value) {
    const group = /^(any|all)\((.*)\)$/i.exec(value);
    if (group) {
        return {
            mode: group[1].toLowerCase() === 'all' ? 'all' : 'any',
            values: splitList(group[2])
        };
    }
    return { mode: 'all', values: value ? [value.toLowerCase()] : [] };
}

/**
 * Reads a leading comparison operator.
 *
 * @param {string} value
 * @returns {{ op: string; rest: string }}
 */
function parseComparison(value) {
    const match = /^(>=|<=|>|<|=)?\s*(.*)$/.exec(String(value ?? '').trim());
    return { op: match?.[1] ?? '=', rest: match?.[2] ?? '' };
}

const TRUTHY = new Set(['true', 'yes', 'y', '1', 'has']);
const FALSY = new Set(['false', 'no', 'n', '0', 'none', 'without']);

/**
 * @param {string} value
 * @returns {boolean | null}
 */
function parseBoolean(value) {
    const normalized = lower(value);
    if (TRUTHY.has(normalized)) {
        return true;
    }
    if (FALSY.has(normalized)) {
        return false;
    }
    return null;
}

/**
 * Parses a query string into a plan the matcher can execute.
 *
 * Unparseable fragments degrade to free text rather than erroring, so typing a
 * half-finished query still returns something sensible.
 *
 * @param {string} input
 * @returns {{
 *     include: string[];
 *     exclude: string[];
 *     fields: { field: string; mode: 'any' | 'all'; values: string[] }[];
 *     features: { mode: 'any' | 'all'; ids: string[] }[];
 *     platforms: { platform: string; present?: boolean; op?: string; rating?: string }[];
 *     price: { op: string; value?: number; min?: number; max?: number } | null;
 *     flags: { paid?: boolean; impostor?: boolean };
 *     sorts: { field: string; direction: 'asc' | 'desc' }[];
 *     fuzzy: number;
 *     random: boolean;
 *     similarTags: string[];
 * }}
 */
export function parseQuery(input) {
    const plan = {
        include: [],
        exclude: [],
        fields: [],
        features: [],
        platforms: [],
        price: null,
        flags: {},
        sorts: [],
        fuzzy: 0,
        random: false,
        similarTags: []
    };

    const tokens = tokenizeQuery(input);
    for (let i = 0; i < tokens.length; i += 1) {
        const raw = tokens[i];
        const lowered = raw.toLowerCase();

        // "similar to tags a, b" / "similar to tags:a,b"
        if (lowered === 'similar' && tokens[i + 1]?.toLowerCase() === 'to') {
            const third = tokens[i + 2] ?? '';
            if (third.toLowerCase().startsWith('tags')) {
                const inline = third.slice(4).replace(/^[:\s]+/, '');
                const rest = [inline, ...tokens.slice(i + 3)].join(' ').trim();
                plan.similarTags = splitList(rest);
                break;
            }
        }

        if (lowered === 'and' || lowered === 'or') {
            // Segment joiners: everything here is already AND of includes.
            continue;
        }

        if (raw.startsWith('-') && raw.length > 1) {
            plan.exclude.push(raw.slice(1).toLowerCase());
            continue;
        }

        const colon = raw.indexOf(':');
        if (colon > 0) {
            const field = lowered.slice(0, colon);
            const value = raw.slice(colon + 1);

            if (field === 'fuzzy') {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) {
                    plan.fuzzy = Math.min(1, Math.max(0, parsed));
                }
                continue;
            }
            if (field === 'random') {
                plan.random = value.toLowerCase() !== 'false';
                continue;
            }
            if (field === 'sort') {
                const match = /^([a-z_]+)(?:\((asc|desc)\))?$/i.exec(value);
                const entry = SORTABLE[key(match?.[1] ?? '')];
                if (entry) {
                    plan.sorts.push({
                        field: entry.field,
                        direction: match[2] ? (match[2].toLowerCase() === 'desc' ? 'desc' : 'asc') : entry.direction
                    });
                }
                continue;
            }
            if (field === 'feature' || field === 'features') {
                appendFeatureClauses(plan, value);
                continue;
            }
            if (field === 'paid' || field === 'free') {
                const parsed = parseBoolean(value);
                if (parsed !== null) {
                    plan.flags.paid = field === 'free' ? !parsed : parsed;
                }
                continue;
            }
            if (field === 'impostor') {
                const parsed = parseBoolean(value);
                if (parsed !== null) {
                    plan.flags.impostor = parsed;
                }
                continue;
            }
            if (field === 'price') {
                plan.price = parsePrice(value) ?? plan.price;
                continue;
            }

            const platform = normalizePlatform(field);
            if (platform) {
                const present = parseBoolean(value);
                if (present !== null) {
                    plan.platforms.push({ platform, present });
                } else {
                    const { op, rest } = parseComparison(value);
                    if (performanceRank(rest) >= 0) {
                        plan.platforms.push({ platform, op, rating: key(rest) });
                    }
                }
                continue;
            }

            const alias = FIELD_ALIASES[field];
            if (alias) {
                const { mode, values } = parseGroup(value);
                if (values.length > 0) {
                    plan.fields.push({ field: alias, mode, values });
                }
                continue;
            }
        }

        if (raw) {
            plan.include.push(lowered);
        }
    }

    return plan;
}

/**
 * Adds the clauses for one `feature:` token to a plan.
 *
 * `feature:all(a, b)` means every listed feature, but a single name can
 * resolve to several ids — `tail` is both a body feature and a PhysBone one.
 * Keeping each listed name as its own "any" clause is what makes both
 * readings work at once.
 *
 * @param {ReturnType<typeof parseQuery>} plan
 * @param {string} value
 */
function appendFeatureClauses(plan, value) {
    const { mode, values } = parseGroup(value);

    if (mode === 'all' && values.length > 1) {
        for (const token of values) {
            const ids = resolveFeatureToken(token);
            if (ids.length > 0) {
                plan.features.push({ mode: 'any', ids });
            }
        }
        return;
    }

    const ids = [];
    for (const token of values) {
        for (const id of resolveFeatureToken(token)) {
            if (!ids.includes(id)) {
                ids.push(id);
            }
        }
    }
    if (ids.length > 0) {
        plan.features.push({ mode: values.length > 1 ? mode : 'any', ids });
    }
}

/**
 * @param {string} value
 * @returns {{ op: string; value?: number; min?: number; max?: number } | null}
 */
function parsePrice(value) {
    const range = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(value.trim());
    if (range) {
        return { op: 'range', min: Number(range[1]), max: Number(range[2]) };
    }
    if (lower(value) === 'free') {
        return { op: '=', value: 0 };
    }
    const { op, rest } = parseComparison(value);
    const amount = Number(rest);
    return Number.isFinite(amount) && rest !== '' ? { op, value: amount } : null;
}

/**
 * Which platforms an avatar has a build for.
 *
 * Accepts the shapes that actually turn up: a `platforms` list, VRChat's
 * `unityPackages`, or a per-platform `performance` object.
 *
 * @param {object} avatar
 * @returns {Set<string>} Canonical platform keys
 */
export function avatarPlatforms(avatar) {
    const found = new Set();

    const add = (value) => {
        const platform = normalizePlatform(value);
        if (platform) {
            found.add(platform);
        }
    };

    if (Array.isArray(avatar?.platforms)) {
        avatar.platforms.forEach(add);
    } else if (typeof avatar?.platforms === 'string') {
        avatar.platforms.split(',').forEach(add);
    }

    if (Array.isArray(avatar?.unityPackages)) {
        for (const unityPackage of avatar.unityPackages) {
            add(unityPackage?.platform);
        }
    }

    if (avatar?.performance && typeof avatar.performance === 'object') {
        Object.keys(avatar.performance).forEach(add);
    }

    return found;
}

/**
 * An avatar's performance rating on one platform.
 *
 * @param {object} avatar
 * @param {string} platform Canonical platform key
 * @returns {string} Normalized rating, or '' when unknown
 */
export function avatarPerformance(avatar, platform) {
    const performance = avatar?.performance;

    if (performance && typeof performance === 'object') {
        for (const [name, value] of Object.entries(performance)) {
            if (normalizePlatform(name) === platform && value) {
                return key(value);
            }
        }
    }

    if (Array.isArray(avatar?.unityPackages)) {
        for (const unityPackage of avatar.unityPackages) {
            if (normalizePlatform(unityPackage?.platform) === platform && unityPackage?.performanceRating) {
                return key(unityPackage.performanceRating);
            }
        }
    }

    // A bare rating with no platform breakdown describes the PC build.
    if (platform === 'pc') {
        const flat = typeof performance === 'string' ? performance : avatar?.performanceRating;
        if (flat) {
            return key(flat);
        }
    }

    return '';
}

/**
 * @param {object} avatar
 * @returns {number} Price, 0 when free or unknown
 */
function avatarPrice(avatar) {
    const value = Number(avatar?.price ?? avatar?.productPrice ?? 0);
    return Number.isFinite(value) ? value : 0;
}

/**
 * @param {object} avatar
 * @returns {boolean}
 */
function avatarIsPaid(avatar) {
    if (typeof avatar?.paid === 'boolean') {
        return avatar.paid;
    }
    if (typeof avatar?.isPaid === 'boolean') {
        return avatar.isPaid;
    }
    return avatarPrice(avatar) > 0;
}

/**
 * @param {object} avatar
 * @returns {boolean}
 */
function avatarHasImpostor(avatar) {
    if (typeof avatar?.impostor === 'boolean') {
        return avatar.impostor;
    }
    if (typeof avatar?.hasImpostor === 'boolean') {
        return avatar.hasImpostor;
    }
    return Boolean(avatar?.impostorUrl);
}

/**
 * @param {object} avatar
 * @param {string} field
 * @returns {string[]} Lowercased values for that field
 */
function fieldValues(avatar, field) {
    if (field === 'author') {
        return [avatar.authorName, avatar.authorId].filter(Boolean).map((value) => String(value).toLowerCase());
    }
    if (field === 'styles' && avatar?.styles === undefined) {
        // avtr.zip exposes style as its own facet; providers that do not send
        // one usually fold the same words into tags.
        return fieldValues(avatar, 'tags');
    }
    if (field === 'platforms') {
        return Array.from(avatarPlatforms(avatar));
    }
    const value = avatar?.[field];
    if (Array.isArray(value)) {
        return value.filter(Boolean).map((item) => String(item).toLowerCase());
    }
    if (value === undefined || value === null || value === '') {
        return [];
    }
    if (typeof value === 'object') {
        return Object.values(value)
            .filter(Boolean)
            .map((item) => String(item).toLowerCase());
    }
    return [String(value).toLowerCase()];
}

/**
 * Everything free text searches over, as one lowercased haystack.
 *
 * @param {object} avatar
 * @returns {string}
 */
export function searchableText(avatar) {
    return [
        avatar?.name,
        avatar?.description,
        avatar?.authorName,
        avatar?.authorId,
        ...(Array.isArray(avatar?.tags) ? avatar.tags : []),
        ...(Array.isArray(avatar?.aiTags) ? avatar.aiTags : []),
        ...(Array.isArray(avatar?.styles) ? avatar.styles : []),
        ...normalizeAvatarFeatures(avatar?.features)
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

/**
 * Trigram similarity, the same shape of measure avtr.zip's `fuzzy:` uses.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function trigramSimilarity(a, b) {
    const toTrigrams = (value) => {
        const padded = `  ${String(value ?? '').toLowerCase()} `;
        const set = new Set();
        for (let i = 0; i < padded.length - 2; i += 1) {
            set.add(padded.slice(i, i + 3));
        }
        return set;
    };
    const left = toTrigrams(a);
    const right = toTrigrams(b);
    if (left.size === 0 || right.size === 0) {
        return 0;
    }
    let shared = 0;
    for (const gram of left) {
        if (right.has(gram)) {
            shared += 1;
        }
    }
    return shared / (left.size + right.size - shared);
}

/**
 * Best fuzzy score of `term` against any single word in the haystack.
 *
 * Comparing against the whole blob would wash out short terms, so this scores
 * word by word.
 *
 * @param {string} haystack
 * @param {string} term
 * @returns {number}
 */
function bestWordSimilarity(haystack, term) {
    let best = 0;
    for (const word of haystack.split(/[\s,._/|-]+/)) {
        if (!word) {
            continue;
        }
        const score = trigramSimilarity(word, term);
        if (score > best) {
            best = score;
        }
    }
    return best;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} Jaccard overlap, 0..1
 */
export function jaccard(a, b) {
    const left = new Set((a ?? []).map((v) => String(v).toLowerCase()));
    const right = new Set((b ?? []).map((v) => String(v).toLowerCase()));
    if (left.size === 0 || right.size === 0) {
        return 0;
    }
    let shared = 0;
    for (const value of left) {
        if (right.has(value)) {
            shared += 1;
        }
    }
    return shared / (left.size + right.size - shared);
}

/**
 * @param {number} value
 * @param {string} op
 * @param {number} target
 * @returns {boolean}
 */
function compareNumber(value, op, target) {
    switch (op) {
        case '>':
            return value > target;
        case '>=':
            return value >= target;
        case '<':
            return value < target;
        case '<=':
            return value <= target;
        default:
            return value === target;
    }
}

/**
 * Checks one platform clause.
 *
 * Performance comparisons read as quality, not rank: `quest:>=Good` means Good
 * or better, which is a *lower* rank index.
 *
 * @param {object} avatar
 * @param {{ platform: string; present?: boolean; op?: string; rating?: string }} clause
 * @returns {boolean}
 */
function matchesPlatform(avatar, clause) {
    if (clause.present !== undefined) {
        return avatarPlatforms(avatar).has(clause.platform) === clause.present;
    }

    const rank = performanceRank(avatarPerformance(avatar, clause.platform));
    const target = performanceRank(clause.rating ?? '');
    if (rank < 0 || target < 0) {
        return false;
    }

    switch (clause.op) {
        case '>':
            return rank < target;
        case '>=':
            return rank <= target;
        case '<':
            return rank > target;
        case '<=':
            return rank >= target;
        default:
            return rank === target;
    }
}

/**
 * Applies every non-text filter in a plan.
 *
 * @param {object} avatar
 * @param {ReturnType<typeof parseQuery>} plan
 * @returns {boolean}
 */
function matchesFilters(avatar, plan) {
    for (const clause of plan.fields) {
        const values = fieldValues(avatar, clause.field);
        const hit = (needle) => values.some((value) => value.includes(needle));
        if (!(clause.mode === 'all' ? clause.values.every(hit) : clause.values.some(hit))) {
            return false;
        }
    }

    if (plan.features.length > 0) {
        const owned = new Set(normalizeAvatarFeatures(avatar?.features));
        for (const clause of plan.features) {
            const hit = (id) => owned.has(lower(id));
            if (!(clause.mode === 'all' ? clause.ids.every(hit) : clause.ids.some(hit))) {
                return false;
            }
        }
    }

    for (const clause of plan.platforms) {
        if (!matchesPlatform(avatar, clause)) {
            return false;
        }
    }

    if (plan.flags.paid !== undefined && avatarIsPaid(avatar) !== plan.flags.paid) {
        return false;
    }
    if (plan.flags.impostor !== undefined && avatarHasImpostor(avatar) !== plan.flags.impostor) {
        return false;
    }

    if (plan.price) {
        const price = avatarPrice(avatar);
        const inRange =
            plan.price.op === 'range'
                ? price >= plan.price.min && price <= plan.price.max
                : compareNumber(price, plan.price.op, plan.price.value);
        if (!inRange) {
            return false;
        }
    }

    return true;
}

/**
 * Runs a parsed plan over a list of avatars.
 *
 * @param {object[]} avatars
 * @param {ReturnType<typeof parseQuery>} plan
 * @param {object} [options]
 * @param {() => number} [options.random] Injectable for deterministic tests
 * @returns {object & { score: number }[]}
 */
export function runQuery(avatars, plan, { random = Math.random } = {}) {
    const pool = Array.isArray(avatars) ? avatars : [];
    const results = [];

    for (const avatar of pool) {
        if (!avatar?.id) {
            continue;
        }
        const haystack = searchableText(avatar);

        let excluded = false;
        for (const term of plan.exclude) {
            if (haystack.includes(term)) {
                excluded = true;
                break;
            }
        }
        if (excluded) {
            continue;
        }

        if (!matchesFilters(avatar, plan)) {
            continue;
        }

        let score = 0;
        let matchesText = true;
        for (const term of plan.include) {
            if (plan.fuzzy > 0) {
                const similarity = bestWordSimilarity(haystack, term);
                if (similarity < plan.fuzzy) {
                    matchesText = false;
                    break;
                }
                score += similarity;
            } else {
                if (!haystack.includes(term)) {
                    matchesText = false;
                    break;
                }
                // A hit in the name counts for more than one in a description.
                score += String(avatar.name ?? '')
                    .toLowerCase()
                    .includes(term)
                    ? 2
                    : 1;
            }
        }
        if (!matchesText) {
            continue;
        }

        if (plan.similarTags.length > 0) {
            const tags = [
                ...(Array.isArray(avatar.tags) ? avatar.tags : []),
                ...(Array.isArray(avatar.aiTags) ? avatar.aiTags : [])
            ];
            const similarity = jaccard(tags, plan.similarTags);
            if (similarity <= 0) {
                continue;
            }
            score += similarity * 10;
        }

        results.push({ ...avatar, score });
    }

    if (plan.random) {
        for (let i = results.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            [results[i], results[j]] = [results[j], results[i]];
        }
        return results;
    }

    results.sort((a, b) => {
        for (const { field, direction } of plan.sorts) {
            const compared = NUMERIC_SORT_FIELDS.has(field)
                ? (Number(a[field]) || 0) - (Number(b[field]) || 0)
                : String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
            if (compared !== 0) {
                return direction === 'desc' ? -compared : compared;
            }
        }
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        return String(a.name ?? '').localeCompare(String(b.name ?? ''));
    });
    return results;
}

/**
 * Convenience wrapper: parse then run.
 *
 * @param {object[]} avatars
 * @param {string} query
 * @param {object} [options]
 * @returns {object & { score: number }[]}
 */
export function searchAvatars(avatars, query, options) {
    const trimmed = String(query ?? '').trim();
    if (!trimmed) {
        return Array.isArray(avatars) ? avatars.map((a) => ({ ...a, score: 0 })) : [];
    }
    return runQuery(avatars, parseQuery(trimmed), options);
}
