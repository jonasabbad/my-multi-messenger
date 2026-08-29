/*
 * Driver for Multi-Messenger Pro (Electron desktop app).
 *
 * The app has no programmatic UI surface of its own, so this driver talks to a
 * running instance over the Chrome DevTools Protocol (remote-debugging port).
 * Zero dependencies - uses Node's built-in fetch + WebSocket (Node >= 21).
 *
 * Verified on: Windows 11, Node v24, Electron 42 (bundled Chromium 148).
 *
 * Usage:
 *   node .claude/skills/run-my-multi-messenger/driver.mjs <command> [args]
 *
 * Commands:
 *   launch                 spawn the app detached with the debug port open
 *                          (clears ELECTRON_RUN_AS_NODE, logs to <logfile>)
 *   unlock                 dismiss the password lock screen if one is showing
 *                          (calls the renderer's hideLockScreen() - dev only)
 *   probe                  print version / user-agent / apps / webview count
 *   targets                list CDP targets (each <webview> + its URL)
 *   eval "<js>"            evaluate JS in the main renderer, print the result
 *   panel <name>           switchPanel('messenger'|'browser'|'settings'|'accounts')
 *   open-url <url>         go to the browser panel and load <url> in the tab
 *   show-app <index>       switch the messenger panel to myApps[<index>]
 *   shot <name>            full-screen PNG -> <shotdir>/<name>.png (PowerShell)
 *   stop                   taskkill every electron.exe
 *
 * Env:
 *   MMP_PORT     debug port (default 9222)
 *   MMP_SHOTDIR  screenshot dir (default: this skill dir /shots)
 *   MMP_LOG      app log file  (default: this skill dir /app.log)
 */

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const SKILL_DIR = import.meta.dirname;
const APP_DIR = path.resolve(SKILL_DIR, '../../..');
const PORT = process.env.MMP_PORT || '9222';
const SHOT_DIR = process.env.MMP_SHOTDIR || path.join(SKILL_DIR, 'shots');
const LOG_FILE = process.env.MMP_LOG || path.join(SKILL_DIR, 'app.log');

const ELECTRON_BIN = path.join(
  APP_DIR, 'node_modules', 'electron', 'dist',
  os.platform() === 'win32' ? 'electron.exe' : 'electron',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CDP plumbing ----------------------------------------------------------

async function mainTarget() {
  const res = await fetch(`http://localhost:${PORT}/json/list`);
  const targets = await res.json();
  const page =
    targets.find((t) => t.type === 'page' && t.url.includes('index.html')) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target - is the app running with --remote-debugging-port=' + PORT + '?');
  return { page, targets };
}

async function withRenderer(fn) {
  const { page } = await mainTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('cannot open CDP socket')));
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params = {}) =>
    new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  await call('Runtime.enable');
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error('renderer exception: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
    }
    return r.result?.result?.value;
  };
  try { return await fn(evaluate); }
  finally { ws.close(); }
}

// ---- commands ------------------------------------------------------------

