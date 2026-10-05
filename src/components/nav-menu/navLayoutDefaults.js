import { DASHBOARD_NAV_KEY_PREFIX } from '../../shared/constants';

export function createBaseDefaultNavLayout(t) {
    return [
        { type: 'item', key: 'feed' },
        { type: 'item', key: 'friends-locations' },
        { type: 'item', key: 'game-log' },
        { type: 'item', key: 'player-list' },
        { type: 'item', key: 'search' },
        { type: 'item', key: 'plugins' },
        {
            type: 'folder',
            id: 'default-folder-favorites',
            nameKey: 'nav_tooltip.favorites',
            name: t('nav_tooltip.favorites'),
            icon: 'ri-star-line',
            items: ['favorite-friends', 'favorite-worlds', 'favorite-avatars']
        },
        {
            type: 'folder',
            id: 'default-folder-social',
            nameKey: 'nav_tooltip.social',
            name: t('nav_tooltip.social'),
            icon: 'ri-group-line',
            items: ['friend-log', 'friend-list', 'moderation']
        },
        { type: 'item', key: 'notification' },
        { type: 'item', key: 'my-avatars' },
        {
            type: 'folder',
            id: 'default-folder-charts',
            nameKey: 'nav_tooltip.charts',
            name: t('nav_tooltip.charts'),
            icon: 'ri-pie-chart-line',
            items: ['charts-instance', 'charts-mutual', 'charts-hot-worlds']
        },
        { type: 'item', key: 'tools' },
        { type: 'item', key: 'direct-access' }
    ];
}

export function insertDashboardEntries(layout, dashboardDefinitions) {
    const nextLayout = Array.isArray(layout) ? [...layout] : [];
    const dashboardEntries = (dashboardDefinitions || []).map((def) => ({
        type: 'item',
        key: def.key
    }));

    if (!dashboardEntries.length) {
        return nextLayout;
    }

    const directAccessIdx = nextLayout.findIndex((entry) => entry.type === 'item' && entry.key === 'direct-access');

    if (directAccessIdx !== -1) {
        nextLayout.splice(directAccessIdx, 0, ...dashboardEntries);
    } else {
        nextLayout.push(...dashboardEntries);
    }

    return nextLayout;
}

export function isDashboardNavKey(key) {
    return String(key || '').startsWith(DASHBOARD_NAV_KEY_PREFIX);
}

/**
 * Inserts a nav entry into a layout that predates it.
 *
 * A stored layout replaces the defaults wholesale, so anyone who has ever
 * customised their nav would never see a newly added entry. This slots the key
 * in just after `afterKey` (or at the end if that is gone), leaving layouts
 * that already mention it — including ones where the user moved it, put it in
 * a folder, or hid it — untouched.
 *
 * @param {Array} layout
 * @param {string} key
 * @param {string} afterKey
 * @param {Iterable<string>} [hiddenKeys]
 * @returns {Array} The same array when nothing changed, otherwise a new one
 */
export function ensureNavEntry(layout, key, afterKey, hiddenKeys = []) {
    if (!Array.isArray(layout) || !key) {
        return layout;
    }
    const hidden = hiddenKeys instanceof Set ? hiddenKeys : new Set(hiddenKeys);
    if (hidden.has(key)) {
        return layout;
    }

    const mentionsKey = layout.some((entry) => {
        if (entry?.type === 'item') {
            return entry.key === key;
        }
        if (entry?.type === 'folder') {
            return (entry.items || []).includes(key);
        }
        return false;
    });
    if (mentionsKey) {
        return layout;
    }

    const next = [...layout];
    const anchor = next.findIndex((entry) => entry?.type === 'item' && entry.key === afterKey);
    const entry = { type: 'item', key };
    if (anchor === -1) {
        next.push(entry);
    } else {
        next.splice(anchor + 1, 0, entry);
    }
    return next;
}
