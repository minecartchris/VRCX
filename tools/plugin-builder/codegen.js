/**
 * Code generation for the VRCX visual plugin builder.
 *
 * Turns a project (the block stacks the user assembled) into the two files the
 * GitHub importer expects: a `vrcx-plugin.json` manifest and a CommonJS
 * `index.js`. Kept free of DOM access so the same file backs the browser UI and
 * the test suite.
 *
 * Loaded as a classic script in the browser (file:// blocks ES modules), so it
 * assigns to globalThis rather than using export syntax.
 */
(function (root) {
    'use strict';

    /**
     * Blocks the palette offers. `code` receives the resolved argument strings.
     *
     * Event blocks expose their payload fields as placeholders; `vars` lists
     * which ones are valid inside that trigger.
     */
    var TRIGGERS = {
        start: {
            label: 'When the plugin starts',
            vars: []
        },
        playerJoin: {
            label: 'When a player joins your instance',
            event: 'PLAYER_JOIN',
            vars: ['displayName', 'userId', 'isFriend']
        },
        playerLeave: {
            label: 'When a player leaves your instance',
            event: 'PLAYER_LEAVE',
            vars: ['displayName', 'userId', 'isFriend']
        },
        avatarChange: {
            label: 'When someone changes avatar',
            event: 'AVATAR_CHANGE',
            vars: ['displayName', 'userId', 'avatarName', 'avatarId']
        },
        locationChange: {
            label: 'When you change world',
            event: 'LOCATION_CHANGE',
            vars: ['name', 'location']
        },
        videoPlay: {
            label: 'When a video starts playing',
            event: 'VIDEO_PLAY',
            vars: ['videoName', 'videoUrl', 'displayName']
        },
        friendOnline: {
            label: 'When a friend comes online',
            event: 'FRIEND_ONLINE',
            vars: ['displayName', 'userId', 'location']
        },
        friendOffline: {
            label: 'When a friend goes offline',
            event: 'FRIEND_OFFLINE',
            vars: ['displayName', 'userId']
        },
        gameState: {
            label: 'When VRChat starts or stops',
            event: 'GAME_STATE',
            vars: ['isRunning']
        },
        interval: {
            label: 'Every N seconds',
            vars: []
        }
    };

    var ACTIONS = {
        feed: { label: 'Add a line to the Feed' },
        chatbox: { label: 'Show text in the chatbox' },
        notify: { label: 'Send a desktop notification' },
        status: { label: 'Set the plugin status line' },
        count: { label: 'Add 1 to a counter' },
        stop: { label: 'Stop here unless a condition holds' }
    };

    /**
     * Escapes text for embedding in a JS template literal.
     *
     * @param {string} text
     * @returns {string}
     */
    function escapeTemplate(text) {
        return String(text === undefined || text === null ? '' : text)
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
    }

    /**
     * @param {string} value
     * @returns {string} a safe single-quoted JS string literal
     */
    function quote(value) {
        return JSON.stringify(String(value === undefined ? '' : value));
    }

    /**
     * Valid JS identifier for a settings key or counter name.
     *
     * @param {string} rawKey
     * @returns {string}
     */
    function sanitizeKey(rawKey) {
        var cleaned = String(rawKey || '')
            .replace(/[^A-Za-z0-9_]/g, '_')
            .replace(/^([0-9])/, '_$1');
        return cleaned || 'value';
    }

    /**
     * Compiles user text with {{placeholders}} into a template literal.
     *
     * Recognised placeholders:
     *   {{field}}         a field of the current event (only inside a trigger
     *                     that provides it)
     *   {{setting.key}}   a plugin setting
     *   {{counter.name}}  a counter
     * Anything else is left as literal text, so a stray {{ }} cannot produce
     * broken JavaScript.
     *
     * @param {string} text
     * @param {string[]} eventVars fields available from the current trigger
     * @param {{counters?: Set<string>, settings?: Set<string>}} [scope]
     * @returns {string} template literal source, including backticks
     */
    function compileText(text, eventVars, scope) {
        var vars = eventVars || [];
        var counters = (scope && scope.counters) || null;
        var settings = (scope && scope.settings) || null;
        var source = String(text === undefined || text === null ? '' : text);
        var out = '';
        var index = 0;

        while (index < source.length) {
            var openAt = source.indexOf('{{', index);
            if (openAt === -1) {
                out += escapeTemplate(source.slice(index));
                break;
            }
            var closeAt = source.indexOf('}}', openAt + 2);
            if (closeAt === -1) {
                out += escapeTemplate(source.slice(index));
                break;
            }
            out += escapeTemplate(source.slice(index, openAt));
            var token = source.slice(openAt + 2, closeAt).trim();
            var expression = resolveToken(token, vars, counters, settings);
            if (expression) {
                out += '${' + expression + '}';
            } else {
                // Unknown placeholder: keep the literal text so the user can
                // see their typo instead of getting a runtime crash.
                out += escapeTemplate(source.slice(openAt, closeAt + 2));
            }
            index = closeAt + 2;
        }
        return '`' + out + '`';
    }

    /**
     * @param {string} token
     * @param {string[]} vars
     * @param {Set<string>|null} counters
     * @param {Set<string>|null} settings
     * @returns {string} JS expression, or '' when unrecognised
     */
    function resolveToken(token, vars, counters, settings) {
        if (token.indexOf('setting.') === 0) {
            var settingKey = sanitizeKey(token.slice('setting.'.length));
            if (settings && !settings.has(settingKey)) {
                return '';
            }
            return 's.' + settingKey;
        }
        if (token.indexOf('counter.') === 0) {
            var counterKey = sanitizeKey(token.slice('counter.'.length));
            if (counters && !counters.has(counterKey)) {
                return '';
            }
            return 'counters.' + counterKey;
        }
        if (vars.indexOf(token) !== -1) {
            return 'e.' + sanitizeKey(token);
        }
        return '';
    }

    /**
     * Collects the counter names a project uses, so they can be declared.
     *
     * @param {object} project
     * @returns {string[]}
     */
    function collectCounters(project) {
        var names = [];
        (project.stacks || []).forEach(function (stack) {
            (stack.actions || []).forEach(function (action) {
                if (action.type === 'count') {
                    var key = sanitizeKey(action.name);
                    if (names.indexOf(key) === -1) {
                        names.push(key);
                    }
                }
            });
        });
        return names;
    }

    /**
     * @param {object} project
     * @returns {object} manifest object, ready to be JSON.stringify'd
     */
    function generateManifest(project) {
        var settings = (project.settings || []).map(function (field) {
            var out = {
                key: sanitizeKey(field.key),
                type: field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'string',
                label: field.label || field.key
            };
            if (out.type === 'number') {
                out.default = Number(field.default) || 0;
            } else if (out.type === 'boolean') {
                out.default = Boolean(field.default);
            } else {
                out.default = String(field.default === undefined ? '' : field.default);
            }
            return out;
        });

        return {
            id: project.id || 'my-plugin',
            name: project.name || 'My plugin',
            description: project.description || '',
            version: project.version || '1.0.0',
            icon: project.icon || 'ri-puzzle-line',
            category: project.category || 'automation',
            entry: 'index.js',
            settingsSchema: settings
        };
    }

    /**
     * @param {object} action
     * @param {string[]} vars
     * @param {object} scope
     * @param {string} indent
     * @returns {string[]} lines of generated code
     */
    function generateAction(action, vars, scope, indent) {
        var lines = [];
        switch (action.type) {
            case 'feed': {
                var level = ['info', 'success', 'warning', 'error'].indexOf(action.level) !== -1 ? action.level : 'info';
                var options = ['level: ' + quote(level)];
                if (vars.indexOf('userId') !== -1) {
                    options.push('userId: e.userId');
                }
                if (vars.indexOf('displayName') !== -1) {
                    options.push('displayName: e.displayName');
                }
                lines.push(
                    indent + 'ctx.feed(' + compileText(action.text, vars, scope) + ', { ' + options.join(', ') + ' });'
                );
                break;
            }
            case 'notify':
                lines.push(indent + 'if (typeof AppApi !== "undefined" && typeof AppApi.DesktopNotification === "function") {');
                lines.push(
                    indent +
                        '    AppApi.DesktopNotification(' +
                        compileText(action.title, vars, scope) +
                        ', ' +
                        compileText(action.text, vars, scope) +
                        ", '');"
                );
                lines.push(indent + '}');
                break;
            case 'status':
                lines.push(indent + 'ctx.setStatus(' + compileText(action.text, vars, scope) + ", 'ok');");
                break;
            case 'count':
                lines.push(indent + 'counters.' + sanitizeKey(action.name) + ' += 1;');
                break;
            case 'stop':
                lines.push(indent + 'if (!(' + compileCondition(action, vars, scope) + ')) { return; }');
                break;
            default:
                break;
        }
        return lines;
    }

    /**
     * Conditions stay deliberately simple: compare a placeholder to text.
     *
     * @param {object} action
     * @param {string[]} vars
     * @param {object} scope
     * @returns {string}
     */
    function compileCondition(action, vars, scope) {
        var left = compileText(action.left, vars, scope);
        var right = compileText(action.right, vars, scope);
        switch (action.operator) {
            case 'notEquals':
                return left + ' !== ' + right;
            case 'contains':
                return left + '.toLowerCase().includes(' + right + '.toLowerCase())';
            case 'notEmpty':
                return left + '.trim() !== ""';
            case 'equals':
            default:
                return left + ' === ' + right;
        }
    }

    /**
     * @param {object} project
     * @returns {string} index.js source
     */
    function generateSource(project) {
        var counters = collectCounters(project);
        var settingKeys = new Set(
            (project.settings || []).map(function (field) {
                return sanitizeKey(field.key);
            })
        );
        var scope = { counters: new Set(counters), settings: settingKeys };

        var lines = [];
        lines.push('/**');
        lines.push(' * ' + (project.name || 'My plugin'));
        lines.push(' *');
        lines.push(' * Generated by the VRCX visual plugin builder. Safe to edit by hand,');
        lines.push(' * but re-generating will overwrite your changes.');
        lines.push(' */');
        lines.push('');
        lines.push('module.exports = {');
        lines.push('    setup(ctx) {');
        lines.push('        const s = ctx.settings;');
        if (counters.length) {
            lines.push(
                '        const counters = { ' +
                    counters
                        .map(function (counterName) {
                            return counterName + ': 0';
                        })
                        .join(', ') +
                    ' };'
            );
        }

        var chatboxStacks = [];
        var body = [];

        (project.stacks || []).forEach(function (stack) {
            var trigger = TRIGGERS[stack.trigger];
            if (!trigger) {
                return;
            }
            var vars = trigger.vars || [];
            var actions = (stack.actions || []).filter(function (action) {
                return ACTIONS[action.type];
            });

            // The chatbox is a pull source rather than an action, so those
            // blocks are hoisted out of the trigger and registered once.
            actions
                .filter(function (action) {
                    return action.type === 'chatbox';
                })
                .forEach(function (action) {
                    chatboxStacks.push({ action: action, vars: [] });
                });

            var runnable = actions.filter(function (action) {
                return action.type !== 'chatbox';
            });
            if (runnable.length === 0) {
                return;
            }

            if (stack.trigger === 'start') {
                runnable.forEach(function (action) {
                    body.push.apply(body, generateAction(action, vars, scope, '        '));
                });
                return;
            }

            if (stack.trigger === 'interval') {
                var seconds = Math.max(1, Number(stack.seconds) || 60);
                body.push('        ctx.interval(() => {');
                runnable.forEach(function (action) {
                    body.push.apply(body, generateAction(action, vars, scope, '            '));
                });
                body.push('        }, ' + seconds * 1000 + ');');
                return;
            }

            body.push('        ctx.on(ctx.events.' + trigger.event + ', (e) => {');
            runnable.forEach(function (action) {
                body.push.apply(body, generateAction(action, vars, scope, '            '));
            });
            body.push('        });');
        });

        chatboxStacks.forEach(function (entry, position) {
            lines.push(
                '        ctx.chatbox(() => ' +
                    compileText(entry.action.text, entry.vars, scope) +
                    ', { label: ' +
                    quote(project.name || 'Plugin') +
                    ', order: ' +
                    (100 + position) +
                    ' });'
            );
        });

        lines.push.apply(lines, body);

        if (!body.length && !chatboxStacks.length) {
            lines.push("        ctx.setStatus('This plugin has no blocks yet.', 'warning');");
        }

        lines.push('    }');
        lines.push('};');
        lines.push('');
        return lines.join('\n');
    }

    /**
     * @param {object} project
     * @returns {{manifest: object, manifestJson: string, source: string}}
     */
    function generate(project) {
        var manifest = generateManifest(project || {});
        return {
            manifest: manifest,
            manifestJson: JSON.stringify(manifest, null, 4) + '\n',
            source: generateSource(project || {})
        };
    }

    root.VrcxPluginCodegen = {
        TRIGGERS: TRIGGERS,
        ACTIONS: ACTIONS,
        escapeTemplate: escapeTemplate,
        sanitizeKey: sanitizeKey,
        compileText: compileText,
        collectCounters: collectCounters,
        generateManifest: generateManifest,
        generateSource: generateSource,
        generate: generate
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
