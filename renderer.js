/* ═══════════════════════════════════════════════════════════════════════════
   Multi-Messenger Pro — Renderer
   ═══════════════════════════════════════════════════════════════════════════ */

// Brave ships a Chrome-identical UA by design (no "Brave" token) — this mirrors
// current Brave/Chrome on Windows and is applied to every webview below.
const BRAVE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
// Back-compat alias (older code referenced `UA`).
const UA = BRAVE_UA;

// Injected into every webview so Brave-detection (navigator.brave.isBrave())
// resolves true, matching a real Brave environment.
function applyBraveEnv(wv) {
  const shim =
    "try{if(!('brave' in navigator)){Object.defineProperty(navigator,'brave',{configurable:true,enumerable:true," +
    "value:Object.freeze({isBrave:function(){return Promise.resolve(true);}})});}}catch(e){}";
  const inject = () => { try { wv.executeJavaScript(shim).catch(() => {}); } catch (e) {} };
  wv.addEventListener('dom-ready', inject);
}

// ─── Predefined Messenger Registry ────────────────────────────────────────
const MESSENGER_REGISTRY = [
  { key: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com', icon: 'https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg', status: 'available' },
  { key: 'whatsapp-biz', name: 'WhatsApp Business', url: 'https://web.whatsapp.com', icon: 'https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg', status: 'available' },
  { key: 'messenger', name: 'Messenger', url: 'https://www.messenger.com', icon: 'https://upload.wikimedia.org/wikipedia/commons/b/be/Facebook_Messenger_logo_2020.svg', status: 'available' },
  { key: 'telegram', name: 'Telegram', url: 'https://web.telegram.org', icon: 'https://upload.wikimedia.org/wikipedia/commons/8/82/Telegram_logo.svg', status: 'available' },
  { key: 'instagram', name: 'Instagram DM', url: 'https://www.instagram.com/direct/inbox/', icon: 'https://upload.wikimedia.org/wikipedia/commons/e/e7/Instagram_logo_2016.svg', status: 'available' },
  { key: 'discord', name: 'Discord', url: 'https://discord.com/app', icon: 'https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/636e0a69f118df70ad7828d4_icon_clyde_blurple_RGB.svg', status: 'available', comingSoon: true },
];

// Find the registry entry a stored app corresponds to (by hostname).
function registryForUrl(url) {
  try {
    const host = new URL(url).hostname;
    return MESSENGER_REGISTRY.find(m => {
      try { return host === new URL(m.url).hostname; } catch { return false; }
    }) || null;
  } catch { return null; }
}

// Normalise a stored app: guarantee `enabled`, and keep `comingSoon` in sync with
// the registry so a service that graduates from "Coming Soon" (e.g. Instagram)
// stops rendering the placeholder for users who added it earlier.
function normalizeApp(a) {
  const reg = registryForUrl(a.url);
  return {
    ...a,
    enabled: a.enabled !== false,
    comingSoon: reg ? !!reg.comingSoon : !!a.comingSoon,
  };
}

// ─── State ─────────────────────────────────────────────────────────────────
let myApps = [];
let settings = {};
let activePanel = 'messenger'; // messenger | browser | settings | accounts
let activeAppId = null;
let browserTabs = [];
let activeBrowserTab = null;
let bookmarks = [];
let lockFailCount = 0;
let lockTimeout = null;
let renameTargetId = null;

// ─── Init ──────────────────────────────────────────────────────────────────
async function init() {
  // Load settings
  settings = await window.api.getSettings();
  applyTheme(settings.theme);
  setAccentColor(settings.accentColor, true);
  applySettingsToUI();

  // Load apps (with migration from old localStorage)
  let apps = await window.api.getApps();
  if (apps === null) {
    // First run: migrate from localStorage
    const old = localStorage.getItem('myMessengerApps');
    if (old) {
      try {
        myApps = JSON.parse(old);
      } catch (e) {
        myApps = [{ id: 'wa_1', name: 'WhatsApp', url: 'https://web.whatsapp.com', part: 'persist:wa1', enabled: true }];
      }
    } else {
      myApps = [{ id: 'wa_1', name: 'WhatsApp', url: 'https://web.whatsapp.com', part: 'persist:wa1', enabled: true }];
    }
    // Ensure all apps have 'enabled' field
    myApps = myApps.map(normalizeApp);
    await window.api.setApps(myApps);
  } else {
    myApps = apps.map(normalizeApp);
  }

  // Load bookmarks
  bookmarks = await window.api.getBookmarks();

  // Check lock
  const pwEnabled = await window.api.isPasswordEnabled();
  if (pwEnabled) {
    showLockScreen();
  }

  // Load app info
  const info = await window.api.getAppInfo();
  document.getElementById('aboutVersion').textContent = `Version ${info.version}`;
  document.getElementById('aboutElectron').textContent = info.electronVersion;
  document.getElementById('aboutChrome').textContent = info.chromeVersion;
  document.getElementById('aboutNode').textContent = info.nodeVersion;
  document.getElementById('aboutPlatform').textContent = `${info.platform} (${info.arch})`;

  // Update password UI
  await refreshPasswordUI();

  // Render everything
  renderMessengers();
  renderAccounts();

  // Start badge polling
  startBadgePolling();

  // Window controls
  document.getElementById('btnMinimize').onclick = () => window.api.minimizeWindow();
  document.getElementById('btnMaximize').onclick = () => window.api.maximizeWindow();
  document.getElementById('btnClose').onclick = () => window.api.closeWindow();

  // Listen for auto-lock
  window.api.onLockApp(() => {
    showLockScreen();
  });

  // Activity tracking
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, () => window.api.reportActivity(), { passive: true });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);
}

// ─── Theme ─────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  let effective = theme;
  if (theme === 'system') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', effective);
}

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme('system');
});

