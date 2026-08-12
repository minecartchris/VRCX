# VRCX Plugin Builder

A visual, block-based editor for building VRCX plugins without writing
JavaScript. It emits the two files the GitHub importer expects:
`vrcx-plugin.json` and `index.js`.

## Using it

Open `index.html` in a browser — no server, no install, no internet needed.
Keep `codegen.js` next to it.

1. Fill in the plugin name and id (lower case, dashes only).
2. Drag a **trigger** onto the canvas, or click it.
3. Drag **actions** into the trigger.
4. Fill in the text boxes. The generated code updates as you type.
5. **Download both**, put the two files in a folder in a public GitHub repo.
6. In VRCX: Settings → Plugins → Import from GitHub, with
   `owner/repo/folder`.

**Save project** writes a `.builder.json` you can reload later to keep editing.
It is not needed to run the plugin — only the two generated files matter.

## Placeholders

Any text box accepts `{{...}}` placeholders:

| Placeholder | Meaning |
| --- | --- |
| `{{displayName}}`, `{{userId}}`, … | a field of the event that fired |
| `{{setting.key}}` | a plugin setting you defined |
| `{{counter.name}}` | a counter |

Each trigger lists the fields it provides in its header. A placeholder the
current trigger does not provide is left as literal text rather than producing
broken code, so a typo shows up on screen instead of crashing the plugin.

## Blocks

**Triggers** — plugin start, player joins / leaves, avatar change, world
change, video play, friend online / offline, VRChat starts or stops, and every
N seconds.

**Actions** — add a line to the Feed, show text in the chatbox, desktop
notification, set the status line, increment a counter, and a condition block
that stops the rest of the stack unless it holds.

A chatbox block is hoisted out of its trigger and registered once as a chatbox
source, because the chatbox is polled rather than pushed. It only appears in
VRChat when the **OSC Chatbox** plugin is also enabled.

## Editing the output by hand

The generated `index.js` is ordinary CommonJS. Imported plugins get no
`require` or `import` — the `ctx` object is the entire API. Re-generating from
the builder overwrites hand edits, so once you start editing by hand, keep
editing by hand.

## Tests

`src/plugin-system/__tests__/pluginBuilderCodegen.test.js` pushes generated
output through the same `validateRemoteManifest` + `compileRemotePlugin` path
the import button uses, then executes it against a stand-in context. It also
covers text containing backticks, `${`, and backslashes, which would otherwise
escape the generated template literal.
