import { createI18n } from 'vue-i18n';
import { describe, expect, test } from 'vitest';

import en from '../en.json';

/**
 * Every message is compiled here rather than lazily at first render.
 *
 * vue-i18n treats `@`, `|`, `{` and `}` as syntax. An unescaped one throws a
 * SyntaxError the moment the message is first rendered, which surfaces as a
 * component silently failing to mount — a dialog that only draws its backdrop,
 * for instance. Compiling everything up front turns that into a test failure
 * naming the exact key.
 */

/**
 * @param {object} node
 * @param {string} [prefix]
 * @returns {Array<[string, string]>} [dotted key, message]
 */
function flatten(node, prefix = '') {
    const out = [];
    for (const [key, value] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            out.push(...flatten(value, path));
        } else if (typeof value === 'string') {
            out.push([path, value]);
        }
    }
    return out;
}

const entries = flatten(en);

describe('en.json messages', () => {
    test('the locale file is not empty', () => {
        expect(entries.length).toBeGreaterThan(100);
    });

    test('every message compiles', () => {
        const i18n = createI18n({
            locale: 'en',
            fallbackLocale: 'en',
            legacy: false,
            globalInjection: false,
            missingWarn: false,
            fallbackWarn: false,
            warnHtmlMessage: false,
            messages: { en }
        });

        /** @type {string[]} */
        const broken = [];
        for (const [key, message] of entries) {
            try {
                // Named params are supplied loosely: a message using {name}
                // renders empty rather than throwing, which is fine — the point
                // is to force the compiler to run.
                i18n.global.t(key, {});
            } catch (err) {
                broken.push(
                    `${key}: ${err instanceof Error ? err.message : String(err)} — ${JSON.stringify(message)}`
                );
            }
        }
        expect(broken).toEqual([]);
    });

    test('a literal @ is escaped, since vue-i18n reads it as a linked message', () => {
        const offenders = entries
            .filter(([, message]) => /(^|[^{'])@/.test(message))
            .map(([key, message]) => `${key}: ${JSON.stringify(message)}`);
        expect(offenders).toEqual([]);
    });
});
