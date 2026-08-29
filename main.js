const { app, BrowserWindow, ipcMain, Tray, Menu, nativeTheme, shell, nativeImage, session, webFrameMain } = require('electron');
const path = require('path');
const crypto = require('crypto');
const Store = require('electron-store');

// ─── Brave / Chrome environment ───────────────────────────────────────────────
// Real Brave sends a Chrome-identical UA (no "Brave" token). Setting the fallback
// here strips Electron's own UA token from every session/webview that doesn't
// explicitly override it, so sites (Instagram especially) stop serving the
// degraded, self-reloading page they hand to unknown user agents.
const BRAVE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
app.userAgentFallback = BRAVE_UA;

// ─── Disable WebAuthn / passkeys ─────────────────────────────────────────────
// Instagram's login (accounts.meta.com) auto-invokes navigator.credentials.get()
// with a publicKey request, which makes Chromium pop the native Windows Security
// "Choose a passkey" dialog on a loop. Electron has no API to turn WebAuthn off,
// so we (1) kill the Chromium features that auto-start the flow, and (2) inject a
// shim into every webview frame that neutralises publicKey credential calls and
// hides passkey feature-detection, so Meta falls straight through to the
// password form. See injectPasskeyBlocker() further down.
app.commandLine.appendSwitch('disable-features', [
  'WebAuthenticationConditionalUI',        // the "autofill from a passkey" prompt
  'WebAuthenticationRemoteDesktopSupport',
  'WebAuthenticationHybridLinking',        // "iPhone, iPad, or Android device"
  'WebAuthenticationNewBleUx',
].join(','));

// Shim executed in every webview frame before the site's own auth code runs.
// Rejecting with NotAllowedError is exactly what a user-cancelled passkey looks
// like, so sites treat it as "declined" instead of retrying.
const PASSKEY_BLOCKER_SRC = `(() => {
  try {
    var reject = function () {
      return Promise.reject(new DOMException('Passkeys are disabled in this app.', 'NotAllowedError'));
    };
    var creds = navigator.credentials;
    if (creds) {
      var _get = creds.get ? creds.get.bind(creds) : null;
      var _create = creds.create ? creds.create.bind(creds) : null;
      creds.get = function (opts) {
        if (opts && opts.publicKey) return reject();
        return _get ? _get(opts) : reject();
      };
      creds.create = function (opts) {
        if (opts && opts.publicKey) return reject();
        return _create ? _create(opts) : reject();
      };
    }
    // Make passkey feature-detection say "not supported" so the flow never starts.
    // (Keep the object itself so sites that call PublicKeyCredential.isUVPAA()
    // don't throw — just have every probe resolve false/reject.)
    if (window.PublicKeyCredential) {
      var no = function () { return Promise.resolve(false); };
      try { window.PublicKeyCredential.isConditionalMediationAvailable = no; } catch (e) {}
      try { window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = no; } catch (e) {}
      try { window.PublicKeyCredential.getClientCapabilities = function () { return Promise.resolve({}); }; } catch (e) {}
    }
  } catch (e) {}
})();`;

function injectPasskeyBlocker(frame) {
  if (!frame) return;
  try { frame.executeJavaScript(PASSKEY_BLOCKER_SRC, true).catch(() => {}); } catch (e) {}
}

// Apply to every <webview> guest, in the main frame and any sub-frames
// (Instagram loads accounts.meta.com in an iframe — that's where the call is).
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;

  contents.on('did-navigate', () => injectPasskeyBlocker(contents.mainFrame));
  contents.on('dom-ready', () => injectPasskeyBlocker(contents.mainFrame));
  contents.on('did-frame-navigate', (_evt, _url, _code, _status, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    injectPasskeyBlocker(webFrameMain.fromId(processId, routingId));
  });
});

// ─── Electron Store ────────────────────────────────────────────────────────────
const store = new Store({
  name: 'multi-messenger-config',
  defaults: {
    settings: {
      theme: 'dark',           // 'light' | 'dark' | 'system'
      accentColor: '#6366f1',  // indigo
      language: 'en',
      startWithWindows: false,
      minimizeToTray: true,
      showNotificationBadges: true,
      enableDesktopNotifications: true,
      notificationSound: true,
      badgePollInterval: 2000,
      compactMode: false,
      autoLockEnabled: false,
      autoLockMinutes: 5,
    },
    apps: null,  // null = will trigger migration from localStorage on first run
    bookmarks: [
      { id: 'bm_1', title: 'Google', url: 'https://www.google.com', icon: '' },
      { id: 'bm_2', title: 'YouTube', url: 'https://www.youtube.com', icon: '' },
    ],
    history: [],
    password: null, // { hash, salt } or null
  }
});

