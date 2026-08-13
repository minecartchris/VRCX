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
5. **Download bundle** — one file holding the manifest and the code.
6. Put it anywhere with an https link and paste that link into VRCX:
   Settings → Plugins → Import from GitHub.

## Sharing a plugin

VRCX accepts three forms, so a one-file plugin does not need a repository.

| Paste this | Where it reads from |
| --- | --- |
| `https://gist.github.com/you/abc123` or `gist:abc123` | a gist, holding either a bundle file or `vrcx-plugin.json` plus its entry file |
| any other `https://…` link | a bundle file at that exact URL |
| `owner/repo`, `owner/repo@tag`, `owner/repo/folder` | the two-file layout in a repository |

A **bundle** is a single JSON file:

```json
{
    "vrcxPlugin": 1,
    "manifest": { "id": "my-plugin", "name": "My plugin", "...": "..." },
    "source": "module.exports = { setup(ctx) { ... } };"
}
```

The link must be to the raw file, not to a page displaying it — a gist's
"Raw" button gives you the right URL. Only `https` is accepted, so the
download cannot be altered in transit.

Updating still works for every form: VRCX re-fetches the same link.

## One-click install links

Paste your published link into **Install link** and you get a `vrcx://`
link that opens the plugin directly in VRCX:

```
vrcx://import-plugin/https%3A%2F%2Fgist.github.com%2Fyou%2Fabc123
```

Clicking it launches VRCX (or focuses the running copy), opens the import
dialog, and fetches the plugin so its source is on screen.

**It does not install anything.** The dialog still shows you the code and
waits for you to press Install. That is deliberate: an install link is
something people paste into chat, and a link that silently installed code
would hand any stranger full access to your machine and your VRChat
account. Read what you are about to run.

The link needs VRCX's `vrcx://` protocol handler, which the installer
registers. A portable copy that was never installed will not have it.

**Save project** writes a `.builder.json` you can reload later to keep editing.
It is not needed to run the plugin — only the two generated files matter.

## Placeholders

Any text box accepts `{{...}}` placeholders:

| Placeholder | Meaning |
| --- | --- |
| `{{displayName}}`, `{{userId}}`, … | a field of the event that fired |
| `{{setting.key}}` | a plugin setting you defined |
| `{{counter.name}}` | a counter |
| `{{instance.worldName}}`, … | the instance you are in (see below) |
| `{{player}}` | the current player, inside a "for each player" block |

### Instance fields

Available in any text box, in any block. Click a chip in the Instance panel to
copy the placeholder.

`worldName` `worldId` `instanceId` `instanceName` `accessType`
`accessTypeName` `region` `ownerId` `groupId` `isGroup` `ageGate`
`playerCount` `friendCount` `minutesHere` `inInstance` `location`

`ownerId` is whoever opened the instance — for a group instance it falls back
to the group id. It is empty in a public instance, which has no owner.

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

**Control flow** — these hold other blocks; drop actions inside them.

| Block | What it does |
| --- | --- |
| If … then … else | Runs one branch or the other. The else branch is skipped entirely if you leave it empty. Add as many conditions as you like with **+ condition** and join them with a single **and** / **or**. |
| Repeat N times | Runs its contents N times (1–1000). |
| For each player here | Once per player in your instance, `{{player}}` set to their name. |
| For each friend | Once per friend, filterable to online or favourites only. Exposes `{{friend}}`, `{{friendId}}`, `{{friendStatus}}`, `{{friendLocation}}`. |
| For each item in a list | Once per item in a named list, `{{item}}` set to the value. Iterates a copy, so adding to the list inside the loop cannot spin forever. |

They nest freely. Loop variables are suffixed by depth, so a repeat inside a
repeat does not clobber the outer counter.

**Variables** — counters hold a number, lists hold many values. Both are
created just by naming them in a block; there is nothing to declare.

| Block | What it does |
| --- | --- |
| Add 1 to a counter | Read it back with `{{counter.name}}`. |
| Add to a list | Appends a value. Read the whole list with `{{list.name}}` (comma joined) or its size with `{{list.name.count}}`. |
| Empty a list | Clears it. |

**VRChat** — talks to the live API.

| Block | What it does |
| --- | --- |
| Invite a user to a group | Needs the group id and a user id. |
| Call the VRChat API | Any endpoint and method, e.g. `GET auth/user`. |

## About the VRChat API blocks

These call the real API as your logged-in account, through VRCX's own request
layer, so they inherit its authentication and error handling.

Every plugin API call goes through a **shared throttle of one request roughly
every 1.2 seconds**. This is deliberate and worth understanding: the natural
thing to build here is "for each friend → invite to group", which without a
queue fires one request per friend as fast as the event loop allows. That trips
VRChat's rate limiter, and for anything invite-shaped it looks like spam —
which is against VRChat's Terms of Service and can get an account actioned.
The throttle is shared across all plugins so several cannot gang up.

A failed call is logged and the rest of the stack keeps running, so one bad
invite does not silently abort everything after it.

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
