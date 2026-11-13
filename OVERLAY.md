# Desktop overlay

Run the campaign helper as a small always-on-top overlay on top of Path of
Exile, so you can follow the route without a second screen.

- **Current step + next few steps**, with the current act's progress
- **Zone layout for the zone you're in** (images + notes from the act guides)
- **Auto-advance**: reads the game's `Client.txt` and ticks steps as you load
  into zones
- **Global hotkeys** to complete / undo steps without alt-tabbing
- **Click-through lock** so the overlay never eats your clicks
- Never steals focus from the game (Windows)
- Shares progress and build import with the full guide (tray → *Open full guide*)

> **Set PoE to _Windowed Fullscreen_** (Options → Graphics → Display Mode).
> In exclusive *Fullscreen* the game draws over every window, so no overlay
> can appear.

## Run it

```bash
npm install
npm run overlay          # builds the web app, starts the overlay
npm run overlay:dev      # hot-reload dev mode (vite + electron)
npm run overlay:dist     # Windows installer + portable .exe → overlay/release/
```

`overlay:dist` must run on Windows (or use the **Build overlay (Windows)**
GitHub Action, which uploads the `.exe` files as a build artifact).

## Hotkeys

| Default | Action |
| ------- | ------ |
| `Alt+X` | Complete current step |
| `Alt+Z` | Previous step (undoes a whole auto-advance in one press) |
| `Alt+C` | Show / hide zone layout |
| `Alt+L` | Lock / unlock (click-through) |
| `Alt+V` | Show / hide overlay |

Global hotkeys are consumed by the overlay, so the game won't see them.
Change them in the tray menu → **Settings file (hotkeys)…**, then
**Reload settings**. Values use
[Electron accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator)
(e.g. `Control+Shift+D`, `F7`, `num5`). Conflicts are shown in the overlay's
settings panel.

## Using it

- **Move**: drag the header. **Resize**: drag the bottom-right corner.
- **Lock** (padlock icon or `Alt+L`) once it's placed: clicks then go
  straight through to the game. Unlock with the hotkey or the tray menu.
- **Gear icon**: background opacity, text size, number of upcoming steps,
  auto-advance on/off, Client.txt location.
- The overlay has no taskbar button; it lives in the **system tray**.

## Auto-advance (Client.txt)

Every time you load a zone, PoE writes
`Generating level N area "<area id>"` to `logs/Client.txt`. The overlay
matches that id against the route's `➞ zone` / waypoint / logout steps:

- Entering a zone the route sends you to ticks every step before it. The
  "go to X" step itself is ticked only when it's pure travel; a step like
  "➞ Arena, kill boss" stays current.
- Towns only count when they are the **next** place on the route, so
  detours to sell or portal home don't skip anything.
- It only looks 15 steps ahead and never ticks anything on startup.
- `Alt+Z` right after an auto-advance reverts the whole jump.

The path is auto-detected for the standalone client, Steam and Epic default
installs. Otherwise: tray → **Choose Client.txt…** (it's in the game's
`logs` folder).

The overlay only *reads* the log the game writes for itself, and hotkeys
only act on the overlay, never on the game. That's the same model as
widely used tools (Awakened PoE Trade, Exile-UI).

## How it's built

```
overlay/                Electron shell (own workspace: no runtime deps)
  main.cjs              windows, tray, hotkeys, app:// protocol, settings
  preload.cjs           the small `window.overlay` API the page can call
  client-log.cjs        Client.txt tailer
web/src/containers/Overlay/   the compact overlay view (route #/overlay)
web/src/overlay/              bridge typings + per-zone layout parser
```

- The web app is built with `vite build --mode overlay` into
  `web/dist-overlay` (same app, no PWA service worker) and served inside
  Electron from `app://bundle/…`. That gives a fixed origin, so
  localStorage progress persists across restarts.
- The overlay view also works in a normal browser at `#/overlay` (no hotkeys
  or auto-advance there). Handy on a phone or tablet.
- Settings live in `%APPDATA%\PoE Campaign Overlay\overlay-settings.json`.
