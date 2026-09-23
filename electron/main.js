/**
 * electron/main.js
 * ─────────────────
 * Electron MAIN PROCESS for the standalone desktop app.
 *
 *  - One normal, resizable app window (app/index.html). Bounds, maximized
 *    state, always-on-top and UI scale persist in <userData>/settings.json.
 *  - Game data (db/data) is read-only and ships with the app; runtime state
 *    (build, settings, templates) lives in <userData> — see store.js.
 *  - Global hotkeys (hotkeys.js) let the player advance while the game has
 *    focus; track keys are released whenever this window is focused.
 *  - All renderer access goes through electron/preload.js (window.api).
 *
 * IPC (renderer → main, invoke):
 *   app:init                 → { db, build, settings, defaultSettings, failedHotkeys, dataSource, version }
 *   build:save    (build)    → { ok }
 *   build:preview ({ json }) → { ok, summary } | { ok:false, error }
 *   build:load    ({ phases, loadoutName }) → { ok, build } | { ok:false, error }
 *   build:example            → { ok, build } | { ok:false, error }
 *   settings:save (settings) → { ok, settings, failedHotkeys }
 *   hotkeys:pause ({ paused }) → { ok }   (while recording a shortcut)
 *   templates:list | templates:save | templates:load | templates:delete
 *
 * main → renderer:
 *   hotkey  { action: 'advance'|'undo'|'phase'|'latch', trackIndex?, direction?, active? }
 */

'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { createStore, DEFAULT_SETTINGS } = require('./store');
const { createHotkeys } = require('./hotkeys');

const ROOT = path.join(__dirname, '..');
const EXAMPLE_BUILD = path.join(ROOT, 'config', 'build.example.json');
const IS_DEV = process.argv.includes('--dev');

// Allows an isolated profile (tests, screenshots) without touching real data.
if (process.env.LE_USER_DATA) app.setPath('userData', path.resolve(process.env.LE_USER_DATA));

// Single instance: a second launch focuses the existing window.
const IS_PRIMARY = app.requestSingleInstanceLock();
if (!IS_PRIMARY) app.quit();

let win = null;
let store = null;
let hotkeys = null;
let settings = null;

// ─── Game data ────────────────────────────────────────────────────────────────

let gameData = null;

/**
 * Game data is read-only while the app runs: load once, reuse for every
 * preview/load. `fresh` re-reads from disk (window (re)load), so re-running
 * the extractor only needs a reload, not a restart.
 */
function loadGameData({ fresh = false } = {}) {
  if (!gameData || fresh) {
    const buildDb = require('../db/build-db');
    buildDb.load(true);
    gameData = { db: buildDb.all(), source: buildDb.source() };
  }
  return gameData;
}

// ─── Window ───────────────────────────────────────────────────────────────────

/** Keep saved bounds only if at least a usable strip of the window is on a display. */
function visibleBounds(w) {
  if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) return { width: w.width, height: w.height };
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    w.x + 120 < a.x + a.width && w.x + w.width - 120 > a.x &&
    w.y >= a.y - 10 && w.y + 60 < a.y + a.height);
  return onScreen ? { x: w.x, y: w.y, width: w.width, height: w.height } : { width: w.width, height: w.height };
}

let boundsTimer = null;
function persistBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistBounds, 400);
}

function persistBounds() {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const b = win.getNormalBounds(); // restore-size bounds, even while maximized
  settings = store.saveSettings({
    ...settings,
    window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized },
  });
}

