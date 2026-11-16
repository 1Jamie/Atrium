# Plugins

A plugin is a directory with `plugin.json` and a host file. Atrium loads the host, calls `activate`, and the host registers whatever UI it needs. Unload calls `deactivate`, then throws away what `activate` registered.

The overlay has a plugin list (name, version, on/off). Turning one on loads it now. Turning it off unloads it now. You do not have to restart.

## Layout

```
my-plugin/
  plugin.json
  host.js
  ui/index.html      optional
  package.json       optional, only if you have npm deps
```

`plugin.json`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "host": "host.js"
}
```

`id` must match `[a-z0-9-]+`. `host` is the file Atrium requires. `version` is required when you pack a zip.

`host.js` exports `activate` and `deactivate`:

```js
'use strict';

async function activate(ctx) {
  await ctx.registerContribution({
    id: 'main',
    label: 'My Plugin',
    sortKey: 100,
    content: { kind: 'servo', entry: 'ui/index.html' },
  });
}

async function deactivate(ctx) {
  if (ctx && typeof ctx.disposeAll === 'function') ctx.disposeAll();
}

module.exports = { activate, deactivate };
```

HTML entries are served as `lotus-resource://localhost/plugins/<id>/...`. Paths in `entry` are relative to the plugin directory.

## What you can register

`registerContribution` adds a dock tab. `content.kind` is `servo` (an HTML entry) or `external` (a command Atrium nests in the pane). The shell places the pane. You do not pass coordinates. The handle has `dispose`, `update`, and `focus`.

`registerGameOverlay` is a surface drawn over the game. You give it an HTML `entry`, an anchor, and a size. `setShown` hides or shows it. `setRestSize` changes the rest size.

`registerAction` pins a button in the corner socket. Keep it small. The socket only shows a few.

`ctx.storage` is the plugin's saved settings. `ctx.ipc` is messages to and from that plugin's pages. `ctx.subscribe` listens for shell events. Pad and controller input is not one of those events. Plugins do not get the gamepad.

If `activate` throws, Atrium drops that plugin's buttons and disposes what it registered.

## Where plugins live

Bundled plugins ship inside `~/.local/share/atrium/plugins`. Those are perf, scaling, crosshair, and notifications.

Anything you install goes to `~/.config/lotus-atrium/plugins/<id>` and gets a `.atrium-user-plugin` file. That file is the only reason a user copy wins over a bundled plugin with the same id. A leftover copy in config without that marker is ignored.

## Install and remove

From an installed Atrium (`atrium` on `PATH`):

```bash
atrium --install-plugin /path/to/plugin
atrium --install-plugin /path/to/plugin.zip
atrium --remove-plugin my-plugin
```

A directory is copied as-is (`.git` is skipped). A zip is unpacked. `..` and absolute paths inside the zip are rejected. The installed tree is what the running shell loads, so if you edit a checkout, install again or you are still running the old copy.

From an Atrium git checkout the same commands exist on the dev CLI:

```bash
npx atrium-dev install plugin <dir|zip>
npx atrium-dev remove plugin <id>
npx atrium-dev pack plugin <dir> [--out file.zip]
```

`pack plugin` runs `npm install --omit=dev` when there is a `package.json`. If it finds any `.node` file under `node_modules` (including scoped and nested ones), it runs `npm rebuild` and writes `engines.modules` and `engines.node` into `plugin.json`. Atrium checks `engines.modules` against `process.versions.modules` before it loads the host, so a mismatched addon never gets to `dlopen`.

The zip is what you ship. Players should not need npm. Ghostty is not part of that zip. Atrium downloads that AppImage itself when a plugin asks for it.

## Dev CLI

`npx atrium-dev` is for working in the repo. Steam still launches `atrium` / `./bin/atrium`.

```
npx atrium-dev run [-- args]     launch the shell
npx atrium-dev test              node --test test/*.test.js
npx atrium-dev pack plugin <dir> [--out zip]
npx atrium-dev install plugin <dir|zip>
npx atrium-dev remove plugin <id>
npx atrium-dev build             SEA directory (atrium-host + .node)
npx atrium-dev installer         self-extracting installer
```
