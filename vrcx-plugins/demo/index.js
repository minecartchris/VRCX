/**
 * Demo plugin for VRCX.
 *
 * An imported plugin is plain CommonJS. It cannot `require` or `import`
 * anything — the `ctx` object passed to setup() is the whole API surface.
 * Everything you register through ctx is torn down automatically when the
 * plugin is disabled, so teardown() is usually unnecessary.
 */

module.exports = {
    async setup(ctx) {
        const settings = ctx.settings;

        // ctx.storage persists across restarts. It is JSON, scoped per plugin.
        let seen = (await ctx.storage.get('seen', 0)) || 0;

        function updateStatus() {
            // Shows a line under the plugin in Settings -> Plugins.
            ctx.setStatus(`Seen ${seen} joins this install.`, 'ok');
        }

        // ctx.feed writes into the Feed tab under the "Plugin" category.
        ctx.feed(settings.greeting, {
            detail: 'Written by the demo plugin at startup.',
            level: settings.level
        });

        // ctx.on subscribes to VRCX runtime events. See ctx.events for the
        // full list: TICK, GAME_LOG, LOCATION_CHANGE, PLAYER_JOIN,
        // PLAYER_LEAVE, VIDEO_PLAY, AVATAR_CHANGE, FRIEND_ONLINE,
        // FRIEND_OFFLINE, FRIEND_LOCATION, GAME_STATE, OSC_MESSAGE, AUTH_STATE.
        ctx.on(ctx.events.PLAYER_JOIN, ({ userId, displayName, isFriend }) => {
            seen += 1;
            updateStatus();
            if (!settings.logJoins) {
                return;
            }
            ctx.feed(`${displayName} joined`, {
                detail: isFriend ? 'On your friends list.' : '',
                userId,
                displayName,
                level: settings.level
            });
        });

        ctx.on(ctx.events.AVATAR_CHANGE, ({ displayName, avatarName }) => {
            if (!settings.logAvatarChanges) {
                return;
            }
            ctx.feed(`${displayName} switched to ${avatarName || 'an avatar'}`);
        });

        ctx.on(ctx.events.LOCATION_CHANGE, ({ name: worldName }) => {
            ctx.feed(`You entered ${worldName || 'a world'}`, {
                level: 'success'
            });
        });

        // ctx.interval and ctx.timeout are cleaned up on teardown, unlike the
        // global setInterval.
        ctx.interval(() => {
            ctx.storage.set('seen', seen).catch(() => {
                /* storage is best effort */
            });
        }, 60000);

        // ctx.chatbox contributes a line to the OSC chatbox. It only appears
        // when the "OSC Chatbox" plugin is also enabled.
        if (settings.showInChatbox) {
            ctx.chatbox(() => `${settings.chatboxPrefix}${seen}`, {
                label: 'Demo counter',
                order: settings.order
            });
        }

        // Persist a final count when the plugin is disabled.
        ctx.onDispose(() => ctx.storage.set('seen', seen));

        updateStatus();
    }
};
