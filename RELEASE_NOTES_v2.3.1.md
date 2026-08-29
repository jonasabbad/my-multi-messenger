# v2.3.1

Bug-fix release.

## Fixes

- **Browser panel rendering** — the in-app browser showed a solid background over
  the page. `.browser-content` is now a proper flex column so tab panes fill the
  area instead of collapsing to zero height.
- **Instagram login loop / duplicating QR** — `renderMessengers()` no longer
  wipes and recreates every `<webview>` on each add/remove/rename/toggle, so the
  Instagram login page (and its QR/checking state) is no longer reloaded in a
  loop. Instagram is now a real, session-persistent service instead of a
  "Coming Soon" placeholder.
- **Windows "Choose a passkey" dialog** — Instagram's login (accounts.meta.com)
  auto-invoked WebAuthn, popping the native Windows Security passkey dialog
  repeatedly. WebAuthn / passkey requests are now neutralised in every webview
  frame (main + sub-frames), and the relevant Chromium passkey features are
  disabled, so login falls straight through to the password form.

## Environment

- All webviews now send a current Chrome 136 desktop user-agent (matches real
  Brave) via `app.userAgentFallback` + per-webview `useragent`, and expose
  `navigator.brave.isBrave()`.

## Artifacts

| file | purpose |
|---|---|
| `MultiMessengerPro-Setup-2.3.1.exe` | NSIS installer |
| `MultiMessengerPro 2.3.1.exe` | portable |
| `MultiMessengerPro-Setup-2.3.1.exe.blockmap` | delta-update map |
| `latest.yml` | electron-updater feed — **must be attached** for in-app auto-update to work |