function createWindow() {
  win = new BrowserWindow({
    ...visibleBounds(settings.window),
    minWidth: 420,
    minHeight: 480,
    show: false,
    title: 'LE Build Planner',
    backgroundColor: '#0b0d12',
    alwaysOnTop: settings.display.alwaysOnTop,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(ROOT, 'app', 'index.html'));

  win.once('ready-to-show', () => {
    win.webContents.setZoomFactor(settings.display.uiScale);
    if (settings.window.maximized) win.maximize();
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  // Zoom resets on navigation/reload — reapply.
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(settings.display.uiScale));

  // External links open in the browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('focus', () => hotkeys.setSuspended(true));
  win.on('blur', () => hotkeys.setSuspended(false));
  win.on('move', persistBoundsSoon);
  win.on('resize', persistBoundsSoon);
  win.on('close', persistBounds);
  win.on('closed', () => { win = null; });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    win.showInactive(); // never steal focus from the game
    if (win.isMinimized()) win.restore();
  }
}

function emitHotkey(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('hotkey', payload);
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

/** Wrap a handler so thrown errors become { ok:false, error } instead of rejections. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, arg) => {
    try {
      return { ok: true, ...(await fn(arg)) };
    } catch (err) {
      console.error(`[main] ${channel}:`, err.message);
      return { ok: false, error: err.message };
    }
  });
}

function registerIpc() {
  handle('app:init', () => {
    const { db, source } = loadGameData({ fresh: true });
    return {
      db: { trees: db.skills, classes: db.classes },
      dataSource: source,
      build: store.loadBuild(),
      settings,
      defaultSettings: DEFAULT_SETTINGS,
      failedHotkeys: hotkeys.getFailures(),
      version: app.getVersion(),
    };
  });

  handle('build:save', (build) => {
    if (!build || !Array.isArray(build.phases)) throw new Error('Refusing to save an invalid loadout');
    store.saveBuild(build);
    return {};
  });

  handle('build:preview', ({ json }) => {
    const { parseBuild } = require('../parser/maxroll');
    const { db } = loadGameData();
    const build = parseBuild(json, db.skills, db.classes, 'Preview');
    const [passive, ...skills] = build.tracks;
    return {
      summary: {
        classLabel: passive.label.replace(/ Passives$/, ''),
        passivePoints: passive.history.length,
        skills: skills.map(t => ({
          key: t.skillKey,
          name: db.skills[t.skillKey]?.name ?? t.skillKey,
          points: t.history.length,
          known: !!db.skills[t.skillKey],
        })),
      },
    };
  });

  handle('build:load', ({ phases, loadoutName }) => {
    const { parseLoadout } = require('../parser/maxroll');
    const { db } = loadGameData();
    const build = parseLoadout(phases, db.skills, db.classes, loadoutName || 'Imported loadout');
    store.saveBuild(build);
    return { build };
  });

  handle('build:example', () => {
    const { validateLoadout } = require('../parser/build-schema');
    const build = JSON.parse(fs.readFileSync(EXAMPLE_BUILD, 'utf-8'));
    delete build._comment;
    validateLoadout(build);
    store.saveBuild(build);
    return { build };
  });

  handle('settings:save', (next) => {
    settings = store.saveSettings({ ...next, window: settings.window });
    if (win) {
      win.setAlwaysOnTop(settings.display.alwaysOnTop);
      win.webContents.setZoomFactor(settings.display.uiScale);
    }
    const failedHotkeys = hotkeys.apply(settings.hotkeys);
    // Settings are saved from inside the focused window — keep track keys released.
    if (win?.isFocused()) hotkeys.setSuspended(true);
    return { settings, failedHotkeys };
  });

  handle('hotkeys:pause', ({ paused }) => { hotkeys.pause(!!paused); return {}; });

  handle('templates:list', () => ({ list: store.listTemplates() }));
  handle('templates:save', (t) => ({ filename: store.saveTemplate(t) }));
  handle('templates:load', ({ filename }) => ({ template: store.loadTemplate(filename) }));
  handle('templates:delete', ({ filename }) => { store.deleteTemplate(filename); return {}; });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (!IS_PRIMARY) return;
  Menu.setApplicationMenu(null);

  store = createStore({ dir: app.getPath('userData'), legacyDir: path.join(ROOT, 'config') });
  const migrated = store.migrateLegacy();
  if (migrated.length) console.log(`[main] Migrated from config/: ${migrated.join(', ')}`);
  settings = store.loadSettings();

  hotkeys = createHotkeys({ globalShortcut, emit: emitHotkey, toggleWindow });
  hotkeys.apply(settings.hotkeys);

  registerIpc();
  createWindow();
});

app.on('will-quit', () => hotkeys?.dispose());
app.on('window-all-closed', () => app.quit());