// ─── Globals ───────────────────────────────────────────────────────────────────
let win = null;
let tray = null;
let isQuitting = false;
let lastActivityTime = Date.now();
let autoLockTimer = null;

// ─── Password Hashing ─────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    const s = salt || crypto.randomBytes(32).toString('hex');
    crypto.scrypt(password, s, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve({ hash: derivedKey.toString('hex'), salt: s });
    });
  });
}

async function verifyPasswordHash(password, storedHash, storedSalt) {
  const { hash } = await hashPassword(password, storedSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

// ─── Auto-Lock ────────────────────────────────────────────────────────────────
function resetAutoLockTimer() {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  const settings = store.get('settings');
  if (settings.autoLockEnabled && store.get('password')) {
    const ms = (settings.autoLockMinutes || 5) * 60 * 1000;
    autoLockTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('app:lock');
      }
    }, ms);
  }
}

// ─── Create Window ────────────────────────────────────────────────────────────
function createWindow() {
  const iconPath = path.join(__dirname, 'icon.ico');

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Multi-Messenger Pro',
    icon: iconPath,
    frame: false,
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for preload
    }
  });

  win.loadFile('index.html');
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    win.show();
  });

  // Maximize events
  win.on('maximize', () => win.webContents.send('window:maximizeChanged', true));
  win.on('unmaximize', () => win.webContents.send('window:maximizeChanged', false));

  // Close to tray
  win.on('close', (e) => {
    if (!isQuitting && store.get('settings.minimizeToTray')) {
      e.preventDefault();
      win.hide();
    }
  });

  // Startup setting
  const settings = store.get('settings');
  app.setLoginItemSettings({ openAtLogin: settings.startWithWindows || false });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'icon.ico');
  tray = new Tray(iconPath);
  tray.setToolTip('Multi-Messenger Pro');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { if (win) win.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if (win) win.show(); });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// Window controls
ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:maximize', () => {
  if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window:close', () => {
  if (win) win.close();
});
ipcMain.handle('window:isMaximized', () => win ? win.isMaximized() : false);

// Settings
ipcMain.handle('settings:get', () => store.get('settings'));
ipcMain.handle('settings:set', (_e, key, value) => {
  store.set(`settings.${key}`, value);
  // Side effects
  if (key === 'startWithWindows') {
    app.setLoginItemSettings({ openAtLogin: value });
  }
  if (key === 'autoLockEnabled' || key === 'autoLockMinutes') {
    resetAutoLockTimer();
  }
  return true;
});
ipcMain.handle('settings:reset', () => {
  const defaults = {
    theme: 'dark',
    accentColor: '#6366f1',
    language: 'en',
    startWithWindows: false,
    minimizeToTray: true,
    showNotificationBadges: true,
    enableDesktopNotifications: true,
    notificationSound: true,
    badgePollInterval: 2000,
    compactMode: false,
    autoLockEnabled: false,
    autoLockMinutes: 5,
  };
  store.set('settings', defaults);
  app.setLoginItemSettings({ openAtLogin: false });
  return defaults;
});

// Apps
ipcMain.handle('apps:get', () => store.get('apps'));
ipcMain.handle('apps:set', (_e, apps) => { store.set('apps', apps); return true; });

// Remove a specific service completely: clear its partition session data and remove from store
ipcMain.handle('apps:removeService', async (_e, appId) => {
  try {
    const apps = store.get('apps') || [];
    const app_to_remove = apps.find(a => a.id === appId);
    if (!app_to_remove) {
      return { success: false, error: 'Service not found' };
    }

    // Clear all session/storage data for this service's partition only
    const partitionName = app_to_remove.part; // e.g. "persist:wa1"
    if (partitionName) {
      const ses = session.fromPartition(partitionName);
      const clearOp = Promise.all([
        ses.clearStorageData().catch(() => {}),
        ses.clearCache().catch(() => {})
      ]);
      const timeoutOp = new Promise(resolve => setTimeout(resolve, 1500));
      await Promise.race([clearOp, timeoutOp]);
    }

    // Remove only this app from the stored array
    const updatedApps = apps.filter(a => a.id !== appId);
    store.set('apps', updatedApps);

    return { success: true };
  } catch (err) {
    console.error(`[removeService] Failed to remove service ${appId}:`, err);
    return { success: false, error: err.message || 'Unknown error during removal' };
  }
});

