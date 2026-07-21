const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Window Controls ──
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChange: (cb) => {
    const handler = (_e, val) => cb(val);
    ipcRenderer.on('window:maximizeChanged', handler);
    return () => ipcRenderer.removeListener('window:maximizeChanged', handler);
  },

  // ── Settings ──
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  // ── Apps / Accounts ──
  getApps: () => ipcRenderer.invoke('apps:get'),
  setApps: (apps) => ipcRenderer.invoke('apps:set', apps),
  removeService: (appId) => ipcRenderer.invoke('apps:removeService', appId),

  // ── Password / Lock ──
  isPasswordEnabled: () => ipcRenderer.invoke('password:isEnabled'),
  setPassword: (password) => ipcRenderer.invoke('password:set', password),
  verifyPassword: (password) => ipcRenderer.invoke('password:verify', password),
  changePassword: (oldPw, newPw) => ipcRenderer.invoke('password:change', oldPw, newPw),
  removePassword: (password) => ipcRenderer.invoke('password:remove', password),
  onLockApp: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:lock', handler);
    return () => ipcRenderer.removeListener('app:lock', handler);
  },

  // ── Browser Bookmarks & History ──
  getBookmarks: () => ipcRenderer.invoke('browser:getBookmarks'),
  setBookmarks: (bm) => ipcRenderer.invoke('browser:setBookmarks', bm),
  getHistory: () => ipcRenderer.invoke('browser:getHistory'),
  addHistory: (entry) => ipcRenderer.invoke('browser:addHistory', entry),
  clearHistory: () => ipcRenderer.invoke('browser:clearHistory'),

  // ── Tray / Badge ──
  updateBadge: (count) => ipcRenderer.send('update-badge', count),

  // ── Shell ──
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ── App Info ──
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  // ── Activity ──
  reportActivity: () => ipcRenderer.send('activity:report'),

  // ── Auto Updater ──
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  quitAndInstallUpdate: () => ipcRenderer.invoke('updater:quitAndInstall'),
  onUpdateAvailable: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },
  onUpdateNotAvailable: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('update:not-available', handler);
    return () => ipcRenderer.removeListener('update:not-available', handler);
  },
  onDownloadProgress: (cb) => {
    const handler = (_e, progress) => cb(progress);
    ipcRenderer.on('update:download-progress', handler);
    return () => ipcRenderer.removeListener('update:download-progress', handler);
  },
  onUpdateDownloaded: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('update:downloaded', handler);
    return () => ipcRenderer.removeListener('update:downloaded', handler);
  },
  onUpdateError: (cb) => {
    const handler = (_e, err) => cb(err);
    ipcRenderer.on('update:error', handler);
    return () => ipcRenderer.removeListener('update:error', handler);
  },
});
