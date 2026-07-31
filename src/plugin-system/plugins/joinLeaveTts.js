/**
 * Speaks instance join/leave events out loud using the browser speech
 * synthesiser, so you can keep track of who is around without reading the feed.
 *
 * @type {import('../registry').PluginManifest}
 */
export const joinLeaveTtsPlugin = {
    id: 'join-leave-tts',
    name: 'Spoken join/leave',
    nameKey: 'view.plugins.items.join_leave_tts.name',
    descriptionKey: 'view.plugins.items.join_leave_tts.description',
    description:
        'Announces players joining and leaving your instance with text to speech.',
    icon: 'ri-volume-up-line',
    category: 'social',
    tags: ['audio', 'instance'],
    settingsSchema: [
        {
            key: 'announceJoins',
            type: 'boolean',
            label: 'Announce joins',
            default: true
        },
        {
            key: 'announceLeaves',
            type: 'boolean',
            label: 'Announce leaves',
            default: true
        },
        {
            key: 'friendsOnly',
            type: 'boolean',
            label: 'Friends only',
            default: true
        },
        {
            key: 'favoritesOnly',
            type: 'boolean',
            label: 'Favorites only',
            description: 'Narrower than "friends only" when both are on.',
            default: false
        },
        {
            key: 'joinTemplate',
            type: 'string',
            label: 'Join phrase',
            description: '{name} is replaced with the display name.',
            default: '{name} joined'
        },
        {
            key: 'leaveTemplate',
            type: 'string',
            label: 'Leave phrase',
            default: '{name} left'
        },
        {
            key: 'volume',
            type: 'number',
            label: 'Volume',
            default: 0.8,
            min: 0,
            max: 1,
            step: 0.05
        },
        {
            key: 'rate',
            type: 'number',
            label: 'Speech rate',
            default: 1,
            min: 0.5,
            max: 2,
            step: 0.1
        },
        {
            key: 'maxQueued',
            type: 'number',
            label: 'Max queued announcements',
            description:
                'Extra announcements are dropped, so a mass join does not talk for a minute.',
            default: 3,
            min: 1,
            max: 20
        }
    ],

    setup(ctx) {
        const synth = globalThis.speechSynthesis;
        if (!synth) {
            ctx.setStatus(
                'Speech synthesis is not available in this environment.',
                'error'
            );
            return;
        }
        const settings = ctx.settings;
        let queued = 0;

        /**
         * @param {string} text
         */
        function speak(text) {
            if (queued >= settings.maxQueued) {
                return;
            }
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.volume = settings.volume;
            utterance.rate = settings.rate;
            queued += 1;
            const done = () => {
                queued = Math.max(0, queued - 1);
            };
            utterance.onend = done;
            utterance.onerror = done;
            synth.speak(utterance);
        }

        /**
         * @param {{isFriend: boolean, isFavorite: boolean}} payload
         * @returns {boolean}
         */
        function passesFilter(payload) {
            if (settings.favoritesOnly) {
                return Boolean(payload.isFavorite);
            }
            if (settings.friendsOnly) {
                return Boolean(payload.isFriend);
            }
            return true;
        }

        ctx.on(ctx.events.PLAYER_JOIN, (payload) => {
            if (!settings.announceJoins || !passesFilter(payload)) {
                return;
            }
            speak(
                settings.joinTemplate.replace(
                    /\{name\}/g,
                    payload.displayName ?? ''
                )
            );
        });

        ctx.on(ctx.events.PLAYER_LEAVE, (payload) => {
            if (!settings.announceLeaves || !passesFilter(payload)) {
                return;
            }
            speak(
                settings.leaveTemplate.replace(
                    /\{name\}/g,
                    payload.displayName ?? ''
                )
            );
        });

        ctx.onDispose(() => {
            synth.cancel();
        });

        ctx.setStatus('Ready.', 'ok');
    }
};
