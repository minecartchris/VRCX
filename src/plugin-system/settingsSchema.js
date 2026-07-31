/**
 * Helpers for the declarative settings schema used by plugin manifests.
 *
 * A schema is a plain array of field descriptors so a plugin never has to ship
 * its own Vue component just to be configurable:
 *
 * ```js
 * settingsSchema: [
 *     { key: 'port', type: 'number', label: '...', default: 9000, min: 1, max: 65535 },
 *     { key: 'mode', type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }] }
 * ]
 * ```
 */

/**
 * @typedef {'boolean'|'number'|'string'|'text'|'password'|'select'|'multiselect'|'color'|'list'} PluginSettingType
 */

/**
 * @typedef {object} PluginSettingField
 * @property {string} key
 * @property {PluginSettingType} type
 * @property {string} [label]
 * @property {string} [labelKey] i18n key, takes precedence over `label`
 * @property {string} [description]
 * @property {string} [descriptionKey]
 * @property {*} [default]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string} [placeholder]
 * @property {Array<{value: *, label: string}>} [options]
 * @property {(settings: object) => boolean} [visibleWhen]
 */

const NUMERIC_TYPES = new Set(['number']);

/**
 * Default value for a field when the plugin author omitted one.
 *
 * @param {PluginSettingField} field
 * @returns {*}
 */
export function defaultValueForField(field) {
    if (field.default !== undefined) {
        return field.default;
    }
    switch (field.type) {
        case 'boolean':
            return false;
        case 'number':
            return field.min ?? 0;
        case 'multiselect':
        case 'list':
            return [];
        case 'select':
            return field.options?.[0]?.value ?? '';
        default:
            return '';
    }
}

/**
 * Builds a complete settings object from a schema.
 *
 * @param {PluginSettingField[]} [schema]
 * @returns {Record<string, *>}
 */
export function buildDefaultSettings(schema) {
    const result = {};
    if (!Array.isArray(schema)) {
        return result;
    }
    for (const field of schema) {
        if (!field?.key) {
            continue;
        }
        result[field.key] = defaultValueForField(field);
    }
    return result;
}

/**
 * Coerces and clamps a single value to the shape declared by its field.
 *
 * @param {PluginSettingField} field
 * @param {*} value
 * @returns {*}
 */
export function coerceValue(field, value) {
    if (value === undefined || value === null) {
        return defaultValueForField(field);
    }
    if (field.type === 'boolean') {
        return Boolean(value);
    }
    if (NUMERIC_TYPES.has(field.type)) {
        let num = Number(value);
        if (!Number.isFinite(num)) {
            num = defaultValueForField(field);
        }
        if (typeof field.min === 'number') {
            num = Math.max(field.min, num);
        }
        if (typeof field.max === 'number') {
            num = Math.min(field.max, num);
        }
        return num;
    }
    if (field.type === 'multiselect' || field.type === 'list') {
        if (!Array.isArray(value)) {
            return defaultValueForField(field);
        }
        return value.slice();
    }
    if (field.type === 'select') {
        const allowed = field.options?.map((option) => option.value);
        if (allowed?.length && !allowed.includes(value)) {
            return defaultValueForField(field);
        }
        return value;
    }
    return String(value);
}

/**
 * Merges persisted settings on top of schema defaults, dropping unknown keys
 * and repairing values whose type drifted (e.g. after a schema change).
 *
 * @param {PluginSettingField[]} [schema]
 * @param {Record<string, *>} [stored]
 * @returns {Record<string, *>}
 */
export function normalizeSettings(schema, stored) {
    const result = buildDefaultSettings(schema);
    if (!stored || typeof stored !== 'object' || !Array.isArray(schema)) {
        return result;
    }
    for (const field of schema) {
        if (!field?.key || !(field.key in stored)) {
            continue;
        }
        result[field.key] = coerceValue(field, stored[field.key]);
    }
    return result;
}

/**
 * @param {PluginSettingField} field
 * @param {Record<string, *>} settings
 * @returns {boolean}
 */
export function isFieldVisible(field, settings) {
    if (typeof field?.visibleWhen !== 'function') {
        return true;
    }
    try {
        return Boolean(field.visibleWhen(settings));
    } catch {
        return true;
    }
}