// ─── Accent Color ──────────────────────────────────────────────────────────
function setAccentColor(color, skipSave) {
  document.documentElement.style.setProperty('--accent', color);
  // Compute hover (lighter) variant
  document.documentElement.style.setProperty('--accent-hover', adjustBrightness(color, 30));
  document.documentElement.style.setProperty('--accent-muted', color + '26');
  document.documentElement.style.setProperty('--accent-glow', color + '4d');

  // Update swatch UI
  document.querySelectorAll('.accent-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === color);
  });

  if (!skipSave) {
    settings.accentColor = color;
    window.api.setSetting('accentColor', color);
  }
}

function adjustBrightness(hex, amount) {
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  r = Math.min(255, r + amount);
  g = Math.min(255, g + amount);
  b = Math.min(255, b + amount);
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

// ─── Settings UI ───────────────────────────────────────────────────────────
function applySettingsToUI() {
  document.getElementById('settingStartup').checked = settings.startWithWindows;
  document.getElementById('settingTray').checked = settings.minimizeToTray;
  document.getElementById('settingLanguage').value = settings.language;
  document.getElementById('settingTheme').value = settings.theme;
  document.getElementById('settingCompact').checked = settings.compactMode;
  document.getElementById('settingBadges').checked = settings.showNotificationBadges;
  document.getElementById('settingDesktopNotif').checked = settings.enableDesktopNotifications;
  document.getElementById('settingSound').checked = settings.notificationSound;
  document.getElementById('settingAutoLock').checked = settings.autoLockEnabled;
  document.getElementById('settingAutoLockTime').value = settings.autoLockMinutes;
}

async function updateSetting(key, value) {
  settings[key] = value;
  await window.api.setSetting(key, value);
  showToast('Setting saved', 'success');
}

function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.settings-nav-item[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
  const sectionMap = { general: 'settingsGeneral', appearance: 'settingsAppearance', notifications: 'settingsNotifications', security: 'settingsSecurity', about: 'settingsAbout' };
  document.getElementById(sectionMap[tab]).classList.add('active');
}

async function confirmResetSettings() {
  showConfirmDialog('Reset All Settings?', 'This will reset all settings to their defaults. Your accounts and data will not be affected.', async () => {
    settings = await window.api.resetSettings();
    applyTheme(settings.theme);
    setAccentColor(settings.accentColor, true);
    applySettingsToUI();
    showToast('Settings reset to defaults', 'success');
  });
}

// ─── Panel Navigation ──────────────────────────────────────────────────────
function switchPanel(panel) {
  activePanel = panel;

  // Update sidebar active states for bottom items
  document.querySelectorAll('#sidebarBottom .sidebar-item-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#messengerList .sidebar-item-btn').forEach(b => {
    if (panel !== 'messenger') b.classList.remove('active');
  });

  if (panel === 'browser') document.querySelector('#navBrowser .sidebar-item-btn').classList.add('active');
  if (panel === 'accounts') document.querySelector('#navAccounts .sidebar-item-btn').classList.add('active');
  if (panel === 'settings') document.querySelector('#navSettings .sidebar-item-btn').classList.add('active');

  // Show/hide panels
  document.getElementById('messengerPanel').classList.toggle('active', panel === 'messenger');
  document.getElementById('browserPanel').classList.toggle('active', panel === 'browser');
  document.getElementById('settingsPanel').classList.toggle('active', panel === 'settings');
  document.getElementById('accountsPanel').classList.toggle('active', panel === 'accounts');

  // Init browser if first time
  if (panel === 'browser' && browserTabs.length === 0) {
    browserNewTab();
  }
}

// ─── Messenger Rendering ──────────────────────────────────────────────────
function getAppIcon(url) {
  const entry = MESSENGER_REGISTRY.find(m => url.includes(new URL(m.url).hostname));
  if (entry) return entry.icon;
  try {
    const domain = new URL(url).hostname;
    return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  } catch { return null; }
}

function buildComingSoonPlaceholder(app) {
  const placeholder = document.createElement('div');
  placeholder.id = `view-${app.id}`;
  placeholder.className = 'coming-soon-panel';
  placeholder.style.display = 'none';
  const iconUrl = getAppIcon(app.url);
  placeholder.innerHTML = `
    <div class="coming-soon-content">
      <div class="coming-soon-glow"></div>
      ${iconUrl ? `<div class="coming-soon-icon"><img src="${iconUrl}" alt="${app.name}"></div>` : ''}
      <h2 class="coming-soon-title">${app.name}</h2>
      <div class="coming-soon-badge">Coming Soon</div>
      <p class="coming-soon-desc">This integration is currently under development.<br>Full support will be available in a future update.</p>
      <div class="coming-soon-features">
        <div class="coming-soon-feature">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <span>Real-time messaging</span>
        </div>
        <div class="coming-soon-feature">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <span>Notification badges</span>
        </div>
        <div class="coming-soon-feature">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <span>Session persistence</span>
        </div>
      </div>
    </div>
  `;
  return placeholder;
}

function buildMessengerWebview(app) {
  const wv = document.createElement('webview');
  wv.id = `view-${app.id}`;
  wv.src = app.url;
  wv.setAttribute('partition', app.part);
  wv.setAttribute('allowpopups', '');
  // A consistent Brave/Chrome UA on every service — Instagram in particular
  // serves a broken, self-reloading login page to the default Electron UA.
  wv.setAttribute('useragent', BRAVE_UA);
  wv.style.display = 'none';
  applyBraveEnv(wv);
  return wv;
}

function renderMessengers() {
  const list = document.getElementById('messengerList');
  const panel = document.getElementById('messengerPanel');
  const emptyState = document.getElementById('messengerEmpty');

  // Sidebar rail is cheap to rebuild; panel views are NOT (rebuilding reloads
  // every webview, which is what made Instagram's QR/login re-render in a loop).
  list.innerHTML = '';

  const enabledApps = myApps.filter(a => a.enabled);
  emptyState.style.display = enabledApps.length === 0 ? 'flex' : 'none';

  // Drop panel views whose app was removed or disabled.
  const liveIds = new Set(enabledApps.map(a => a.id));
  panel.querySelectorAll('[id^="view-"]').forEach(el => {
    const id = el.id.slice('view-'.length);
    if (!liveIds.has(id)) {
      if (el.tagName === 'WEBVIEW') { try { el.src = 'about:blank'; } catch (e) {} }
      el.remove();
    }
  });

  myApps.forEach(app => {
    if (!app.enabled) return;

    // Sidebar item
    const item = document.createElement('div');
    item.className = 'sidebar-item';
    item.id = `sidebar-${app.id}`;

    const btn = document.createElement('button');
    btn.className = 'sidebar-item-btn';
    btn.setAttribute('data-tooltip', app.name);

    const iconUrl = getAppIcon(app.url);
    if (iconUrl) {
      btn.innerHTML = `<img src="${iconUrl}" alt="${app.name}">`;
    } else {
      btn.innerHTML = `<span class="initials">${app.name.substring(0, 2).toUpperCase()}</span>`;
    }

    btn.onclick = () => {
      switchPanel('messenger');
      switchApp(app.id);
    };

    // Badge
    const badge = document.createElement('div');
    badge.className = 'sidebar-badge';
    badge.id = `badge-${app.id}`;

    // Delete
    const del = document.createElement('div');
    del.className = 'delete-icon';
    del.innerHTML = '×';
    del.onclick = (e) => { e.stopPropagation(); deleteApp(app.id); };

    item.appendChild(btn);
    item.appendChild(badge);
    item.appendChild(del);
    list.appendChild(item);

    // Panel view: create once, then reuse across re-renders so the webview
    // (and any pending login/QR state) is never torn down and reloaded.
    const existing = document.getElementById(`view-${app.id}`);
    const wantWebview = !app.comingSoon;
    const haveWebview = existing && existing.tagName === 'WEBVIEW';
    if (!existing || wantWebview !== haveWebview) {
      if (existing) existing.remove();
      panel.appendChild(app.comingSoon
        ? buildComingSoonPlaceholder(app)
        : buildMessengerWebview(app));
    }
  });

  // Activate first app
  if (enabledApps.length > 0 && activePanel === 'messenger') {
    const target = activeAppId && enabledApps.find(a => a.id === activeAppId) ? activeAppId : enabledApps[0].id;
    switchApp(target);
  }
}

function switchApp(id) {
  activeAppId = id;
  activePanel = 'messenger';

  // Update sidebar
  document.querySelectorAll('#messengerList .sidebar-item-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#sidebarBottom .sidebar-item-btn').forEach(b => b.classList.remove('active'));

  const sidebarItem = document.querySelector(`#sidebar-${id} .sidebar-item-btn`);
  if (sidebarItem) sidebarItem.classList.add('active');

  // Show panels
  document.getElementById('messengerPanel').classList.add('active');
  document.getElementById('browserPanel').classList.remove('active');
  document.getElementById('settingsPanel').classList.remove('active');
  document.getElementById('accountsPanel').classList.remove('active');

  // Hide every panel view (webviews AND Coming Soon placeholders), show the one
  document.querySelectorAll('#messengerPanel [id^="view-"]').forEach(v => v.style.display = 'none');
  const target = document.getElementById(`view-${id}`);
  if (target) target.style.display = 'flex';

  document.getElementById('messengerEmpty').style.display = 'none';
}

async function deleteApp(id) {
  const app = myApps.find(a => a.id === id);
  const serviceName = app ? app.name : 'this service';

  showConfirmDialog(
    'Remove this service?',
    `This will permanently remove "${serviceName}" and its local session data from the application. This action cannot be undone.`,
    async () => {
      // Set loading state on confirm button
      const confirmBtn = document.getElementById('confirmAction');
      const cancelBtn = document.getElementById('confirmCancel');
      const originalText = confirmBtn.textContent;
      confirmBtn.textContent = 'Removing...';
      confirmBtn.disabled = true;
      confirmBtn.style.opacity = '0.6';
      confirmBtn.style.pointerEvents = 'none';
      if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.style.opacity = '0.6'; }

      try {
        // Destroy active webview for this service to release file/DB locks
        const wv = document.getElementById(`view-${id}`);
        if (wv) {
          try { wv.src = 'about:blank'; } catch(e) {}
          wv.remove();
        }

        // Call main process to fully remove service + clear its partition data
        const result = await window.api.removeService(id);

        if (result.success) {
          // Update local state to match what the main process did
          myApps = myApps.filter(a => a.id !== id);
          if (activeAppId === id) activeAppId = null;
          renderMessengers();
          renderAccounts();
          closeConfirmDialog();
          showToast('Service removed successfully.', 'success');
        } else {
          // Removal failed in main process — keep the service, show error
          console.error('[deleteApp] Main process removal failed:', result.error);
          closeConfirmDialog();
          showToast(`Failed to remove service: ${result.error}`, 'error');
        }
      } catch (err) {
        // Unexpected error — keep the service, show error
        console.error('[deleteApp] Unexpected error:', err);
        closeConfirmDialog();
        showToast('An unexpected error occurred while removing the service.', 'error');
      } finally {
        // Reset button state (in case dialog wasn't closed)
        confirmBtn.textContent = originalText;
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '';
        confirmBtn.style.pointerEvents = '';
        if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.style.opacity = ''; }
      }
    },
    'Remove Service'  // custom confirm button text
  );
}

