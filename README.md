# Atrium

Nested Wayland/Xwayland compositor and Steam launch wrapper built on Lotus (`@lotus-gui/core`). Atrium owns the shell, plugins, profile, and Steam/Game Mode wrapper. Lotus owns the nest (`createExternalAppPane`, `setGameMode`, host hotkeys).

Current line is the **0.5.0-devel** prerelease, aligned with Lotus `0.5.0-devel`. It is not a stable release.

## Install

Download `Atrium-0.5.0-devel-x86_64.AppImage` from the [prerelease](https://github.com/1Jamie/Atrium/releases/tag/v0.5.0-devel). The file is a bash header plus a `tar.xz`. It is not a FUSE AppImage.

```bash
chmod +x Atrium-0.5.0-devel-x86_64.AppImage
./Atrium-0.5.0-devel-x86_64.AppImage
```

That extracts into `~/.local/share/atrium` and, when `~/.local/bin/atrium` is missing or already points at an Atrium install, links it there. If that path is some other program, the installer leaves it alone and prints a note. No root, no `.desktop` file.

```bash
./Atrium-0.5.0-devel-x86_64.AppImage --prefix ~/.local/share/atrium
./Atrium-0.5.0-devel-x86_64.AppImage --uninstall
./Atrium-0.5.0-devel-x86_64.AppImage --uninstall --purge
```

`--purge` also deletes `~/.config/lotus-atrium` and `~/.cache/lotus-atrium`.

### What lands where

| Path | What |
| --- | --- |
| `~/.local/share/atrium/` | The app: `atrium-host`, `lotus.linux-x64-gnu.node`, `bin/atrium`, `ui/`, `lib/`, bundled `plugins/`, `scripts/install-plugin.js` |
| `~/.local/bin/atrium` | Symlink to `~/.local/share/atrium/bin/atrium` |
| `~/.config/lotus-atrium/` | Profile and user plugins (`plugins/<id>/`) |
| `~/.cache/lotus-atrium/` | Resource root, Ghostty AppImage cache, and similar downloads |

Bundled plugins (perf, scaling, crosshair, notifications) live in the prefix. A copy of the same id under `~/.config` is ignored unless it was installed on purpose (it has a `.atrium-user-plugin` marker). Discord is not bundled.

## Launch

```bash
atrium -- %command%
atrium -w 1280 -h 720 -f -- %command%
```

`-w`/`-h` is the nested game size. `-W`/`-H` is the host window. `F12` toggles overlay and game. `F11` is fullscreen. `F7`/`F8` move dock tabs.

## Plugins

How they load, how to write one, and the install/pack commands: [docs/plugins.md](docs/plugins.md).

```bash
atrium --install-plugin /path/to/plugin-or.zip
atrium --remove-plugin discord-sidecar
```

Discord is a separate package: [atrium-discord](https://github.com/1Jamie/atrium-discord/releases).
