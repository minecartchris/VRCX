/**
 * Lazy store access for plugins.
 *
 * Plugin modules are imported eagerly — the settings screen needs every
 * manifest to render the list — while VRCX's store graph is large and partly
 * circular. Resolving stores through dynamic imports at `setup` time keeps
 * plugin metadata cheap to load and keeps plugins out of that graph entirely.
 */

const loaders = {
    friend: () => import('../stores/friend'),
    game: () => import('../stores/game'),
    gameLog: () => import('../stores/gameLog'),
    location: () => import('../stores/location'),
    moderation: () => import('../stores/moderation'),
    user: () => import('../stores/user')
};

const factories = {
    friend: 'useFriendStore',
    game: 'useGameStore',
    gameLog: 'useGameLogStore',
    location: 'useLocationStore',
    moderation: 'useModerationStore',
    user: 'useUserStore'
};

/**
 * @param {Array<keyof typeof loaders>} names
 * @returns {Promise<Record<string, object>>} the requested stores, keyed by name
 */
export async function resolveStores(names) {
    const result = {};
    await Promise.all(
        names.map(async (name) => {
            const load = loaders[name];
            if (!load) {
                throw new Error(`unknown store "${name}"`);
            }
            const module = await load();
            result[name] = module[factories[name]]();
        })
    );
    return result;
}
