/**
 * electron/main.js
 * ─────────────────
 * Electron MAIN PROCESS for the standalone desktop app.
 *
 *  - One normal, resizable app window (app/index.html). Bounds, maximized
 *    state, always-on-top and UI scale persist in <userData>/settings.json.
 *  - Two window modes: 'full' and 'compact' (mini mode: small, always on top,
 *    translucent). Each mode keeps its own bounds (settings.window /
 *    settings.compactWindow); switching swaps them.
 *  - Game data (db/data) is read-only and ships with the app; runtime state
 *    (build, settings, templates) lives in <userData> — see store.js.
 *  - Global hotkeys (hotkeys.js) let the player advance while the game has
 *    focus; track keys are released whenever this window is focused.
 *  - All renderer access goes through electron/preload.js (window.api).
 *
 * IPC (renderer → main, invoke):
 *   app:init                 → { db, build, settings, defaultSettings, failedHotkeys, missingData, version }
 *   build:save    (build)    → { ok }
 *   build:preview ({ json }) → { ok, summary } | { ok:false, error }
 *   build:load    ({ phases, loadoutName }) → { ok, build } | { ok:false, error }
 *   build:example            → { ok, build } | { ok:false, error }
 *   settings:save (settings) → { ok, settings, failedHotkeys }
 *   hotkeys:pause ({ paused }) → { ok }   (while recording a shortcut)
 *   window:setMode ({ mode }) → { ok, settings }   ('full' | 'compact')
 *   templates:list | templates:save | templates:load | templates:delete
 *
 * main → renderer:
 *   hotkey  { action: 'advance'|'undo'|'phase'|'latch', trackIndex?, direction?, active? }
 */

'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { createStore, DEFAULT_SETTINGS, COMPACT_MIN } = require('./store');
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
    gameData = { db: buildDb.all(), missing: buildDb.missingFiles() };
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

const isCompact = () => settings.display.mode === 'compact';

/** Saved bounds for a mode. Mini mode's first use goes to the top-right of the display. */
function boundsFor(mode) {
  if (mode !== 'compact') return visibleBounds(settings.window);
  const c = settings.compactWindow;
  if (Number.isFinite(c.x) && Number.isFinite(c.y)) {
    const b = visibleBounds(c);
    if (Number.isFinite(b.x)) return b;
  }
  const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const a = display.workArea;
  return { x: a.x + a.width - c.width - 24, y: a.y + 24, width: c.width, height: c.height };
}

/** Min size, stay-on-top and opacity for the current mode. */
function applyWindowMode() {
  if (!win || win.isDestroyed()) return;
  const compact = isCompact();
  if (compact) win.setMinimumSize(COMPACT_MIN.width, COMPACT_MIN.height);
  else win.setMinimumSize(420, 480);
  // Mini mode is always on top ('screen-saver' also floats over macOS fullscreen spaces).
  if (compact) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(settings.display.alwaysOnTop);
  win.setOpacity(compact ? settings.display.opacity : 1); // no-op on Linux
}

let boundsTimer = null;
function persistBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistBounds, 400);
}

/** Save the window's bounds into the slot of the mode it is in. */
function persistBounds() {
  clearTimeout(boundsTimer);
  if (!win || win.isDestroyed()) return;
  if (isCompact()) {
    if (win.isMinimized()) return;
    const b = win.getBounds();
    settings = store.saveSettings({ ...settings, compactWindow: { x: b.x, y: b.y, width: b.width, height: b.height } });
    return;
  }
  const maximized = win.isMaximized();
  const b = win.getNormalBounds(); // restore-size bounds, even while maximized
  settings = store.saveSettings({
    ...settings,
    window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized },
  });
}

function setWindowMode(mode) {
  const next = mode === 'compact' ? 'compact' : 'full';
  if (!win || next === settings.display.mode) return;
  persistBounds(); // outgoing mode's slot
  if (win.isMaximized()) win.unmaximize();
  if (win.isFullScreen()) win.setFullScreen(false);
  settings = store.saveSettings({ ...settings, display: { ...settings.display, mode: next } });
  applyWindowMode();
  const b = boundsFor(next);
  if (Number.isFinite(b.x)) win.setBounds(b);
  else { win.setSize(b.width, b.height); win.center(); }
  if (next === 'full' && settings.window.maximized) win.maximize();
}

function createWindow() {
  const compact = isCompact();
  win = new BrowserWindow({
    ...boundsFor(settings.display.mode),
    minWidth: compact ? COMPACT_MIN.width : 420,
    minHeight: compact ? COMPACT_MIN.height : 480,
    show: false,
    title: 'LE Build Planner',
    backgroundColor: '#0b0d12',
    alwaysOnTop: compact || settings.display.alwaysOnTop,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', // hotkey sound cues play before any click
    },
  });

  win.loadFile(path.join(ROOT, 'app', 'index.html'));

  win.once('ready-to-show', () => {
    win.webContents.setZoomFactor(settings.display.uiScale);
    applyWindowMode();
    if (!isCompact() && settings.window.maximized) win.maximize();
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
    const { db, missing } = loadGameData({ fresh: true });
    return {
      db: { trees: db.skills, classes: db.classes },
      missingData: missing,
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
    // Bounds and the window mode are owned by main (persistBounds / window:setMode).
    settings = store.saveSettings({
      ...next,
      window: settings.window,
      compactWindow: settings.compactWindow,
      display: { ...next?.display, mode: settings.display.mode },
    });
    if (win) {
      applyWindowMode();
      win.webContents.setZoomFactor(settings.display.uiScale);
    }
    const failedHotkeys = hotkeys.apply(settings.hotkeys);
    // Settings are saved from inside the focused window — keep track keys released.
    if (win?.isFocused()) hotkeys.setSuspended(true);
    return { settings, failedHotkeys };
  });

  handle('hotkeys:pause', ({ paused }) => { hotkeys.pause(!!paused); return {}; });

  handle('window:setMode', ({ mode }) => { setWindowMode(mode); return { settings }; });

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