// ─── Add Service Modal ─────────────────────────────────────────────────────
function openAddModal() {
  const list = document.getElementById('quickAddList');
  list.innerHTML = '';

  MESSENGER_REGISTRY.forEach(m => {
    const item = document.createElement('div');
    item.className = 'messenger-quick-item';

    const badgeHtml = m.comingSoon
      ? ' <span style="font-size:10px;color:var(--warning);font-weight:400;">Coming Soon</span>'
      : '';

    item.innerHTML = `
      <img src="${m.icon}" alt="${m.name}">
      <div class="mq-info">
        <div class="mq-name">${m.name}${badgeHtml}</div>
        <div class="mq-url">${m.url}</div>
      </div>
    `;

    item.onclick = () => addFromRegistry(m);
    list.appendChild(item);
  });

  document.getElementById('addModal').classList.add('active');
}

function closeAddModal() {
  document.getElementById('addModal').classList.remove('active');
  document.getElementById('customAppName').value = '';
  document.getElementById('customAppUrl').value = '';
}

async function addFromRegistry(m) {
  const id = m.key + '_' + Date.now();
  const newApp = {
    id,
    name: m.name,
    url: m.url,
    part: `persist:${id}`,
    enabled: true,
    comingSoon: m.comingSoon || false,
  };
  myApps.push(newApp);
  await window.api.setApps(myApps);
  renderMessengers();
  renderAccounts();
  closeAddModal();
  switchApp(id);
  showToast(`${m.name} added${m.comingSoon ? ' (Coming Soon)' : ''}`, 'success');
}

