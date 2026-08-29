---
name: run-my-multi-messenger
description: Build, launch, drive, and screenshot Multi-Messenger Pro — the Electron desktop app in this repo. Use when asked to run/start/launch the app, take a screenshot of it, open a panel or webview, verify a UI change, or build the dist installer.
---

Multi-Messenger Pro is an Electron 42 desktop app (`main.js` + `index.html` +
`renderer.js`, `<webview>` tags per messaging service). It has no CLI or HTTP
surface, so for automated use you launch it with the Chrome DevTools remote
debugging port open and drive it through
[`driver.mjs`](driver.mjs), a zero-dependency CDP client (Node built-in
`fetch` + `WebSocket`).

**Verified on:** Windows 11, Node v24, PowerShell/Git-Bash. All commands below
were run from the repo root this way.

All paths are relative to the repo root (the directory with `package.json`).

## Prerequisites

- Node 21+ (uses global `fetch`/`WebSocket`; tested on v24).
- `npm install` — installs Electron 42 into `node_modules/electron/dist/electron.exe`.
- A real Windows desktop session (screenshots use `System.Drawing` via `powershell.exe`; the app renders to a real window).

```bash
npm install
```

## Run (agent path)

The driver is stateless: `launch` starts the app as a detached process, every
other subcommand reconnects over the debug port (default 9222). The app keeps
running between calls — end with `stop`.

```bash
node .claude/skills/run-my-multi-messenger/driver.mjs launch
# wait ~5s for first paint, then:
node .claude/skills/run-my-multi-messenger/driver.mjs unlock          # if a password lock screen is set
node .claude/skills/run-my-multi-messenger/driver.mjs probe
node .claude/skills/run-my-multi-messenger/driver.mjs open-url https://example.com
node .claude/skills/run-my-multi-messenger/driver.mjs shot 01-browser
node .claude/skills/run-my-multi-messenger/driver.mjs show-app 0
node .claude/skills/run-my-multi-messenger/driver.mjs shot 02-messenger
node .claude/skills/run-my-multi-messenger/driver.mjs stop
```

Screenshots land in `.claude/skills/run-my-multi-messenger/shots/` (override with
`MMP_SHOTDIR`). **Open the PNG and look at it** — a blank/lock-screen frame means
you skipped `unlock` or the window lost focus.

### Commands

| command | what it does |
|---|---|
| `launch` | spawn the app detached with `--remote-debugging-port=9222`; clears `ELECTRON_RUN_AS_NODE`; app stdout/stderr -> `app.log`; waits for the port |
| `unlock` | dismiss the password lock overlay if present (calls renderer `hideLockScreen()`; dev-only) |
| `probe` | print app version, `navigator.userAgent`, `BRAVE_UA`, the `myApps` list, `<webview>` count, `#browserContent` computed `display` |
| `targets` | list CDP targets — one `webview` row per live `<webview>` with its URL |
| `eval "<js>"` | evaluate JS in the main renderer, print the JSON result |
| `panel <messenger\|browser\|settings\|accounts>` | call `switchPanel(...)` |
| `open-url <url>` | switch to the browser panel and load `<url>`; prints the webview's rendered size |
| `show-app <index>` | switch the messenger panel to `myApps[<index>]` |
| `shot <name>` | full-screen PNG -> `shots/<name>.png` (focuses the window first) |
| `stop` | `taskkill /F /IM electron.exe` |

`probe` is the fastest health check. A good run looks like:

```json
{
  "version": "Version 2.3.0",
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "braveUA": "Mozilla/5.0 (Windows NT 10.0; ... Chrome/136.0.0.0 Safari/537.36",
  "apps": [ { "name": "WhatsApp", "comingSoon": false }, ... ],
  "webviews": 3,
  "browserContentDisplay": "flex"
}
```

## Run (human path)

```bash
npm start
```

Opens the window normally. **Only works if `ELECTRON_RUN_AS_NODE` is not set** —
some IDE-integrated shells (VS Code's) export it, which makes `electron .` run
`main.js` as plain Node and crash with
`TypeError: Cannot set properties of undefined (setting 'userAgentFallback')`.
In that case: `ELECTRON_RUN_AS_NODE= npm start`, or just use the driver (it
clears the var itself).

## Build (dist installer)

```bash
npm run dist        # electron-builder -> dist/  (~2 min)
```

Produces `dist/MultiMessengerPro-Setup-<version>.exe` (NSIS),
`dist/MultiMessengerPro <version>.exe` (portable), and `latest.yml` +
`.blockmap` for the electron-updater feed. `dist/` is gitignored. Old-version
artifacts are not cleaned up — delete them by hand.

## Gotchas

- **`ELECTRON_RUN_AS_NODE=1` is set in the VS Code terminal.** It silently turns
  `electron .` into a Node run — no `app`, no window, immediate `TypeError` at
  `main.js:12`. `driver.mjs launch` deletes the var before spawning; the human
  path needs it cleared manually. This is an environment quirk, not an app bug.
- **The password lock screen blocks visual verification.** If the user has set an
  app password, `launch` shows a full-screen unlock overlay (z-index 10000). CDP
  `eval`/`open-url` still work through it, but screenshots are just the lock
  screen until you run `unlock`.
- **The user's store persists real accounts.** `myApps` comes from
  `electron-store` in the OS userData dir, not the repo — expect whatever
  services the user actually added (this machine: 3× WhatsApp). `show-app <n>`
  indexes into that live list.
- **Screenshots are whole-virtual-screen**, not just the app window (no
  window-only capture without extra tooling). The driver calls
  `WScript.Shell.AppActivate('Multi-Messenger Pro')` first so the window is on
  top, but other windows are still in frame.
- **`launch` returns before the UI is painted.** The debug port opens a beat
  before `renderer.js` finishes; give it ~5s (or poll `probe`) before driving.
- **`webviews` count in `probe` excludes the browser-panel tab** (it queries
  `#messengerPanel webview`). Use `targets` to see every `<webview>` including
  browser tabs.

## Troubleshooting

- **`ERROR: no page target - is the app running...`** — the app isn't up, or
  crashed. Check `.claude/skills/run-my-multi-messenger/app.log`. Re-run `launch`.
- **`launch` prints dots for 60s then errors** — port never came up. Usually a
  stale instance holding 9222: run `stop`, then `launch` again.
- **`electron binary not found`** — run `npm install`.
- **Log noise that is NOT a failure** (appears on every healthy run):
  - `Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL': Error: An object could not be cloned.` — long-standing benign Electron `<webview>` attach warning; the webviews load fine.
  - `net\disk_cache ... Unable to move the cache: Access is denied` / `Gpu Cache Creation failed` — cache-dir contention when a second instance briefly overlaps; harmless.
  - `Skip checkForUpdates because application is not packed` — expected for an unpackaged dev run.
