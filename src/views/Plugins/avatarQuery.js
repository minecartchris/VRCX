/**
 * Avatar search query engine.
 *
 * Implements the query syntax published for avtr.zip's full-text search, run
 * locally against whatever avatars VRCX knows about (your history, favorites,
 * cached avatars, and anything pulled from the configured avatar database).
 *
 * Avtr.zip documents the syntax but not a public API, so this is a
 * reimplementation of the language rather than a client for their service. If
 * an endpoint becomes available it can be slotted in as another candidate
 * source without changing the query language.
 *
 * Supported:
 * free text            substring match across name/description/tags/author
 * -term                exclude
 * fuzzy:0.75           switch free text to trigram similarity at a threshold
 * tag:x                field match; also aiTag, author, authorName,
 * authorId, platforms, performance
 * tag:any(a, b)        at least one
 * tag:all(a, b)        all of them
 * sort:name(asc)       sort directives, applied left to right
 * random:true          shuffle within the current filters
 * similar to tags a, b Jaccard tag similarity ranking
 */

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
    name: 'name',
    description: 'description'
};

const SORTABLE = {
    name: 'name',
    authorname: 'authorName',
    createdat: 'created_at',
    updatedat: 'updated_at'
};

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
        sorts: [],
        fuzzy: 0,
        random: false,
        similarTags: []
    };

    const tokens = tokenizeQuery(input);
    for (let i = 0; i < tokens.length; i += 1) {
        const raw = tokens[i];
        const lower = raw.toLowerCase();

        // "similar to tags a, b" / "similar to tags:a,b"
        if (lower === 'similar' && tokens[i + 1]?.toLowerCase() === 'to') {
            const third = tokens[i + 2] ?? '';
            if (third.toLowerCase().startsWith('tags')) {
                const inline = third.slice(4).replace(/^[:\s]+/, '');
                const rest = [inline, ...tokens.slice(i + 3)].join(' ').trim();
                plan.similarTags = splitList(rest);
                break;
            }
        }

        if (lower === 'and' || lower === 'or') {
            // Segment joiners: everything here is already AND of includes.
            continue;
        }

        if (raw.startsWith('-') && raw.length > 1) {
            plan.exclude.push(raw.slice(1).toLowerCase());
            continue;
        }

        const colon = raw.indexOf(':');
        if (colon > 0) {
            const key = lower.slice(0, colon);
            const value = raw.slice(colon + 1);

            if (key === 'fuzzy') {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) {
                    plan.fuzzy = Math.min(1, Math.max(0, parsed));
                }
                continue;
            }
            if (key === 'random') {
                plan.random = value.toLowerCase() !== 'false';
                continue;
            }
            if (key === 'sort') {
                const match = /^([a-z_]+)(?:\((asc|desc)\))?$/i.exec(value);
                const field = SORTABLE[match?.[1]?.toLowerCase() ?? ''];
                if (field) {
                    plan.sorts.push({
                        field,
                        direction: match[2]?.toLowerCase() === 'desc' ? 'desc' : 'asc'
                    });
                }
                continue;
            }

            const field = FIELD_ALIASES[key];
            if (field) {
                const group = /^(any|all)\((.*)\)$/i.exec(value);
                if (group) {
                    plan.fields.push({
                        field,
                        mode: group[1].toLowerCase() === 'all' ? 'all' : 'any',
                        values: splitList(group[2])
                    });
                } else if (value) {
                    plan.fields.push({
                        field,
                        mode: 'all',
                        values: [value.toLowerCase()]
                    });
                }
                continue;
            }
        }

        if (raw) {
            plan.include.push(lower);
        }
    }

    return plan;
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
    const value = avatar?.[field];
    if (Array.isArray(value)) {
        return value.filter(Boolean).map((item) => String(item).toLowerCase());
    }
    if (value === undefined || value === null || value === '') {
        return [];
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
        ...(Array.isArray(avatar?.aiTags) ? avatar.aiTags : [])
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

        let matchesFields = true;
        for (const clause of plan.fields) {
            const values = fieldValues(avatar, clause.field);
            const hit = (needle) => values.some((value) => value.includes(needle));
            matchesFields = clause.mode === 'all' ? clause.values.every(hit) : clause.values.some(hit);
            if (!matchesFields) {
                break;
            }
        }
        if (!matchesFields) {
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
            const left = String(a[field] ?? '');
            const right = String(b[field] ?? '');
            const compared = left.localeCompare(right);
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
