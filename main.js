'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { createCore } = require('./src/core');
const { drawBGRA } = require('./src/icon');

const SCAN_MS = 4000;
const MAX_ATTEMPTS = 3; // automatic tries per session before giving up
const RETRY_GAP_MS = 60000;

const startHidden = process.argv.includes('--hidden');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let quitting = false;
let config = { auto: true, graceSec: 10 };
let lastState = null;
const logLines = [];
const firstSeen = new Map(); // pid -> ms
const attempts = new Map(); // pid -> { n, last }
let lastResult = null;

const configFile = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
  } catch {}
}
function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
  } catch {}
}

function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'activity.log'), `${new Date().toISOString()}  ${msg}\n`);
  } catch {}
  win?.webContents.send('log', line);
}

let core;

function loginEnabled() {
  return app.getLoginItemSettings({ args: loginArgs() }).openAtLogin;
}
function loginArgs() {
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}
function setLogin(on) {
  app.setLoginItemSettings({ openAtLogin: on, args: loginArgs() });
}

function trayImage(badge) {
  return nativeImage.createFromBitmap(drawBGRA(32, badge), { width: 32, height: 32, scaleFactor: 2 });
}

async function refresh() {
  const scan = await core.scan();
  const now = Date.now();
  const live = new Set(scan.vscodeSessions.map((s) => s.pid));
  for (const pid of [...firstSeen.keys()]) if (!live.has(pid)) firstSeen.delete(pid);
  for (const pid of [...attempts.keys()]) if (!live.has(pid)) attempts.delete(pid);

  for (const s of scan.vscodeSessions) {
    if (!firstSeen.has(s.pid)) firstSeen.set(s.pid, now);
    if (s.remote) attempts.delete(s.pid);
    const a = attempts.get(s.pid);
    s.attempts = a ? a.n : 0;
    s.gaveUp = !s.remote && s.attempts >= MAX_ATTEMPTS;
    s.enabling = !s.remote && core.isRunning();
  }

  lastState = {
    now,
    config,
    login: loginEnabled(),
    setting: core.currentSetting(),
    claudeDir: core.claudeDir,
    busy: core.isRunning(),
    lastResult,
    ...scan,
  };
  win?.webContents.send('state', lastState);
  updateTray(scan);

  if (config.auto && !core.isRunning()) {
    const due = scan.vscodeSessions.filter((s) => {
      if (s.remote) return false;
      const a = attempts.get(s.pid) || { n: 0, last: 0 };
      return a.n < MAX_ATTEMPTS && now - firstSeen.get(s.pid) >= config.graceSec * 1000 && now - a.last >= RETRY_GAP_MS;
    });
    if (due.length) runEnable('auto', due.map((s) => s.pid));
  }
}

async function runEnable(reason, pids) {
  if (core.isRunning()) return;
  const now = Date.now();
  for (const pid of pids ?? lastState?.vscodeSessions.filter((s) => !s.remote).map((s) => s.pid) ?? []) {
    const a = attempts.get(pid) || { n: 0, last: 0 };
    attempts.set(pid, reason === 'manual' ? { n: 1, last: now } : { n: a.n + 1, last: now });
  }
  win?.webContents.send('busy', true);
  const result = await core.enableAll({ reason });
  lastResult = { ...result, at: Date.now(), targets: result.targets.map((t) => t.name), enabled: result.enabled.map((t) => t.name), failed: result.failed.map((t) => t.name) };
  if (result.enabled.length && Notification.isSupported()) {
    new Notification({
      title: 'Remote Control enabled',
      body: result.enabled.map((s) => s.name).join(', '),
      silent: true,
    }).show();
  }
  await refresh();
}

function updateTray(scan) {
  if (!tray) return;
  const total = scan.vscodeSessions.length;
  const off = scan.vscodeSessions.filter((s) => !s.remote).length;
  const badge = core.isRunning() ? 'busy' : total === 0 ? undefined : off ? 'warn' : 'ok';
  tray.setImage(trayImage(badge));
  tray.setToolTip(
    total === 0
      ? 'Claude RC Enabler: no VS Code sessions'
      : `Claude RC Enabler: ${total - off}/${total} sessions have Remote Control`,
  );
  tray.setContextMenu(buildMenu(off));
}

function buildMenu(off) {
  return Menu.buildFromTemplate([
    { label: 'Open dashboard', click: showWindow },
    { label: off ? `Enable Remote Control now (${off})` : 'Enable Remote Control now', enabled: !core.isRunning(), click: () => runEnable('manual') },
    { type: 'separator' },
    {
      label: 'Enable automatically',
      type: 'checkbox',
      checked: config.auto,
      click: (i) => {
        config.auto = i.checked;
        saveConfig();
        refresh();
      },
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: loginEnabled(),
      click: (i) => {
        setLogin(i.checked);
        refresh();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 620,
    minHeight: 460,
    show: !startHidden,
    title: 'Claude RC Enabler',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('init', { logs: logLines, state: lastState });
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  loadConfig();
  core = createCore({ log });
  createWindow();
  tray = new Tray(trayImage());
  tray.on('click', showWindow);
  tray.setContextMenu(buildMenu(0));

  ipcMain.handle('enable-now', () => runEnable('manual'));
  ipcMain.handle('set-auto', (_e, on) => { config.auto = !!on; saveConfig(); return refresh(); });
  ipcMain.handle('set-login', (_e, on) => { setLogin(!!on); return refresh(); });
  ipcMain.handle('open-log', () => shell.openPath(path.join(app.getPath('userData'), 'activity.log')));
  ipcMain.handle('refresh', () => refresh());

  log(`Started. Watching ${core.claudeDir}`);
  refresh();
  if (process.env.RC_SMOKE_SHOT) {
    // dev aid: render once, save a screenshot, quit
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.RC_SMOKE_SHOT, img.toPNG());
      quitting = true;
      app.quit();
    }, 3500);
  }
  setInterval(() => refresh().catch((e) => log(`Scan failed: ${e.message}`)), SCAN_MS);
});
