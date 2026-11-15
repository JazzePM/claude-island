const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_MS = 2 * 60 * 1000;   // bakgrundsuppdatering
const MIN_GAP_MS = 30 * 1000;    // skydd mot för täta anrop (429)
// Fönstret har fast storlek och flyttas aldrig – allt rörligt animeras i HTML.
const WIN_W = 820; // plats för projektdockan till höger om ön
const WIN_H = 420;

// Installerad app ligger i en skrivskyddad asar-fil, så loggen hamnar i användarmappen.
const LOG_PATH = app.isPackaged
  ? path.join(app.getPath('userData'), 'island.log')
  : path.join(__dirname, 'island.log');
function log(...a) {
  try { fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${a.join(' ')}
`); } catch {}
}

// Gemensamma värden för autostart, så posten heter "Claude Island" i Windows.
// Installerad: starta exe-filen direkt. Utvecklingsläge: electron.exe + projektmappen.
const LOGIN = {
  name: 'Claude Island',
  path: process.execPath,
  args: app.isPackaged ? [] : [app.getAppPath()],
};

let win;
let tray = null;

/* ---------- sparade inställningar (t.ex. om ön är minimerad) ---------- */
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { minimized: false, autostartSet: false, detached: false, pos: null };
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
  // Lossad ö: använd sparad plats, om den fortfarande ligger på någon skärm.
  if (settings.detached && settings.pos) {
    const { x, y } = settings.pos;
    const islandPoint = { x: x + Math.round(WIN_W / 2), y: y + 18 };
    const onScreen = screen.getAllDisplays().some((d) => {
      const b = d.bounds;
      return islandPoint.x >= b.x && islandPoint.x < b.x + b.width && islandPoint.y >= b.y && islandPoint.y < b.y + b.height;
    });
    if (onScreen) {
      win.setBounds({ x, y, width: WIN_W, height: WIN_H });
      return;
    }
  }
  const d = screen.getPrimaryDisplay();
  const x = Math.round(d.bounds.x + (d.bounds.width - WIN_W) / 2);
  const y = d.bounds.y + 6;
  win.setBounds({ x, y, width: WIN_W, height: WIN_H });
}

/* ---------- lossa ön och flytta den ---------- */
function setDetached(on) {
  settings.detached = on;
  if (!on) settings.pos = null;
  saveSettings();
  placeWindow();
  if (win) win.webContents.send('detached', on);
}
ipcMain.on('drag-by', (_e, dx, dy) => {
  if (!win || !settings.detached) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});
ipcMain.on('drag-end', () => {
  if (!win || !settings.detached) return;
  const [x, y] = win.getPosition();
  settings.pos = { x, y };
  saveSettings();
});
ipcMain.handle('is-detached', () => !!settings.detached);

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
  win.webContents.on('console-message', (_e, level, message, line, src) => log('[renderer]', level, String(message).slice(0, 300), src + ':' + line));
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
    settings.detached
      ? { label: 'Fäst överst i mitten', click: () => setDetached(false) }
      : { label: 'Lossa ön (dra för att flytta)', click: () => setDetached(true) },
    { type: 'separator' },
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

/* ================= projekt =================
   Projekt = undermappar i ~/Projects med .git, package.json eller pubspec.yaml. */
const PROJECTS_ROOT = path.join(os.homedir(), 'Projects');
const ICON_CANDIDATES = [
  'src/app/icon.svg', 'src/app/icon.png', 'app/icon.svg', 'app/icon.png',
  'src/app/apple-icon.png', 'app/apple-icon.png',
  'public/favicon.svg', 'public/icon.svg', 'public/icon.png', 'public/favicon.png',
  'src/app/favicon.ico', 'app/favicon.ico', 'public/favicon.ico',
  'web/favicon.png', 'assets/icon/icon.png', 'assets/icons/icon.png', 'assets/icons/logo.png',
  'assets/images/logo.png', 'app/assets/icon/icon.png', 'app/assets/icons/logo.png',
  'build/icon.png', 'windows/runner/resources/app_icon.ico',
];
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

function findIcon(dir) {
  for (const rel of ICON_CANDIDATES) {
    const f = path.join(dir, rel);
    const mime = MIME[path.extname(f).toLowerCase()];
    if (!mime || !exists(f)) continue;
    try {
      if (fs.statSync(f).size > 2 * 1024 * 1024) continue;
      return `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`;
    } catch {}
  }
  return null;
}

// Typ av projekt, för att särskilja projekt med samma ikon (t.ex. webb vs app).
function detectKind(dir) {
  const flutter = exists(path.join(dir, 'pubspec.yaml')) ||
    ['app', 'mobile'].some((s) => exists(path.join(dir, s, 'pubspec.yaml')));
  if (flutter) return 'app';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.electron) return 'desktop';
    if (['next', 'react', 'vite', 'vue', 'svelte', 'astro', 'nuxt'].some((d) => deps[d])) return 'web';
    return 'node';
  } catch {}
  return null;
}

function activity(dir) {
  for (const f of ['.git/index', '.git/HEAD']) {
    try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
  }
  try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
}

let projectCache = null, projectCacheAt = 0;
function listProjects() {
  if (projectCache && Date.now() - projectCacheAt < 60 * 1000) return projectCache;
  let entries = [];
  try { entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }); } catch { return []; }
  projectCache = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(PROJECTS_ROOT, e.name))
    .filter((d) => ['.git', 'package.json', 'pubspec.yaml'].some((f) => exists(path.join(d, f))))
    .map((d) => ({
      name: path.basename(d).replace(/[-_]+/g, ' '),
      path: d,
      icon: findIcon(d),
      kind: detectKind(d),
      activity: activity(d),
    }))
    .sort((a, b) => b.activity - a.activity)
    .slice(0, 10);
  projectCacheAt = Date.now();
  return projectCache;
}

// Lägger en VS Code-uppgift som startar Claude Code när mappen öppnas.
// Filen hålls utanför git via .git/info/exclude (påverkar inte repot).
const CLAUDE_TASK = {
  version: '2.0.0',
  tasks: [{
    label: 'Claude Code',
    type: 'shell',
    command: 'claude',
    runOptions: { runOn: 'folderOpen' },
    presentation: { reveal: 'always', panel: 'dedicated', focus: true, clear: true },
    problemMatcher: [],
  }],
};
function ensureClaudeTask(dir) {
  const vsdir = path.join(dir, '.vscode');
  const file = path.join(vsdir, 'tasks.json');
  if (exists(file)) return; // rör aldrig en befintlig tasks.json
  try {
    fs.mkdirSync(vsdir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(CLAUDE_TASK, null, 2) + '\n');
    const exclude = path.join(dir, '.git', 'info', 'exclude');
    if (exists(path.join(dir, '.git'))) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      const cur = exists(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!cur.split(/\r?\n/).includes('.vscode/tasks.json')) {
        const sep = cur && !cur.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(exclude, sep + '# Claude Island\n.vscode/tasks.json\n');
      }
    }
  } catch (err) {
    log('[project] kunde inte skapa tasks.json', err && err.message);
  }
}

function findVSCode() {
  const c = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
  ];
  return c.find(exists) || null;
}

function openProject(dir) {
  // Öppna bara mappar som faktiskt finns i projektlistan.
  const p = listProjects().find((x) => x.path === dir);
  if (!p) return false;
  const code = findVSCode();
  if (!code) { log('[project] hittar inte VS Code'); return false; }
  ensureClaudeTask(p.path);
  // Rensa Electron-variabler så att VS Code (också Electron) inte påverkas av vår miljö.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ELECTRON_')));
  const child = spawn(code, [p.path], { detached: true, stdio: 'ignore', env });
  child.on('error', (err) => log('[project] start misslyckades', err.message));
  child.unref();
  log('[project] öppnar', p.path);
  return true;
}

ipcMain.handle('projects', () => listProjects());
ipcMain.handle('open-project', (_e, dir) => openProject(dir));
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
