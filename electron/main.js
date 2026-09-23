/**
 * electron/main.js
 * ─────────────────
 * Electron MAIN PROCESS — the Node.js backend of the app.
 *
 * Responsibilities:
 *  1. Create the transparent, click-through overlay BrowserWindow
 *  2. Create a separate focusable config BrowserWindow (opened via F5)
 *  3. Register global hotkeys that work even when the game has focus
 *  4. Route hotkey events to the renderer via IPC
 *  5. Handle 'save-build' IPC from renderer → write config/build.json to disk
 *
 * Window behaviour:
 *  - Overlay window: always on top, transparent, NO frame, NOT focusable,
 *    click-through (setIgnoreMouseEvents). Positioned at right side of screen,
 *    above the game's action bar area.
 *  - Config window: normal focusable window. Shown when user presses F5.
 *    Contains a textarea to paste Maxroll JSON + a "Load" button.
 *
 * IPC Channels (see also preload.js):
 *  main → renderer:  'hotkey'  { action: 'toggle'|'advance'|'undo', trackIndex?: number }
 *  renderer → main:  'save-build'  <full build JSON object>
 *
 * Global hotkeys:
 *  F1          → toggle overlay visibility
 *  1–6         → advance track N (only fires when overlay is visible)
 *  Shift+1–6   → undo one step on track N
 *  F5          → open / focus config window
 *
 * NOTE: Keys 1–6 overlap with in-game ability hotkeys. The current strategy is
 * to only honour them when `overlayVisible === true`. If this causes accidental
 * triggers, add a modifier (Alt+1–6) or a dedicated toggle mode.
 */

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── State ────────────────────────────────────────────────────────────────────

let overlayWin   = null;
let configWin    = null;
let settingsWin  = null;
let overlayVisible  = true;
let inPositionMode  = false;
let advanceModeActive = false;  // latch mode: true while 1–6 are armed
let advanceModeTimer  = null;   // auto-deactivate timeout handle

// Paths to runtime config files
const BUILD_CONFIG_PATH    = path.join(__dirname, '..', 'config', 'build.json');
const SETTINGS_CONFIG_PATH = path.join(__dirname, '..', 'config', 'settings.json');
const SAVES_DIR            = path.join(__dirname, '..', 'config', 'saves');

// Default settings — used if settings.json is missing or corrupt
const DEFAULT_SETTINGS = {
  window:  { x: null, y: null, width: 260, height: 400 },
  display: { fontSize: 13, opacity: 0.88, showDescription: true, alwaysShowProgress: false },
  hotkeys: { toggle: 'F1', advanceModifier: '', undoModifier: 'Shift', settingsKey: 'F2', configKey: 'F5', positionKey: 'F3', phaseNextKey: 'F6', phasePrevKey: 'Shift+F6', hotkeyMode: 'direct', latchKey: '`' },
};

// In-memory settings (loaded at startup, mutated on save)
let settings = { ...DEFAULT_SETTINGS };

// ─── Settings helpers ─────────────────────────────────────────────────────────

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // Deep merge so partial files still work
    settings = {
      window:  { ...DEFAULT_SETTINGS.window,  ...parsed.window  },
      display: { ...DEFAULT_SETTINGS.display, ...parsed.display },
      hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...parsed.hotkeys },
    };
  } catch {
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function saveSettings(updated) {
  settings = updated;
  fs.writeFileSync(SETTINGS_CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Apply current settings to the overlay window and re-register hotkeys.
 * Safe to call at any time (win may not exist yet).
 * @returns {string[]} hotkeys that failed to register
 */
function applySettings() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const x = settings.window.x ?? (sw - settings.window.width - 10);
    const y = settings.window.y ?? (sh - settings.window.height - 220);
    overlayWin.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width:  settings.window.width,
      height: settings.window.height,
    });
    // Notify renderer about display settings (font size, opacity)
    overlayWin.webContents.send('settings-changed', settings);
  }
  // Re-register hotkeys whenever settings change (exit latch mode first)
  if (advanceModeActive) exitAdvanceMode();
  globalShortcut.unregisterAll();
  return registerHotkeys();
}

// ─── Position mode ────────────────────────────────────────────────────────────

function enterPositionMode() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  inPositionMode = true;
  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.setFocusable(true);
  overlayWin.focus(); // bring to front so mouse events are received
  overlayWin.webContents.send('enter-position-mode');
}

function exitPositionMode() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  inPositionMode = false;
  // Save current window bounds to settings
  const [x, y] = overlayWin.getPosition();
  const [width, height] = overlayWin.getSize();
  settings.window = { x, y, width, height };
  fs.writeFileSync(SETTINGS_CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  // Restore click-through
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.setFocusable(false);
  overlayWin.webContents.send('exit-position-mode');
}

