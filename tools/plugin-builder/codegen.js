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
        stop: { label: 'Stop here unless a condition holds' },
        ifElse: { label: 'If … then … else', container: true },
        repeat: { label: 'Repeat N times', container: true },
        forEachPlayer: { label: 'For each player here', container: true }
    };

    /**
     * Fields exposed by `ctx.instance()`. Used both to validate
     * {{instance.x}} placeholders and to populate the palette hint.
     */
    var INSTANCE_FIELDS = [
        'worldName',
        'worldId',
        'instanceId',
        'instanceName',
        'accessType',
        'accessTypeName',
        'region',
        'ownerId',
        'groupId',
        'isGroup',
        'ageGate',
        'playerCount',
        'friendCount',
        'minutesHere',
        'inInstance',
        'location'
    ];

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
            var expression = resolveToken(
                token,
                vars,
                counters,
                settings,
                (scope && scope.locals) || null
            );
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
    function resolveToken(token, vars, counters, settings, locals) {
        if (token.indexOf('instance.') === 0) {
            var field = token.slice('instance.'.length);
            if (INSTANCE_FIELDS.indexOf(field) === -1) {
                return '';
            }
            return 'ctx.instance().' + field;
        }
        // Loop variables shadow event fields, which is what reads naturally
        // inside a "for each player" block.
        if (locals && locals[token]) {
            return locals[token];
        }
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
        walkActions(project, function (action) {
            if (action.type === 'count') {
                var key = sanitizeKey(action.name);
                if (names.indexOf(key) === -1) {
                    names.push(key);
                }
            }
        });
        return names;
    }

    /**
     * Visits every action in a project, including those nested inside
     * container blocks.
     *
     * @param {object} project
     * @param {(action: object) => void} visit
     */
    function walkActions(project, visit) {
        function descend(actions) {
            (actions || []).forEach(function (action) {
                if (!action) {
                    return;
                }
                visit(action);
                descend(action.children);
                descend(action.elseChildren);
            });
        }
        (project.stacks || []).forEach(function (stack) {
            descend(stack.actions);
        });
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
            case 'ifElse': {
                lines.push(indent + 'if (' + compileCondition(action, vars, scope) + ') {');
                lines.push.apply(
                    lines,
                    generateActions(action.children, vars, scope, indent + '    ')
                );
                var elseBody = generateActions(
                    action.elseChildren,
                    vars,
                    scope,
                    indent + '    '
                );
                if (elseBody.length) {
                    lines.push(indent + '} else {');
                    lines.push.apply(lines, elseBody);
                }
                lines.push(indent + '}');
                break;
            }
            case 'repeat': {
                var times = Math.max(1, Math.min(1000, Number(action.times) || 1));
                // `i` is suffixed by depth so nested repeats do not collide.
                var counterVar = 'i' + indent.length;
                lines.push(
                    indent +
                        'for (let ' +
                        counterVar +
                        ' = 0; ' +
                        counterVar +
                        ' < ' +
                        times +
                        '; ' +
                        counterVar +
                        ' += 1) {'
                );
                lines.push.apply(
                    lines,
                    generateActions(action.children, vars, scope, indent + '    ')
                );
                lines.push(indent + '}');
                break;
            }
            case 'forEachPlayer': {
                var playerVar = 'player' + indent.length;
                var innerScope = {
                    counters: scope.counters,
                    settings: scope.settings,
                    locals: Object.assign({}, scope.locals || {}, {
                        player: playerVar
                    })
                };
                lines.push(
                    indent +
                        'for (const ' +
                        playerVar +
                        ' of ctx.instance().players) {'
                );
                lines.push.apply(
                    lines,
                    generateActions(
                        action.children,
                        vars,
                        innerScope,
                        indent + '    '
                    )
                );
                lines.push(indent + '}');
                break;
            }
            default:
                break;
        }
        return lines;
    }

    /**
     * @param {object[]} actions
     * @param {string[]} vars
     * @param {object} scope
     * @param {string} indent
     * @returns {string[]}
     */
    function generateActions(actions, vars, scope, indent) {
        var lines = [];
        (actions || []).forEach(function (action) {
            if (!action || !ACTIONS[action.type] || action.type === 'chatbox') {
                return;
            }
            lines.push.apply(lines, generateAction(action, vars, scope, indent));
        });
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

            // The chatbox is a pull source rather than an action, so those
            // blocks are hoisted out of the trigger and registered once. They
            // are collected from anywhere in the stack, including inside
            // container blocks, since nesting one has no runtime meaning.
            walkActions({ stacks: [stack] }, function (action) {
                if (action.type === 'chatbox') {
                    chatboxStacks.push({ action: action, vars: [] });
                }
            });

            var runnable = generateActions(
                stack.actions,
                vars,
                scope,
                stack.trigger === 'start' ? '        ' : '            '
            );
            if (runnable.length === 0) {
                return;
            }

            if (stack.trigger === 'start') {
                body.push.apply(body, runnable);
                return;
            }

            if (stack.trigger === 'interval') {
                var seconds = Math.max(1, Number(stack.seconds) || 60);
                body.push('        ctx.interval(() => {');
                body.push.apply(body, runnable);
                body.push('        }, ' + seconds * 1000 + ');');
                return;
            }

            body.push('        ctx.on(ctx.events.' + trigger.event + ', (e) => {');
            body.push.apply(body, runnable);
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
        INSTANCE_FIELDS: INSTANCE_FIELDS,
        walkActions: walkActions,
        escapeTemplate: escapeTemplate,
        sanitizeKey: sanitizeKey,
        compileText: compileText,
        collectCounters: collectCounters,
        generateManifest: generateManifest,
        generateSource: generateSource,
        generate: generate
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
