import { describe, expect, test } from 'vitest';

import { buildPluginFeedEntry, normalizeLevel } from '../feed';

describe('plugin feed entries', () => {
    test('builds a complete row', () => {
        const entry = buildPluginFeedEntry(
            {
                pluginId: 'avatar-change-log',
                pluginName: 'Avatar change log',
                message: 'Alice → CoolAvatar'
            },
            {
                detail: 'Avatar id: avtr_1',
                level: 'info',
                userId: 'usr_1',
                displayName: 'Alice',
                createdAt: '2024-01-05T10:00:00.000Z'
            }
        );
        expect(entry).toEqual({
            created_at: '2024-01-05T10:00:00.000Z',
            type: 'Plugin',
            pluginId: 'avatar-change-log',
            pluginName: 'Avatar change log',
            level: 'info',
            message: 'Alice → CoolAvatar',
            detail: 'Avatar id: avtr_1',
            userId: 'usr_1',
            displayName: 'Alice'
        });
    });

    test('falls back to the plugin id when there is no name', () => {
        const entry = buildPluginFeedEntry({
            pluginId: 'my-plugin',
            message: 'hello'
        });
        expect(entry.pluginName).toBe('my-plugin');
    });

    test('drops an entry with no message', () => {
        expect(
            buildPluginFeedEntry({ pluginId: 'p', message: '   ' })
        ).toBeNull();
        expect(buildPluginFeedEntry({ pluginId: 'p' })).toBeNull();
    });

    test('optional fields default to empty strings rather than undefined', () => {
        const entry = buildPluginFeedEntry({ pluginId: 'p', message: 'hi' });
        expect(entry.detail).toBe('');
        expect(entry.userId).toBe('');
        expect(entry.displayName).toBe('');
    });

    test('stamps a timestamp when none is given', () => {
        const entry = buildPluginFeedEntry({ pluginId: 'p', message: 'hi' });
        expect(Number.isFinite(Date.parse(entry.created_at))).toBe(true);
    });

    test('unknown levels fall back to info', () => {
        expect(normalizeLevel('error')).toBe('error');
        expect(normalizeLevel('WARNING')).toBe('warning');
        expect(normalizeLevel('banana')).toBe('info');
        expect(normalizeLevel(undefined)).toBe('info');
    });
});
