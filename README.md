# Atrium

Nested Wayland/Xwayland compositor and Steam launch wrapper built on [Lotus](../lotus) (`@lotus-gui/core`).

```bash
# from this repo (after npm install)
./bin/atrium -- glxgears
# or on PATH once linked:
atrium -- %command%
```

Lotus provides nest primitives (`createExternalAppPane`, `setGameMode`, host hotkeys). Atrium owns the shell, plugins, profile, and Steam/Game Mode wrapper.

See Lotus [`NEST.md`](../lotus/packages/lotus-core/NEST.md) for the engine API.
