const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, dialog, shell, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_MS = 2 * 60 * 1000;   // bakgrundsuppdatering
const MIN_GAP_MS = 30 * 1000;    // skydd mot för täta anrop (429)
// Fönstret har fast storlek och flyttas aldrig – allt rörligt animeras i HTML.
const WIN_W = 900; // plats för projektdockan till höger om ön
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
let settings = { minimized: false, autostartSet: false, detached: false, pos: null, projectsRoot: null, selected: null, notify: true, hookToken: null, hookPort: null };
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
    {
      label: 'Projektmapp',
      submenu: [
        { label: projectsRoot(), enabled: false },
        { label: 'Välj projektmapp…', click: chooseProjectsRoot },
        { label: 'Öppna i Utforskaren', click: () => shell.openPath(projectsRoot()) },
      ],
    },
    {
      label: 'Aviseringar från Claude Code',
      type: 'checkbox',
      checked: settings.notify,
      click: (item) => setNotify(item.checked),
    },
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
// Vald mapp i inställningarna, annars första vanliga projektmapp som finns.
const ROOT_GUESSES = ['Projects', 'projects', 'source/repos', 'repos', 'dev', 'code', 'Code', 'Documents/GitHub', 'Documents/Projects']
  .map((p) => path.join(os.homedir(), p));
function projectsRoot() {
  if (settings.projectsRoot && exists(settings.projectsRoot)) return settings.projectsRoot;
  return ROOT_GUESSES.find(exists) || ROOT_GUESSES[0];
}

async function chooseProjectsRoot() {
  const res = await dialog.showOpenDialog({
    title: 'Välj projektmapp',
    buttonLabel: 'Välj mapp',
    defaultPath: projectsRoot(),
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return;
  settings.projectsRoot = res.filePaths[0];
  settings.selected = null; // ny mapp = nytt urval
  saveSettings();
  projectCache = null;
  log('[project] ny projektmapp', settings.projectsRoot);
  if (win) win.webContents.send('projects-changed');
}
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
function allProjects() {
  if (projectCache && Date.now() - projectCacheAt < 60 * 1000) return projectCache;
  let entries = [];
  const root = projectsRoot();
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  projectCache = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(root, e.name))
    .filter((d) => ['.git', 'package.json', 'pubspec.yaml'].some((f) => exists(path.join(d, f))))
    .map((d) => ({
      name: path.basename(d).replace(/[-_]+/g, ' '),
      path: d,
      icon: findIcon(d),
      kind: detectKind(d),
      activity: activity(d),
    }))
    .sort((a, b) => b.activity - a.activity);
  projectCacheAt = Date.now();
  return projectCache;
}

// Max antal projekt i dockan (resten väljs bort i projektvyn).
const DOCK_MAX = 8;

// Alla projekt, med flaggan selected. Utan eget urval: de senast aktiva.
function listProjects() {
  const all = allProjects();
  const chosen = Array.isArray(settings.selected)
    ? new Set(settings.selected)
    : new Set(all.slice(0, DOCK_MAX).map((p) => p.path));
  return all.map((p) => ({ ...p, selected: chosen.has(p.path) }));
}

ipcMain.handle('set-selected', (_e, paths) => {
  if (!Array.isArray(paths)) return false;
  const valid = new Set(allProjects().map((p) => p.path));
  settings.selected = paths.filter((p) => typeof p === 'string' && valid.has(p)).slice(0, DOCK_MAX);
  saveSettings();
  return true;
});

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
  // Öppna bara mappar som finns i projektlistan eller som skickat en avisering.
  const p = allProjects().find((x) => x.path === dir) || notifiedProjects.get(dir);
  if (!p) return false;
  const code = findVSCode();
  if (!code) { log('[project] hittar inte VS Code'); return false; }
  if (allProjects().some((x) => x.path === p.path)) ensureClaudeTask(p.path);
  // Rensa Electron-variabler så att VS Code (också Electron) inte påverkas av vår miljö.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ELECTRON_')));
  const child = spawn(code, [p.path], { detached: true, stdio: 'ignore', env });
  child.on('error', (err) => log('[project] start misslyckades', err.message));
  child.unref();
  log('[project] öppnar', p.path);
  return true;
}

/* ================= aviseringar från Claude Code =================
   Claude Codes hooks skickar sin JSON (med projektmappen i "cwd") med curl
   till en liten mottagare på 127.0.0.1. Det tar några hundradelar och kan
   aldrig blockera Claude: kör inte ön misslyckas curl direkt och hooken
   avslutas med 0. En slumpad nyckel i adressen stoppar förfalskade anrop. */
const notifiedProjects = new Map(); // sökväg -> projekt, för klick på avisering
const HOOK_EVENTS = { Stop: 'stop', Notification: 'attention', UserPromptSubmit: 'prompt' };

