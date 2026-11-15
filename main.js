const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_MS = 2 * 60 * 1000;   // bakgrundsuppdatering
const MIN_GAP_MS = 30 * 1000;    // skydd mot för täta anrop (429)
// Fönstret har fast storlek och flyttas aldrig – allt rörligt animeras i HTML.
const WIN_W = 480;
const WIN_H = 420;

const LOG_PATH = path.join(__dirname, 'island.log');
function log(...a) {
  try { fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${a.join(' ')}
`); } catch {}
}

// Gemensamma värden för autostart, så posten heter "Claude Island" i Windows.
const LOGIN = { name: 'Claude Island', path: process.execPath, args: [app.getAppPath()] };

let win;
let tray = null;

/* ---------- sparade inställningar (t.ex. om ön är minimerad) ---------- */
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { minimized: false, autostartSet: false };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')) }; } catch {}
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(settings)); } catch {}
}
let lastGood = null;   // senaste lyckade svar
let lastFetch = 0;
let inflight = null;

function readCreds() {
  const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  const c = raw.claudeAiOauth;
  if (!c || !c.accessToken) throw new Error('nocreds');
  return c;
}

async function fetchUsage(force = false) {
  if (inflight) return inflight;
  if (!force && lastGood && Date.now() - lastFetch < MIN_GAP_MS) return lastGood;

  inflight = (async () => {
    lastFetch = Date.now();
    let creds;
    try {
      creds = readCreds();
    } catch {
      log('[usage] no creds');
      return { ...(lastGood || {}), error: 'nocreds' };
    }
    if (creds.expiresAt && creds.expiresAt < Date.now()) {
      log('[usage] token expired');
      return { ...(lastGood || {}), error: 'expired' };
    }
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
      });
      log('[usage]', res.status);
      if (res.status === 401) return { ...(lastGood || {}), error: 'expired' };
      if (res.status === 429) return { ...(lastGood || {}), error: 'ratelimited' };
      if (!res.ok) return { ...(lastGood || {}), error: `http ${res.status}` };
      const data = await res.json();
      lastGood = {
        data,
        plan: creds.subscriptionType || null,
        fetchedAt: Date.now(),
      };
      return lastGood;
    } catch (err) {
      log('[usage] fetch failed', err && err.message);
      return { ...(lastGood || {}), error: 'offline' };
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function push(force) {
  const payload = await fetchUsage(force);
  if (win && !win.isDestroyed()) win.webContents.send('usage', payload);
}

function placeWindow() {
  const d = screen.getPrimaryDisplay();
  const x = Math.round(d.bounds.x + (d.bounds.width - WIN_W) / 2);
  const y = d.bounds.y + 6;
  win.setBounds({ x, y, width: WIN_W, height: WIN_H });
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  placeWindow();
  win.webContents.on('console-message', (_e, level, message, line, src) => log('[renderer]', level, message, src + ':' + line));
  win.webContents.on('preload-error', (_e, p, err) => log('[preload-error]', p, err && err.stack));
  win.webContents.on('render-process-gone', (_e, d) => log('[gone]', JSON.stringify(d)));
  win.loadFile('index.html');
  win.once('ready-to-show', () => { if (!settings.minimized) win.showInactive(); });
  win.on('blur', () => win.webContents.send('collapse'));

  screen.on('display-metrics-changed', placeWindow);
  screen.on('display-added', placeWindow);
  screen.on('display-removed', placeWindow);
}

ipcMain.handle('get-usage', (_e, force) => fetchUsage(!!force));

// Genomskinliga delar släpper igenom klick; ön slår av det när musen är över den.
ipcMain.on('set-ignore', (_e, ignore) => {
  if (!win) return;
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

/* ---------- minimera till systemfältet ---------- */
function minimize() {
  if (!win) return;
  win.webContents.send('collapse');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.hide();
  settings.minimized = true;
  saveSettings();
}
function restore() {
  if (!win) return;
  placeWindow();
  win.showInactive();
  settings.minimized = false;
  saveSettings();
}
const toggleIsland = () => (win && win.isVisible() ? minimize() : restore());

function buildMenu() {
  const login = app.getLoginItemSettings({ ...LOGIN });
  const visible = win && win.isVisible();
  return Menu.buildFromTemplate([
    visible
      ? { label: 'Minimera till systemfältet', click: minimize }
      : { label: 'Visa ön', click: restore },
    { label: 'Uppdatera nu', click: () => push(true) },
    {
      label: 'Starta med Windows',
      type: 'checkbox',
      checked: login.openAtLogin,
      click: (item) =>
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          ...LOGIN,
        }),
    },
    { type: 'separator' },
    { label: 'Avsluta', click: () => app.quit() },
  ]);
}

function createTray() {
  // Tillfällig tom ikon tills renderaren har ritat siffran.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Claude-förbrukning');
  tray.on('click', toggleIsland);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

ipcMain.on('menu', () => buildMenu().popup({ window: win }));
ipcMain.on('minimize', minimize);

// Renderaren ritar siffran på en canvas (16 px och 32 px) och skickar hit den.
ipcMain.on('tray-icon', (_e, icons, tooltip) => {
  if (!tray) return;
  const img = nativeImage.createEmpty();
  for (const { scale, url } of icons) {
    const size = 16 * scale;
    img.addRepresentation({ scaleFactor: scale, width: size, height: size, dataURL: url });
  }
  tray.setImage(img);
  tray.setToolTip(tooltip);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    log('[start]', process.versions.electron);
    loadSettings();
    // Starta med Windows som standard – bara första gången, så ett manuellt val i menyn respekteras.
    if (!settings.autostartSet) {
      app.setLoginItemSettings({ openAtLogin: true, ...LOGIN });
      settings.autostartSet = true;
      saveSettings();
    }
    createWindow();
    createTray();
    setInterval(() => push(false), POLL_MS);
  });
  app.on('second-instance', restore);
  app.on('window-all-closed', () => app.quit());
}