// Password
ipcMain.handle('password:isEnabled', () => !!store.get('password'));
ipcMain.handle('password:set', async (_e, password) => {
  const { hash, salt } = await hashPassword(password);
  store.set('password', { hash, salt });
  resetAutoLockTimer();
  return true;
});
ipcMain.handle('password:verify', async (_e, password) => {
  const stored = store.get('password');
  if (!stored) return false;
  try {
    return await verifyPasswordHash(password, stored.hash, stored.salt);
  } catch { return false; }
});
ipcMain.handle('password:change', async (_e, oldPw, newPw) => {
  const stored = store.get('password');
  if (!stored) return { success: false, error: 'No password set' };
  const valid = await verifyPasswordHash(oldPw, stored.hash, stored.salt);
  if (!valid) return { success: false, error: 'Invalid current password' };
  const { hash, salt } = await hashPassword(newPw);
  store.set('password', { hash, salt });
  return { success: true };
});
ipcMain.handle('password:remove', async (_e, password) => {
  const stored = store.get('password');
  if (!stored) return { success: true };
  const valid = await verifyPasswordHash(password, stored.hash, stored.salt);
  if (!valid) return { success: false, error: 'Invalid password' };
  store.delete('password');
  if (autoLockTimer) clearTimeout(autoLockTimer);
  return { success: true };
});

// Browser
ipcMain.handle('browser:getBookmarks', () => store.get('bookmarks') || []);
ipcMain.handle('browser:setBookmarks', (_e, bm) => { store.set('bookmarks', bm); return true; });
ipcMain.handle('browser:getHistory', () => store.get('history') || []);
ipcMain.handle('browser:addHistory', (_e, entry) => {
  const history = store.get('history') || [];
  history.unshift({ ...entry, timestamp: Date.now() });
  if (history.length > 200) history.length = 200;
  store.set('history', history);
  return true;
});
ipcMain.handle('browser:clearHistory', () => { store.set('history', []); return true; });

// Shell
ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));

// App info
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
}));

// Badge
ipcMain.on('update-badge', (_e, count) => {
  if (!win) return;
  if (count > 0) {
    win.setTitle(`(${count}) Multi-Messenger Pro`);
    if (win.setOverlayIcon) {
      // We skip overlay icon for simplicity; title badge is sufficient
    }
  } else {
    win.setTitle('Multi-Messenger Pro');
  }
});

// Activity tracking for auto-lock
ipcMain.on('activity:report', () => {
  lastActivityTime = Date.now();
  resetAutoLockTimer();
});

// ─── Auto Updater ─────────────────────────────────────────────────────────────
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  autoUpdater.on('update-available', (info) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:available', {
        version: info.version,
        releaseNotes: info.releaseNotes || ''
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:not-available', {
        version: info.version
      });
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:download-progress', {
        percent: Math.round(progressObj.percent || 0),
        bytesPerSecond: progressObj.bytesPerSecond || 0,
        transferred: progressObj.transferred || 0,
        total: progressObj.total || 0
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:downloaded', {
        version: info.version
      });
    }
  });

  autoUpdater.on('error', (err) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:error', {
        message: err ? (err.message || String(err)) : 'Failed to check for updates.'
      });
    }
  });
}

// Updater IPC Handlers
ipcMain.handle('updater:check', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { success: true, updateInfo: result ? result.updateInfo : null };
  } catch (err) {
    return { success: false, error: err.message || 'Offline or update check failed.' };
  }
});

ipcMain.handle('updater:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || 'Download failed.' };
  }
});

ipcMain.handle('updater:quitAndInstall', () => {
  isQuitting = true;
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });
  return true;
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();
  resetAutoLockTimer();
  setupAutoUpdater();

  // Non-blocking background check 5 seconds after launch (fails silently if offline)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