async function saveCustomApp() {
  const name = document.getElementById('customAppName').value.trim();
  let url = document.getElementById('customAppUrl').value.trim();

  if (!name || !url) {
    showToast('Please enter both name and URL', 'error');
    return;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    new URL(url);
  } catch {
    showToast('Invalid URL', 'error');
    return;
  }

  const id = 'app_' + Date.now();
  myApps.push({ id, name, url, part: `persist:${id}`, enabled: true });
  await window.api.setApps(myApps);
  renderMessengers();
  renderAccounts();
  closeAddModal();
  switchApp(id);
  showToast(`${name} added`, 'success');
}

// ─── Accounts Panel ────────────────────────────────────────────────────────
function renderAccounts() {
  const body = document.getElementById('accountsBody');
  body.innerHTML = '';

  if (myApps.length === 0) {
    body.innerHTML = `
      <div class="empty-state" style="height:100%">
        <div class="empty-state-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
          </svg>
        </div>
        <h3>No accounts yet</h3>
        <p>Add a messaging service to get started.</p>
      </div>
    `;
    return;
  }

  myApps.forEach(app => {
    const card = document.createElement('div');
    card.className = 'account-card';

    const iconUrl = getAppIcon(app.url);
    const iconHtml = iconUrl
      ? `<img src="${iconUrl}" alt="${app.name}">`
      : `<span style="font-weight:700;color:var(--text-secondary)">${app.name.substring(0, 2).toUpperCase()}</span>`;

    card.innerHTML = `
      <div class="account-icon">${iconHtml}</div>
      <div class="account-info">
        <div class="account-name">${app.name}</div>
        <div class="account-url">${app.url}</div>
      </div>
      <div class="account-status">
        <span class="dot ${app.enabled ? 'online' : 'offline'}"></span>
        <span style="color:var(--text-secondary)">${app.enabled ? 'Active' : 'Disabled'}</span>
      </div>
      <div class="account-actions">
        <button class="account-action-btn" title="Rename" onclick="openRenameModal('${app.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="account-action-btn" title="${app.enabled ? 'Disable' : 'Enable'}" onclick="toggleAppEnabled('${app.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${app.enabled ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>' : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'}</svg>
        </button>
        <button class="account-action-btn danger" title="Remove" onclick="deleteApp('${app.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;

    body.appendChild(card);
  });
}

async function toggleAppEnabled(id) {
  const app = myApps.find(a => a.id === id);
  if (app) {
    app.enabled = !app.enabled;
    await window.api.setApps(myApps);
    renderMessengers();
    renderAccounts();
    showToast(`${app.name} ${app.enabled ? 'enabled' : 'disabled'}`, 'info');
  }
}

function openRenameModal(id) {
  renameTargetId = id;
  const app = myApps.find(a => a.id === id);
  document.getElementById('renameInput').value = app ? app.name : '';
  document.getElementById('renameModal').classList.add('active');
}

function closeRenameModal() {
  document.getElementById('renameModal').classList.remove('active');
  renameTargetId = null;
}

async function handleRename() {
  const newName = document.getElementById('renameInput').value.trim();
  if (!newName) { showToast('Name cannot be empty', 'error'); return; }
  const app = myApps.find(a => a.id === renameTargetId);
  if (app) {
    app.name = newName;
    await window.api.setApps(myApps);
    renderMessengers();
    renderAccounts();
    showToast('Account renamed', 'success');
  }
  closeRenameModal();
}

// ─── Badge Polling ─────────────────────────────────────────────────────────
function startBadgePolling() {
  setInterval(() => {
    if (!settings.showNotificationBadges) return;
    let total = 0;

    myApps.forEach(app => {
      if (!app.enabled) return;
      const wv = document.getElementById(`view-${app.id}`);
      const badge = document.getElementById(`badge-${app.id}`);
      if (wv && badge) {
        try {
          const title = wv.getTitle();
          const match = title.match(/\((\d+)\)/);
          if (match) {
            const count = parseInt(match[1]);
            badge.innerText = count > 99 ? '99+' : count;
            badge.classList.add('visible');
            total += count;
          } else {
            badge.classList.remove('visible');
          }
        } catch (e) { /* webview not ready */ }
      }
    });

    window.api.updateBadge(total);
  }, settings.badgePollInterval || 2000);
}

// ─── Lock Screen ───────────────────────────────────────────────────────────
function showLockScreen() {
  document.getElementById('lockScreen').classList.remove('hidden');
  document.getElementById('lockPasswordInput').value = '';
  document.getElementById('lockError').textContent = '';
  document.getElementById('lockPasswordInput').focus();
  lockFailCount = 0;
}

function hideLockScreen() {
  document.getElementById('lockScreen').classList.add('hidden');
}

async function handleUnlock() {
  const pw = document.getElementById('lockPasswordInput').value;
  if (!pw) return;

  if (lockTimeout) {
    document.getElementById('lockError').textContent = 'Please wait before trying again.';
    return;
  }

  const valid = await window.api.verifyPassword(pw);
  if (valid) {
    hideLockScreen();
    lockFailCount = 0;
    showToast('Unlocked', 'success');
  } else {
    lockFailCount++;
    document.getElementById('lockError').textContent = 'Incorrect password';
    document.getElementById('lockPasswordInput').value = '';
    document.getElementById('lockPasswordInput').focus();

    if (lockFailCount >= 5) {
      const delay = Math.min(30, 5 * (lockFailCount - 4));
      document.getElementById('lockAttempts').textContent = `Too many attempts. Wait ${delay}s.`;
      lockTimeout = setTimeout(() => {
        lockTimeout = null;
        document.getElementById('lockAttempts').textContent = '';
      }, delay * 1000);
    }
  }
}

// Toggle password visibility
document.getElementById('lockTogglePw').onclick = () => {
  const input = document.getElementById('lockPasswordInput');
  input.type = input.type === 'password' ? 'text' : 'password';
};

// Enter key on lock screen
document.getElementById('lockPasswordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleUnlock();
});

// ─── Password Management ──────────────────────────────────────────────────
async function refreshPasswordUI() {
  const enabled = await window.api.isPasswordEnabled();
  const btn = document.getElementById('passwordToggleBtn');
  const changeRow = document.getElementById('changePasswordRow');
  const autoLockRow = document.getElementById('autoLockRow');
  const autoLockTimeRow = document.getElementById('autoLockTimeRow');

  if (enabled) {
    btn.textContent = 'Disable';
    btn.className = 'settings-btn danger';
    changeRow.style.display = 'flex';
    autoLockRow.style.display = 'flex';
    autoLockTimeRow.style.display = 'flex';
  } else {
    btn.textContent = 'Enable';
    btn.className = 'settings-btn primary';
    changeRow.style.display = 'none';
    autoLockRow.style.display = 'none';
    autoLockTimeRow.style.display = 'none';
  }
}

async function togglePasswordProtection() {
  const enabled = await window.api.isPasswordEnabled();
  if (enabled) {
    // Show remove password modal
    document.getElementById('rpwCurrent').value = '';
    document.getElementById('rpwError').textContent = '';
    document.getElementById('removePasswordModal').classList.add('active');
  } else {
    // Show set password modal
    document.getElementById('passwordModalTitle').textContent = 'Set App Password';
    document.getElementById('pwCurrentField').style.display = 'none';
    document.getElementById('pwNew').value = '';
    document.getElementById('pwConfirm').value = '';
    document.getElementById('pwError').textContent = '';
    document.getElementById('pwNewLabel').textContent = 'New Password';
    document.getElementById('pwSubmitBtn').textContent = 'Set Password';
    document.getElementById('passwordModal').classList.add('active');
    document.getElementById('passwordModal').dataset.mode = 'set';
  }
}

function showChangePasswordModal() {
  document.getElementById('passwordModalTitle').textContent = 'Change Password';
  document.getElementById('pwCurrentField').style.display = 'block';
  document.getElementById('pwCurrent').value = '';
  document.getElementById('pwNew').value = '';
  document.getElementById('pwConfirm').value = '';
  document.getElementById('pwError').textContent = '';
  document.getElementById('pwNewLabel').textContent = 'New Password';
  document.getElementById('pwSubmitBtn').textContent = 'Change Password';
  document.getElementById('passwordModal').classList.add('active');
  document.getElementById('passwordModal').dataset.mode = 'change';
}

function closePasswordModal() {
  document.getElementById('passwordModal').classList.remove('active');
}

async function handlePasswordSubmit() {
  const mode = document.getElementById('passwordModal').dataset.mode;
  const newPw = document.getElementById('pwNew').value;
  const confirm = document.getElementById('pwConfirm').value;
  const errEl = document.getElementById('pwError');

  if (newPw.length < 4) { errEl.textContent = 'Password must be at least 4 characters'; return; }
  if (newPw !== confirm) { errEl.textContent = 'Passwords do not match'; return; }

  if (mode === 'set') {
    await window.api.setPassword(newPw);
    await refreshPasswordUI();
    closePasswordModal();
    showToast('Password protection enabled', 'success');
  } else if (mode === 'change') {
    const oldPw = document.getElementById('pwCurrent').value;
    const result = await window.api.changePassword(oldPw, newPw);
    if (result.success) {
      await refreshPasswordUI();
      closePasswordModal();
      showToast('Password changed', 'success');
    } else {
      errEl.textContent = result.error || 'Failed to change password';
    }
  }
}

function closeRemovePasswordModal() {
  document.getElementById('removePasswordModal').classList.remove('active');
}

async function handleRemovePassword() {
  const pw = document.getElementById('rpwCurrent').value;
  const result = await window.api.removePassword(pw);
  if (result.success) {
    await refreshPasswordUI();
    closeRemovePasswordModal();
    showToast('Password protection removed', 'success');
  } else {
    document.getElementById('rpwError').textContent = result.error || 'Invalid password';
  }
}

// ─── Browser ───────────────────────────────────────────────────────────────
let browserTabIdCounter = 0;

function browserNewTab(url) {
  const tabId = 'btab_' + (++browserTabIdCounter);
  const tab = { id: tabId, url: url || '', title: 'New Tab' };
  browserTabs.push(tab);
  renderBrowserTabs();
  switchBrowserTab(tabId);

  if (url) {
    createBrowserWebview(tabId, url);
  } else {
    showNewTabPage(tabId);
  }
}

function renderBrowserTabs() {
  const container = document.getElementById('browserTabs');
  // Keep the new tab button
  const newTabBtn = document.getElementById('browserNewTab');
  container.innerHTML = '';

  browserTabs.forEach(tab => {
    const el = document.createElement('button');
    el.className = 'browser-tab' + (tab.id === activeBrowserTab ? ' active' : '');
    el.onclick = () => switchBrowserTab(tab.id);
    el.innerHTML = `
      <span class="browser-tab-title">${escapeHtml(tab.title)}</span>
      <span class="browser-tab-close" onclick="event.stopPropagation();closeBrowserTab('${tab.id}')">&times;</span>
    `;
    container.appendChild(el);
  });

  container.appendChild(newTabBtn);
}

function switchBrowserTab(tabId) {
  activeBrowserTab = tabId;

  // Update tab UI
  document.querySelectorAll('.browser-tab').forEach(t => t.classList.remove('active'));

  // Update content visibility
  const content = document.getElementById('browserContent');
  Array.from(content.children).forEach(c => c.style.display = 'none');

  const tabContent = document.getElementById(`browser-content-${tabId}`);
  if (tabContent) tabContent.style.display = 'flex';

  // Update URL bar
  const tab = browserTabs.find(t => t.id === tabId);
  document.getElementById('browserUrlBar').value = tab && tab.url ? tab.url : '';

  renderBrowserTabs();
}

function closeBrowserTab(tabId) {
  browserTabs = browserTabs.filter(t => t.id !== tabId);
  const content = document.getElementById(`browser-content-${tabId}`);
  if (content) content.remove();

  if (browserTabs.length === 0) {
    browserNewTab();
  } else if (activeBrowserTab === tabId) {
    switchBrowserTab(browserTabs[browserTabs.length - 1].id);
  } else {
    renderBrowserTabs();
  }
}

function showNewTabPage(tabId) {
  const content = document.getElementById('browserContent');

  // Remove existing content for this tab
  const existing = document.getElementById(`browser-content-${tabId}`);
  if (existing) existing.remove();

  const page = document.createElement('div');
  page.id = `browser-content-${tabId}`;
  page.className = 'new-tab-page';
  page.style.display = 'flex';

  let bmHtml = '';
  bookmarks.forEach(bm => {
    const domain = (() => { try { return new URL(bm.url).hostname; } catch { return ''; } })();
    bmHtml += `
      <div class="bookmark-card" onclick="browserNavigateTab('${tabId}', '${bm.url}')">
        <div class="bookmark-icon">
          <img src="https://icons.duckduckgo.com/ip3/${domain}.ico" onerror="this.style.display='none'">
        </div>
        <div class="bookmark-label">${escapeHtml(bm.title)}</div>
      </div>
    `;
  });

  page.innerHTML = `
    <h2>New Tab</h2>
    <div class="bookmarks-grid">${bmHtml}</div>
  `;

  content.appendChild(page);
}

function createBrowserWebview(tabId, url) {
  const content = document.getElementById('browserContent');

  // Remove existing content for this tab
  const existing = document.getElementById(`browser-content-${tabId}`);
  if (existing) existing.remove();

  const wrapper = document.createElement('div');
  wrapper.id = `browser-content-${tabId}`;
  wrapper.style.display = 'flex';
  wrapper.style.flex = '1';
  wrapper.style.minWidth = '0';
  wrapper.style.minHeight = '0';
  wrapper.style.position = 'relative';

  const wv = document.createElement('webview');
  wv.src = url;
  wv.setAttribute('partition', 'persist:browser');
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('useragent', BRAVE_UA);
  wv.style.width = '100%';
  wv.style.height = '100%';
  wv.id = `browser-wv-${tabId}`;
  applyBraveEnv(wv);

  wv.addEventListener('did-navigate', (e) => {
    const tab = browserTabs.find(t => t.id === tabId);
    if (tab) {
      tab.url = e.url;
      if (tabId === activeBrowserTab) {
        document.getElementById('browserUrlBar').value = e.url;
      }
    }
    // Add to history
    window.api.addHistory({ url: e.url, title: tab ? tab.title : '' });
  });

  wv.addEventListener('page-title-updated', (e) => {
    const tab = browserTabs.find(t => t.id === tabId);
    if (tab) {
      tab.title = e.title;
      renderBrowserTabs();
    }
  });

  wv.addEventListener('did-navigate-in-page', (e) => {
    const tab = browserTabs.find(t => t.id === tabId);
    if (tab && e.isMainFrame) {
      tab.url = e.url;
      if (tabId === activeBrowserTab) {
        document.getElementById('browserUrlBar').value = e.url;
      }
    }
  });

  wrapper.appendChild(wv);
  content.appendChild(wrapper);
}

function browserNavigateTab(tabId, url) {
  const tab = browserTabs.find(t => t.id === tabId);
  if (tab) tab.url = url;
  createBrowserWebview(tabId, url);
  if (tabId === activeBrowserTab) {
    document.getElementById('browserUrlBar').value = url;
  }
}

function browserNavigate() {
  let url = document.getElementById('browserUrlBar').value.trim();
  if (!url) return;

  // If no protocol, check if it looks like a URL or a search
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (url.includes('.') && !url.includes(' ')) {
      url = 'https://' + url;
    } else {
      url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
    }
  }

  const tab = browserTabs.find(t => t.id === activeBrowserTab);
  if (tab) tab.url = url;
  createBrowserWebview(activeBrowserTab, url);
  document.getElementById('browserUrlBar').value = url;
}

function browserGoBack() {
  const wv = document.getElementById(`browser-wv-${activeBrowserTab}`);
  if (wv && wv.canGoBack()) wv.goBack();
}

function browserGoForward() {
  const wv = document.getElementById(`browser-wv-${activeBrowserTab}`);
  if (wv && wv.canGoForward()) wv.goForward();
}

function browserReload() {
  const wv = document.getElementById(`browser-wv-${activeBrowserTab}`);
  if (wv) wv.reload();
}

function browserGoHome() {
  showNewTabPage(activeBrowserTab);
  const tab = browserTabs.find(t => t.id === activeBrowserTab);
  if (tab) { tab.url = ''; tab.title = 'New Tab'; }
  document.getElementById('browserUrlBar').value = '';
  renderBrowserTabs();
}

async function browserToggleBookmark() {
  const tab = browserTabs.find(t => t.id === activeBrowserTab);
  if (!tab || !tab.url) { showToast('No page to bookmark', 'info'); return; }

  const idx = bookmarks.findIndex(b => b.url === tab.url);
  if (idx >= 0) {
    bookmarks.splice(idx, 1);
    showToast('Bookmark removed', 'info');
  } else {
    bookmarks.push({ id: 'bm_' + Date.now(), title: tab.title || tab.url, url: tab.url, icon: '' });
    showToast('Bookmark added', 'success');
  }
  await window.api.setBookmarks(bookmarks);
}

async function browserOpenExternal() {
  const tab = browserTabs.find(t => t.id === activeBrowserTab);
  if (tab && tab.url) {
    await window.api.openExternal(tab.url);
  }
}

// ─── Clear Browsing Data ──────────────────────────────────────────────────
async function clearBrowsingData() {
  showConfirmDialog('Clear Browsing Data?', 'This will remove all browser history and bookmarks. Messenger data will not be affected.', async () => {
    await window.api.clearHistory();
    bookmarks = [];
    await window.api.setBookmarks(bookmarks);
    showToast('Browsing data cleared', 'success');
  });
}

// ─── Confirm Dialog ────────────────────────────────────────────────────────
let confirmCallback = null;

function showConfirmDialog(title, message, onConfirm, confirmBtnText) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  const actionBtn = document.getElementById('confirmAction');
  actionBtn.textContent = confirmBtnText || 'Confirm';
  confirmCallback = onConfirm;
  actionBtn.onclick = () => {
    // Don't close here — the callback controls closing (supports async loading state)
    if (confirmCallback) confirmCallback();
  };
  document.getElementById('confirmDialog').classList.add('active');
}

function closeConfirmDialog() {
  document.getElementById('confirmDialog').classList.remove('active');
  confirmCallback = null;
  // Reset button state in case it was left in loading state
  const actionBtn = document.getElementById('confirmAction');
  actionBtn.disabled = false;
  actionBtn.style.opacity = '';
  actionBtn.style.pointerEvents = '';
  const cancelBtn = document.getElementById('confirmCancel');
  if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.style.opacity = ''; }
}

// ─── Toast ─────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ─── Keyboard Shortcuts ────────────────────────────────────────────────────
function handleKeyboard(e) {
  // Ctrl+1-9: switch messenger
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    const enabledApps = myApps.filter(a => a.enabled);
    if (enabledApps[idx]) {
      switchPanel('messenger');
      switchApp(enabledApps[idx].id);
    }
  }

  // Ctrl+T: new browser tab
  if (e.ctrlKey && e.key === 't') {
    e.preventDefault();
    switchPanel('browser');
    browserNewTab();
  }

  // Ctrl+W: close browser tab
  if (e.ctrlKey && e.key === 'w' && activePanel === 'browser') {
    e.preventDefault();
    if (activeBrowserTab) closeBrowserTab(activeBrowserTab);
  }

  // Ctrl+L: focus URL bar
  if (e.ctrlKey && e.key === 'l' && activePanel === 'browser') {
    e.preventDefault();
    document.getElementById('browserUrlBar').focus();
    document.getElementById('browserUrlBar').select();
  }

  // Ctrl+,: open settings
  if (e.ctrlKey && e.key === ',') {
    e.preventDefault();
    switchPanel('settings');
  }

  // Escape: close modals
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Auto Updater Subsystem ────────────────────────────────────────────────
let pendingUpdateInfo = null;
let isDownloadingUpdate = false;
let isManualUpdateCheck = false;
let currentAppVersion = '2.0.0';

function initAutoUpdater() {
  window.api.getAppInfo().then(info => {
    if (info && info.version) {
      currentAppVersion = info.version;
      const currentVerEl = document.getElementById('updateCurrentVer');
      if (currentVerEl) currentVerEl.textContent = currentAppVersion;
    }
  }).catch(() => {});

  window.api.onUpdateAvailable((info) => {
    pendingUpdateInfo = info;
    const newVer = info.version || 'New Version';

    // Update modal
    document.getElementById('updateCurrentVer').textContent = currentAppVersion;
    document.getElementById('updateNewVer').textContent = newVer;
    document.getElementById('updateModalTitle').textContent = 'New Update Available';
    document.getElementById('updateModalSubtitle').textContent = `Multi-Messenger Pro ${newVer} is now available.`;
    document.getElementById('modalProgressWrap').style.display = 'none';
    document.getElementById('modalProgressMetaWrap').style.display = 'none';
    document.getElementById('updateModalActions').innerHTML = `
      <button class="modal-btn secondary" id="btnUpdateLater" onclick="closeUpdateModal()">Later</button>
      <button class="modal-btn primary" id="btnUpdateNow" onclick="handleStartDownload()">Update Now</button>
    `;
    document.getElementById('updateModal').classList.add('active');

    // Update Settings > About card
    const details = document.getElementById('aboutUpdateDetails');
    const statusText = document.getElementById('aboutUpdateStatusText');
    const actions = document.getElementById('aboutUpdateActions');
    details.style.display = 'block';
    statusText.textContent = `A new version (${newVer}) is available.`;
    statusText.style.color = 'var(--accent)';
    actions.innerHTML = `
      <button class="settings-btn primary" onclick="handleStartDownload()">Update Now</button>
    `;
    document.getElementById('btnCheckUpdates').style.display = 'none';
  });

  window.api.onUpdateNotAvailable(() => {
    if (isManualUpdateCheck) {
      const details = document.getElementById('aboutUpdateDetails');
      const statusText = document.getElementById('aboutUpdateStatusText');
      details.style.display = 'block';
      statusText.textContent = "You're up to date. You are using the latest version.";
      statusText.style.color = 'var(--success)';
      document.getElementById('aboutProgressWrap').style.display = 'none';
      document.getElementById('aboutProgressMetaWrap').style.display = 'none';
      document.getElementById('aboutUpdateActions').innerHTML = '';
      document.getElementById('btnCheckUpdates').textContent = 'Check for Updates';
      document.getElementById('btnCheckUpdates').disabled = false;
      showToast("You're up to date.", 'info');
      isManualUpdateCheck = false;
    }
  });

  window.api.onDownloadProgress((progress) => {
    isDownloadingUpdate = true;
    const pct = progress.percent || 0;
    const speed = formatBytes(progress.bytesPerSecond) + '/s';
    const transferred = formatBytes(progress.transferred);
    const total = formatBytes(progress.total);
    const meta = `${transferred} / ${total} (${pct}%)`;

    // Modal progress UI
    document.getElementById('modalProgressWrap').style.display = 'block';
    document.getElementById('modalProgressMetaWrap').style.display = 'flex';
    document.getElementById('modalProgressBar').style.width = `${pct}%`;
    document.getElementById('modalProgressMeta').textContent = meta;
    document.getElementById('modalProgressSpeed').textContent = speed;

    // Settings progress UI
    document.getElementById('aboutProgressWrap').style.display = 'block';
    document.getElementById('aboutProgressMetaWrap').style.display = 'flex';
    document.getElementById('aboutProgressBar').style.width = `${pct}%`;
    document.getElementById('aboutProgressMeta').textContent = meta;
    document.getElementById('aboutProgressSpeed').textContent = speed;
    document.getElementById('aboutUpdateStatusText').textContent = `Downloading update... ${pct}%`;
  });

  window.api.onUpdateDownloaded((info) => {
    isDownloadingUpdate = false;
    const ver = info.version || (pendingUpdateInfo ? pendingUpdateInfo.version : '');

    // Modal UI
    document.getElementById('updateModalTitle').textContent = 'Update Ready';
    document.getElementById('updateModalSubtitle').textContent = 'The new version has been downloaded and is ready to install.';
    document.getElementById('modalProgressWrap').style.display = 'none';
    document.getElementById('modalProgressMetaWrap').style.display = 'none';
    document.getElementById('updateModalActions').innerHTML = `
      <button class="modal-btn primary" onclick="handleQuitAndInstall()">Restart and Install</button>
    `;
    document.getElementById('updateModal').classList.add('active');

    // Settings UI
    const details = document.getElementById('aboutUpdateDetails');
    const statusText = document.getElementById('aboutUpdateStatusText');
    const actions = document.getElementById('aboutUpdateActions');
    details.style.display = 'block';
    statusText.textContent = `Update ready to install (${ver}).`;
    statusText.style.color = 'var(--success)';
    document.getElementById('aboutProgressWrap').style.display = 'none';
    document.getElementById('aboutProgressMetaWrap').style.display = 'none';
    actions.innerHTML = `
      <button class="settings-btn primary" onclick="handleQuitAndInstall()">Restart and Install</button>
    `;
    showToast('Update ready to install.', 'success');
  });

  window.api.onUpdateError((err) => {
    isDownloadingUpdate = false;
    if (isManualUpdateCheck) {
      const details = document.getElementById('aboutUpdateDetails');
      const statusText = document.getElementById('aboutUpdateStatusText');
      details.style.display = 'block';
      statusText.textContent = err && err.message ? `Update check failed: ${err.message}` : 'Failed to check for updates.';
      statusText.style.color = 'var(--text-tertiary)';
      document.getElementById('btnCheckUpdates').textContent = 'Check for Updates';
      document.getElementById('btnCheckUpdates').disabled = false;
      isManualUpdateCheck = false;
    }
  });
}

async function handleCheckForUpdates() {
  isManualUpdateCheck = true;
  const btn = document.getElementById('btnCheckUpdates');
  btn.textContent = 'Checking...';
  btn.disabled = true;

  const details = document.getElementById('aboutUpdateDetails');
  const statusText = document.getElementById('aboutUpdateStatusText');
  details.style.display = 'block';
  statusText.textContent = 'Checking GitHub Releases for updates...';
  statusText.style.color = 'var(--text-secondary)';

  const res = await window.api.checkForUpdates();
  if (!res.success) {
    statusText.textContent = 'Unable to connect to update server. Check your internet connection.';
    statusText.style.color = 'var(--text-tertiary)';
    btn.textContent = 'Check for Updates';
    btn.disabled = false;
    isManualUpdateCheck = false;
  }
}

async function handleStartDownload() {
  const modalActions = document.getElementById('updateModalActions');
  if (modalActions) {
    modalActions.innerHTML = `<span style="font-size:13px;color:var(--text-secondary);">Downloading update...</span>`;
  }
  const aboutActions = document.getElementById('aboutUpdateActions');
  if (aboutActions) {
    aboutActions.innerHTML = `<span style="font-size:13px;color:var(--text-secondary);">Downloading update...</span>`;
  }
  const res = await window.api.downloadUpdate();
  if (!res.success) {
    showToast(`Failed to start download: ${res.error}`, 'error');
  }
}

function handleQuitAndInstall() {
  window.api.quitAndInstallUpdate();
}

function closeUpdateModal() {
  document.getElementById('updateModal').classList.remove('active');
}

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Initialize updater logic
initAutoUpdater();

// ─── Start ─────────────────────────────────────────────────────────────────
init();