async function cmdLaunch() {
  if (!fs.existsSync(ELECTRON_BIN)) throw new Error('electron binary not found at ' + ELECTRON_BIN + ' - run `npm install` first');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;      // set in some IDE shells; makes electron run as plain node
  env.ELECTRON_ENABLE_LOGGING = '1';
  const out = fs.openSync(LOG_FILE, 'w');
  const child = spawn(ELECTRON_BIN, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: APP_DIR, env, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  process.stdout.write(`spawned pid ${child.pid}, log -> ${LOG_FILE}\nwaiting for debug port ${PORT} `);
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${PORT}/json/version`); process.stdout.write('\nready\n'); return; }
    catch { process.stdout.write('.'); await sleep(1000); }
  }
  throw new Error('debug port never came up - check ' + LOG_FILE);
}

async function cmdUnlock() {
  await withRenderer(async (ev) => {
    const was = await ev(`(()=>{const l=document.getElementById('lockScreen');const shown=l && !l.classList.contains('hidden');if(shown && typeof hideLockScreen==='function')hideLockScreen();return shown;})()`);
    console.log(was ? 'lock screen dismissed' : 'no lock screen was showing');
  });
}

async function cmdProbe() {
  await withRenderer(async (ev) => {
    const info = await ev(`JSON.stringify({
      version: document.getElementById('aboutVersion')?.textContent || null,
      userAgent: navigator.userAgent,
      braveUA: typeof BRAVE_UA !== 'undefined' ? BRAVE_UA : null,
      apps: (typeof myApps !== 'undefined' ? myApps : []).map(a => ({ name: a.name, comingSoon: !!a.comingSoon })),
      webviews: document.querySelectorAll('#messengerPanel webview').length,
      browserContentDisplay: getComputedStyle(document.getElementById('browserContent')).display
    })`);
    console.log(JSON.stringify(JSON.parse(info), null, 2));
  });
}

async function cmdTargets() {
  const { targets } = await mainTarget();
  for (const t of targets) console.log(`${t.type.padEnd(10)} ${t.url}`);
}

async function cmdEval(expr) {
  if (!expr) throw new Error('usage: eval "<js expression>"');
  await withRenderer(async (ev) => console.log(JSON.stringify(await ev(expr))));
}

// eval-wv <url-substring> <js>  — evaluate JS inside a matching <webview> target
async function cmdEvalWv(raw) {
  const sp = raw.indexOf(' ');
  if (sp < 0) throw new Error('usage: eval-wv <url-substring> "<js>"');
  const match = raw.slice(0, sp), expr = raw.slice(sp + 1);
  const { targets } = await mainTarget();
  const t = targets.find((x) => x.type === 'webview' && x.url.includes(match));
  if (!t) throw new Error(`no webview target matching "${match}" - try: targets`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('cannot open CDP socket'))); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const res = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  ws.close();
  console.log(JSON.stringify(res.result?.result?.value ?? res.result?.exceptionDetails?.exception?.description ?? null));
}

async function cmdPanel(name) {
  if (!name) throw new Error('usage: panel <messenger|browser|settings|accounts>');
  await withRenderer(async (ev) => { await ev(`switchPanel(${JSON.stringify(name)})`); console.log('panel ->', name); });
}

async function cmdOpenUrl(url) {
  if (!url) throw new Error('usage: open-url <url>');
  await withRenderer(async (ev) => {
    await ev(`switchPanel('browser')`);
    await sleep(300);
    await ev(`document.getElementById('browserUrlBar').value=${JSON.stringify(url)}; browserNavigate();`);
    await sleep(3500);
    const box = await ev(`(()=>{const c=document.getElementById('browserContent');const w=c.querySelector('webview');const r=w&&w.getBoundingClientRect();return JSON.stringify({hasWebview:!!w,size:r&&{w:Math.round(r.width),h:Math.round(r.height)}});})()`);
    console.log('browser pane =', box);
  });
}

async function cmdShowApp(idx) {
  const n = Number(idx || 0);
  await withRenderer(async (ev) => {
    const res = await ev(`(()=>{ if(!myApps[${n}]) return 'no app at index ${n}'; switchPanel('messenger'); switchApp(myApps[${n}].id); return myApps[${n}].name; })()`);
    console.log('messenger ->', res);
  });
}

function cmdShot(name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const displayPath = path.join(SHOT_DIR, `${name || 'shot-' + Date.now()}.png`);
  const outfile = displayPath.replace(/\\/g, '\\\\'); // escape for the PS single-quoted string
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    "try { (New-Object -ComObject WScript.Shell).AppActivate('Multi-Messenger Pro') | Out-Null; Start-Sleep -Milliseconds 400 } catch {};",
    "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;",
    "$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);",
    "$g=[System.Drawing.Graphics]::FromImage($bmp);",
    "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
    `$bmp.Save('${outfile}',[System.Drawing.Imaging.ImageFormat]::Png);`,
  ].join(' ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  console.log('saved', displayPath);
}

function cmdStop() {
  try { console.log(execFileSync('taskkill', ['/F', '/IM', 'electron.exe'], { encoding: 'utf8' }).trim()); }
  catch (e) { console.log((e.stdout || '') + (e.stderr || '') || 'no electron.exe running'); }
}

// ---- dispatch ----------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(' ');
const table = {
  launch: cmdLaunch, unlock: cmdUnlock, probe: cmdProbe, targets: cmdTargets,
  eval: () => cmdEval(arg), 'eval-wv': () => cmdEvalWv(arg), panel: () => cmdPanel(arg), 'open-url': () => cmdOpenUrl(arg),
  'show-app': () => cmdShowApp(arg), shot: () => cmdShot(arg), stop: cmdStop,
};
if (!table[cmd]) {
  console.error('commands: ' + Object.keys(table).join(', '));
  process.exit(1);
}
try { await table[cmd](); }
catch (e) { console.error('ERROR:', e.message); process.exit(1); }