function projectForDir(dir) {
  if (!dir) return null;
  const norm = (p) => path.resolve(p).toLowerCase();
  const d = norm(dir);
  // Exakt projekt eller en undermapp till ett projekt i listan.
  const hit = allProjects()
    .filter((p) => d === norm(p.path) || d.startsWith(norm(p.path) + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (hit) return hit;
  return {
    name: path.basename(dir).replace(/[-_]+/g, ' '),
    path: dir,
    icon: findIcon(dir),
    kind: detectKind(dir),
  };
}

function handleNotify(type, cwd) {
  if (!['stop', 'attention', 'prompt'].includes(type)) return;
  if (!settings.notify) return;
  const p = projectForDir(cwd);
  if (!p) { log('[notify] okänd mapp', type, cwd); return; }
  notifiedProjects.set(p.path, p);
  const ev = { type, path: p.path, name: p.name, icon: p.icon, kind: p.kind, at: Date.now() };
  log('[notify]', type, p.path);
  if (win && !win.isDestroyed()) win.webContents.send('claude-event', ev);

  // Minimerad ö: visa en vanlig Windows-avisering i stället.
  if (type !== 'prompt' && win && !win.isVisible() && Notification.isSupported()) {
    const n = new Notification({
      title: p.name,
      body: type === 'attention' ? 'Claude behöver dig' : 'Claude är klar och väntar på dig',
      silent: false,
    });
    n.on('click', () => { openProject(p.path); win.webContents.send('claude-dismiss', p.path); });
    n.show();
  }
}

const HOOK_PORTS = [47823, 47824, 47825, 47826, 47827];
let hookServer = null;

function startHookServer() {
  if (!settings.hookToken) {
    settings.hookToken = crypto.randomBytes(12).toString('hex');
    saveSettings();
  }
  return new Promise((resolve) => {
    const ports = settings.hookPort ? [settings.hookPort, ...HOOK_PORTS.filter((p) => p !== settings.hookPort)] : HOOK_PORTS;
    const tryPort = (i) => {
      if (i >= ports.length) { log('[hooks] ingen ledig port'); return resolve(false); }
      const srv = http.createServer((req, res) => {
        const m = /^\/claude-island\/([a-f0-9]+)\/(stop|attention|prompt)$/.exec(req.url || '');
        if (req.method !== 'POST' || !m || m[1] !== settings.hookToken) { res.writeHead(404); return res.end(); }
        let body = '';
        req.on('data', (c) => { if (body.length < 65536) body += c; });
        req.on('end', () => {
          res.writeHead(204); res.end();
          let cwd = null;
          try { cwd = JSON.parse(body.slice(body.indexOf('{'))).cwd || null; } catch (err) { log('[hooks] ogiltig JSON', err.message, body.slice(0, 120)); }
          try { handleNotify(m[2], cwd); } catch (err) { log('[hooks] fel', err && err.stack); }
        });
      });
      srv.once('error', () => tryPort(i + 1));
      srv.listen(ports[i], '127.0.0.1', () => {
        hookServer = srv;
        if (settings.hookPort !== ports[i]) { settings.hookPort = ports[i]; saveSettings(); }
        log('[hooks] lyssnar på 127.0.0.1:' + ports[i]);
        resolve(true);
      });
    };
    tryPort(0);
  });
}

// Kommandot som hookarna kör: skicka hookens JSON till ön. "|| exit 0" gör att
// hooken alltid lyckas, i både bash och cmd, även om ön inte kör.
function hookCommand(type) {
  const url = `http://127.0.0.1:${settings.hookPort}/claude-island/${settings.hookToken}/${type}`;
  return `curl -s -m 2 -X POST -H "Content-Type: application/json" --data-binary @- ${url} || exit 0`;
}
const isOurHook = (h) => typeof h?.command === 'string' &&
  (h.command.includes('/claude-island/') || (h.command.includes('--notify') && /claude island/i.test(h.command)));

// Lägger in (eller tar bort) våra hooks i ~/.claude/settings.json utan att röra något annat.
function syncClaudeHooks() {
  if (!app.isPackaged) return; // utvecklingsläge: rör inte de riktiga inställningarna
  if (settings.notify && !hookServer) return; // ingen mottagare = inga hooks
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  let cfg = {};
  if (exists(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { log('[hooks] kunde inte läsa settings.json – rör den inte', err.message); return; }
  }
  const before = JSON.stringify(cfg);
  cfg.hooks = cfg.hooks || {};
  for (const [event, type] of Object.entries(HOOK_EVENTS)) {
    // Ta bort gamla poster från Claude Island (t.ex. om exe-filen flyttats).
    const groups = (cfg.hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h)) }))
      .filter((g) => g.hooks.length);
    if (settings.notify) {
      groups.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand(type), timeout: 10 }] });
    }
    if (groups.length) cfg.hooks[event] = groups; else delete cfg.hooks[event];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  if (JSON.stringify(cfg) === before) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    log('[hooks] uppdaterade', file, settings.notify ? 'på' : 'av');
  } catch (err) {
    log('[hooks] kunde inte skriva settings.json', err.message);
  }
}

function setNotify(on) {
  settings.notify = on;
  saveSettings();
  syncClaudeHooks();
  if (!on && win) win.webContents.send('claude-dismiss', '*');
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

// Startad av en hook (--notify): lämna över till den körande instansen och avsluta.
// Kör ingen ö? Då gör vi ingenting (startar inte ön av bara farten).
const isNotifyCall = process.argv.includes('--notify');
if (!app.requestSingleInstanceLock() || isNotifyCall) {
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
    app.setAppUserModelId('com.jazzepm.claudeisland'); // krävs för Windows-aviseringar
    createWindow();
    createTray();
    startHookServer().then(syncClaudeHooks);
    setInterval(() => push(false), POLL_MS);
  });
  app.on('second-instance', (_e, argv) => {
    if (!argv.includes('--notify')) restore(); // gamla --notify-anrop ignoreras
  });
  app.on('window-all-closed', () => app.quit());
}