// ─── Window creation ─────────────────────────────────────────────────────────

function createOverlayWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const x = settings.window.x ?? (screenWidth  - settings.window.width  - 10);
  const y = settings.window.y ?? (screenHeight - settings.window.height - 220);

  overlayWin = new BrowserWindow({
    width:  settings.window.width,
    height: settings.window.height,
    x: Math.round(x),
    y: Math.round(y),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,        // CRITICAL: never steal game focus
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,  // MUST stay true for contextBridge security
      nodeIntegration: false,  // MUST stay false
    },
  });

  overlayWin.loadFile(path.join(__dirname, '..', 'overlay', 'index.html'));

  // Make the window fully click-through — mouse events pass to whatever is behind it
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  // Send initial settings to renderer once it loads so display toggles apply on first render
  overlayWin.webContents.once('did-finish-load', () => {
    overlayWin.webContents.send('settings-changed', settings);
  });

  overlayWin.on('closed', () => { overlayWin = null; });
}

function createConfigWindow() {
  configWin = new BrowserWindow({
    width: 560,
    height: 680,
    title: 'LE Build Overlay — Load Build',
    transparent: false,
    frame: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'config-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  configWin.setMenuBarVisibility(false);
  configWin.loadFile(path.join(__dirname, '..', 'overlay', 'config.html'));
  configWin.on('closed', () => { configWin = null; });
}

function createSettingsWindow() {
  settingsWin = new BrowserWindow({
    width: 420,
    height: 520,
    title: 'LE Build Overlay — Settings',
    transparent: false,
    frame: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, '..', 'overlay', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ─── Hotkey registration helpers ──────────────────────────────────────────────

const LATCH_TIMEOUT_MS = 5000;

// Accelerators that failed to register in the last registerHotkeys() pass
// (invalid string, or already taken by another app). Surfaced to the settings window.
let hotkeyFailures = [];

/**
 * Register one global shortcut without letting a bad accelerator abort the
 * rest of the registration pass. `register` throws on malformed strings and
 * returns false when another application already owns the key.
 */
function safeRegister(accelerator, handler) {
  if (!accelerator) return false;
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, handler);
  } catch (err) {
    console.error(`[main] Invalid hotkey "${accelerator}": ${err.message}`);
  }
  if (!ok) {
    console.warn(`[main] Could not register hotkey "${accelerator}"`);
    hotkeyFailures.push(accelerator);
  }
  return ok;
}

function trackKeyPairs() {
  const hk = settings.hotkeys;
  const pairs = [];
  for (let i = 1; i <= 6; i++) {
    pairs.push({
      trackIndex: i - 1,
      advKey:  hk.advanceModifier ? `${hk.advanceModifier}+${i}` : `${i}`,
      undoKey: hk.undoModifier    ? `${hk.undoModifier}+${i}`    : `${i}`,
    });
  }
  return pairs;
}

function sendTrackAction(action, trackIndex) {
  if (!overlayWin || !overlayVisible || inPositionMode) return;
  overlayWin.webContents.send('hotkey', { action, trackIndex });
  // In latch mode, every use keeps advance mode armed for another timeout window
  if (advanceModeActive) armAdvanceTimer();
}

/**
 * Register the 1–6 advance/undo keys. When advance and undo resolve to the
 * same accelerator (no modifiers), the key acts as advance only.
 */
function registerTrackKeys() {
  for (const { trackIndex, advKey, undoKey } of trackKeyPairs()) {
    if (advKey === undoKey) {
      safeRegister(advKey, () => sendTrackAction('advance', trackIndex));
    } else {
      safeRegister(advKey,  () => sendTrackAction('advance', trackIndex));
      safeRegister(undoKey, () => sendTrackAction('undo', trackIndex));
    }
  }
}

function unregisterTrackKeys() {
  for (const { advKey, undoKey } of trackKeyPairs()) {
    try { globalShortcut.unregister(advKey); } catch { /* invalid accelerator */ }
    if (undoKey !== advKey) {
      try { globalShortcut.unregister(undoKey); } catch { /* invalid accelerator */ }
    }
  }
}

// ─── Advance (latch) mode ─────────────────────────────────────────────────────

function armAdvanceTimer() {
  clearTimeout(advanceModeTimer);
  advanceModeTimer = setTimeout(exitAdvanceMode, LATCH_TIMEOUT_MS);
}

/**
 * Arm the 1–6 hotkeys (latch hotkeyMode only). They stay armed until the latch
 * key is pressed again or LATCH_TIMEOUT_MS passes with no advance/undo.
 */
function enterAdvanceMode() {
  if (advanceModeActive) return;
  advanceModeActive = true;
  registerTrackKeys();
  overlayWin?.webContents.send('advance-mode', { active: true });
  armAdvanceTimer();
}

/** Disarm the 1–6 hotkeys so normal typing is never intercepted. */
function exitAdvanceMode() {
  if (!advanceModeActive) return;
  clearTimeout(advanceModeTimer);
  advanceModeTimer = null;
  advanceModeActive = false;
  unregisterTrackKeys();
  overlayWin?.webContents.send('advance-mode', { active: false });
}

// ─── Global hotkeys ──────────────────────────────────────────────────────────

/**
 * Register every global hotkey from settings. Returns the accelerators that
 * failed so callers can report them; a failure never blocks the others.
 */
function registerHotkeys() {
  const hk = settings.hotkeys;
  hotkeyFailures = [];

  // Toggle overlay visibility
  safeRegister(hk.toggle, () => {
    if (!overlayWin) return;
    overlayVisible = !overlayVisible;
    if (overlayVisible) {
      overlayWin.show();
    } else {
      if (advanceModeActive) exitAdvanceMode();
      overlayWin.hide();
    }
    overlayWin.webContents.send('hotkey', { action: 'toggle', visible: overlayVisible });
  });

  if (hk.hotkeyMode === 'latch') {
    // Latch mode: only the latch key is global; it arms/disarms 1–6 on demand.
    safeRegister(hk.latchKey, () => {
      if (!overlayWin || !overlayVisible || inPositionMode) return;
      if (advanceModeActive) exitAdvanceMode();
      else enterAdvanceMode();
    });
  } else {
    // Direct mode (default): 1–6 always registered, fire immediately.
    registerTrackKeys();
  }

  // Open settings window
  safeRegister(hk.settingsKey, () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.focus();
    else createSettingsWindow();
  });

  // Open config window
  safeRegister(hk.configKey, () => {
    if (configWin && !configWin.isDestroyed()) configWin.focus();
    else createConfigWindow();
  });

  // Toggle position mode (drag & resize overlay)
  safeRegister(hk.positionKey, () => {
    if (!overlayWin || !overlayVisible) return;
    if (inPositionMode) exitPositionMode();
    else enterPositionMode();
  });

  // Phase switching — next / previous
  safeRegister(hk.phaseNextKey, () => {
    if (!overlayWin || !overlayVisible || inPositionMode) return;
    overlayWin.webContents.send('hotkey', { action: 'phase', direction: +1 });
  });
  safeRegister(hk.phasePrevKey, () => {
    if (!overlayWin || !overlayVisible || inPositionMode) return;
    overlayWin.webContents.send('hotkey', { action: 'phase', direction: -1 });
  });

  return hotkeyFailures;
}

// ─── Game data ────────────────────────────────────────────────────────────────

/**
 * Load node + class data for name resolution while parsing a pasted build.
 * Forces a reload so a freshly re-extracted data file is picked up without
 * restarting. Falls back to the committed sample (or empty) — never throws.
 */
function loadDbForParser() {
  const buildDb = require('../db/build-db');
  buildDb.load(true);
  const { skills, classes } = buildDb.all();
  return { skillsDb: skills, classesDb: classes };
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => settings);

ipcMain.handle('save-settings', (event, updated) => {
  try {
    saveSettings(updated);
    const failedHotkeys = applySettings();
    return { success: true, failedHotkeys };
  } catch (err) {
    console.error('[main] save-settings error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.on('move-window', (event, { dx, dy }) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const [x, y] = overlayWin.getPosition();
  overlayWin.setPosition(x + Math.round(dx), y + Math.round(dy));
});

ipcMain.on('resize-window', (event, { width, height }) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const [x, y] = overlayWin.getPosition();
  overlayWin.setBounds({ x, y, width: Math.max(180, width), height: Math.max(200, height) });
});

ipcMain.on('end-position-mode', () => {
  exitPositionMode();
});

ipcMain.handle('start-position-mode', () => {
  enterPositionMode();
  return { success: true };
});

ipcMain.on('save-build', (event, buildJson) => {
  // Renderer sends updated build state after each advance/undo so currentStep persists
  try {
    fs.writeFileSync(BUILD_CONFIG_PATH, JSON.stringify(buildJson, null, 2), 'utf-8');
  } catch (err) {
    console.error('[main] Failed to save build.json:', err);
  }
});

// Build { [treeID]: { name, nodes } } from the skill + passive node files.
function loadTreeDb() {
  const dataDir = path.join(__dirname, '..', 'db', 'data');
  const trees = {};
  for (const file of ['skill_tree_reconciled.json', 'passives.json']) {
    const rawNodes = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
    for (const { treeID, treeName, nodeID, nodeName, description, maxPoints, stats } of rawNodes) {
      if (!trees[treeID]) trees[treeID] = { name: treeName, nodes: {} };
      trees[treeID].nodes[String(nodeID)] = { id: nodeID, nodeName, description, maxPoints, stats };
    }
  }
  return trees;
}

ipcMain.handle('load-build', async (event, { jsonString, buildName }) => {
  // Config window renderer sends raw Maxroll JSON → parse → save → notify overlay
  try {
    const { parseBuild, saveBuild } = require('../parser/maxroll');

    // Load DB files for name resolution (graceful fallback if not yet extracted)
    try {
      skillsDb = loadTreeDb();
    } catch { /* DB not yet extracted — skill names fall back to skillKey */ }
    try {
      const classesPath = path.join(__dirname, '..', 'db', 'data', 'classes.json');
      classesDb = JSON.parse(fs.readFileSync(classesPath, 'utf-8'));
    } catch { /* DB not yet extracted — class names fall back to IDs */ }
    const { skillsDb, classesDb } = loadDbForParser();

    const build = parseBuild(jsonString, skillsDb, classesDb, buildName || 'Imported Build');
    saveBuild(build, BUILD_CONFIG_PATH);

    // Notify overlay renderer to reload from disk
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('reload-build');
    }

    // Close config window after successful load
    if (configWin && !configWin.isDestroyed()) {
      configWin.close();
    }

    return { success: true };
  } catch (err) {
    console.error('[main] load-build error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-loadout', async (event, { phases, loadoutName }) => {
  // Config window sends an array of { name, json } phase descriptors.
  // We parse each phase, validate the loadout, persist it, and notify the overlay.
  try {
    const { parseLoadout, saveBuild } = require('../parser/maxroll');

    const { skillsDb, classesDb } = loadDbForParser();

    const loadout = parseLoadout(phases, skillsDb, classesDb, loadoutName || 'Imported Loadout');
    saveBuild(loadout, BUILD_CONFIG_PATH);

    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('reload-build');
    }
    if (configWin && !configWin.isDestroyed()) {
      configWin.close();
    }

    return { success: true };
  } catch (err) {
    console.error('[main] load-loadout error:', err.message);
    return { success: false, error: err.message };
  }
});

// ─── Loadout template persistence ────────────────────────────────────────────
// Templates store raw form inputs (loadout name + phase JSON strings) so the
// user can re-open and edit them later without losing the original export codes.
// They live in config/saves/ and are separate from config/build.json (the live
// loadout with progress). Loading a template into the overlay always resets
// all currentStep progress to 0.

function ensureSavesDir() {
  if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });
}

function templateFilename(loadoutName) {
  const safe = (loadoutName || 'unnamed').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 40);
  return `${safe}_${Date.now()}.json`;
}

ipcMain.handle('save-template', (event, { loadoutName, phases }) => {
  try {
    ensureSavesDir();
    const template = {
      version: 1,
      savedAt: new Date().toISOString(),
      loadoutName: loadoutName || 'Unnamed Loadout',
      phases,
    };
    const filename = templateFilename(loadoutName);
    fs.writeFileSync(path.join(SAVES_DIR, filename), JSON.stringify(template, null, 2), 'utf-8');
    return { success: true, filename };
  } catch (err) {
    console.error('[main] save-template error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('list-templates', () => {
  try {
    ensureSavesDir();
    const files = fs.readdirSync(SAVES_DIR).filter(f => f.endsWith('.json'));
    const list = [];
    for (const filename of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(SAVES_DIR, filename), 'utf-8'));
        list.push({
          filename,
          loadoutName: raw.loadoutName ?? filename,
          savedAt:     raw.savedAt ?? null,
          phaseCount:  Array.isArray(raw.phases) ? raw.phases.length : 0,
        });
      } catch { /* skip corrupt files */ }
    }
    // Most-recently saved first
    list.sort((a, b) => (b.savedAt ?? '') < (a.savedAt ?? '') ? -1 : 1);
    return { success: true, list };
  } catch (err) {
    console.error('[main] list-templates error:', err.message);
    return { success: false, list: [], error: err.message };
  }
});

ipcMain.handle('load-template', (event, { filename }) => {
  try {
    const filePath = path.join(SAVES_DIR, path.basename(filename)); // prevent path traversal
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return { success: true, template: raw };
  } catch (err) {
    console.error('[main] load-template error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-template', (event, { filename }) => {
  try {
    const filePath = path.join(SAVES_DIR, path.basename(filename));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  } catch (err) {
    console.error('[main] delete-template error:', err.message);
    return { success: false, error: err.message };
  }
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  loadSettings();
  createOverlayWindow();
  registerHotkeys();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
