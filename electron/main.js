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
  registerHotkeys();
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
    height: 580,
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

// ─── Advance (latch) mode ─────────────────────────────────────────────────────

/**
 * Arm the 1–6 hotkeys for one session of advancing.
 * Called when the latch key is pressed in 'latch' hotkeyMode.
 * The overlay will show a visual "READY" indicator via IPC.
 */
function enterAdvanceMode() {
  if (advanceModeActive) return;
  advanceModeActive = true;

  const hk = settings.hotkeys;
  for (let i = 1; i <= 6; i++) {
    const trackIndex = i - 1;
    const advKey = hk.advanceModifier ? `${hk.advanceModifier}+${i}` : `${i}`;
    const undoKey = hk.undoModifier   ? `${hk.undoModifier}+${i}`   : `${i}`;

    if (advKey !== undoKey) {
      globalShortcut.register(advKey, () => {
        if (!overlayWin || !overlayVisible || inPositionMode) return;
        overlayWin.webContents.send('hotkey', { action: 'advance', trackIndex });
      });
    }
    globalShortcut.register(undoKey, () => {
      if (!overlayWin || !overlayVisible || inPositionMode) return;
      if (advKey === undoKey) {
        overlayWin.webContents.send('hotkey', { action: 'advance', trackIndex });
      } else {
        overlayWin.webContents.send('hotkey', { action: 'undo', trackIndex });
      }
    });
  }

  overlayWin?.webContents.send('advance-mode', { active: true });

  // Auto-deactivate after 5 seconds of inactivity
  clearTimeout(advanceModeTimer);
  advanceModeTimer = setTimeout(exitAdvanceMode, 5000);
}

/**
 * Disarm the 1–6 hotkeys and return to normal (non-intercepting) state.
 */
function exitAdvanceMode() {
  if (!advanceModeActive) return;
  clearTimeout(advanceModeTimer);
  advanceModeTimer = null;
  advanceModeActive = false;

  const hk = settings.hotkeys;
  for (let i = 1; i <= 6; i++) {
    const advKey = hk.advanceModifier ? `${hk.advanceModifier}+${i}` : `${i}`;
    const undoKey = hk.undoModifier   ? `${hk.undoModifier}+${i}`   : `${i}`;
    globalShortcut.unregister(advKey);
    if (advKey !== undoKey) globalShortcut.unregister(undoKey);
  }

  overlayWin?.webContents.send('advance-mode', { active: false });
}

// ─── Global hotkeys ──────────────────────────────────────────────────────────

function registerHotkeys() {
  const hk = settings.hotkeys;

  // Toggle overlay visibility
  globalShortcut.register(hk.toggle, () => {
    if (!overlayWin) return;
    overlayVisible = !overlayVisible;
    if (overlayVisible) {
      overlayWin.show();
    } else {
      overlayWin.hide();
    }
    overlayWin.webContents.send('hotkey', { action: 'toggle', visible: overlayVisible });
  });

  if (hk.hotkeyMode === 'latch') {
    // ── Latch mode: 1–6 are NOT registered globally; only the latch key is. ──
    // Pressing the latch key arms/disarms advance mode. While armed, 1–6 work
    // (registerAdvanceModeKeys is called dynamically), so normal typing is
    // never intercepted when the overlay is idle.
    if (hk.latchKey) {
      globalShortcut.register(hk.latchKey, () => {
        if (!overlayWin || !overlayVisible || inPositionMode) return;
        if (advanceModeActive) {
          exitAdvanceMode();
        } else {
          enterAdvanceMode();
        }
      });
    }
  } else {
    // ── Direct mode (default): 1–6 always registered, fire immediately. ─────
    for (let i = 1; i <= 6; i++) {
      const trackIndex = i - 1; // 0-based internally
      const advKey = hk.advanceModifier ? `${hk.advanceModifier}+${i}` : `${i}`;
      const undoKey = hk.undoModifier   ? `${hk.undoModifier}+${i}`   : `${i}`;

      // Skip registration if advance and undo keys conflict
      if (advKey !== undoKey) {
        globalShortcut.register(advKey, () => {
          if (!overlayWin || !overlayVisible || inPositionMode) return;
          overlayWin.webContents.send('hotkey', { action: 'advance', trackIndex });
        });
      }

      globalShortcut.register(undoKey, () => {
        if (!overlayWin || !overlayVisible || inPositionMode) return;
        // If advance and undo share the same key (no modifier), this acts as advance only
        if (advKey === undoKey) {
          overlayWin.webContents.send('hotkey', { action: 'advance', trackIndex });
        } else {
          overlayWin.webContents.send('hotkey', { action: 'undo', trackIndex });
        }
      });
    }
  }

  // Open settings window
  globalShortcut.register(hk.settingsKey, () => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.focus();
    } else {
      createSettingsWindow();
    }
  });

  // Open config window
  globalShortcut.register(hk.configKey, () => {
    if (configWin && !configWin.isDestroyed()) {
      configWin.focus();
    } else {
      createConfigWindow();
    }
  });

  // Toggle position mode (drag & resize overlay)
  globalShortcut.register(hk.positionKey, () => {
    if (!overlayWin || !overlayVisible) return;
    if (inPositionMode) {
      exitPositionMode();
    } else {
      enterPositionMode();
    }
  });

  // Phase switching — next / previous
  if (hk.phaseNextKey) {
    globalShortcut.register(hk.phaseNextKey, () => {
      if (!overlayWin || !overlayVisible || inPositionMode) return;
      overlayWin.webContents.send('hotkey', { action: 'phase', direction: +1 });
    });
  }
  if (hk.phasePrevKey) {
    globalShortcut.register(hk.phasePrevKey, () => {
      if (!overlayWin || !overlayVisible || inPositionMode) return;
      overlayWin.webContents.send('hotkey', { action: 'phase', direction: -1 });
    });
  }
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => settings);

ipcMain.handle('save-settings', (event, updated) => {
  try {
    saveSettings(updated);
    applySettings();
    return { success: true };
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

ipcMain.handle('load-build', async (event, { jsonString, buildName }) => {
  // Config window renderer sends raw Maxroll JSON → parse → save → notify overlay
  try {
    const { parseBuild, saveBuild } = require('../parser/maxroll');

    // Load DB files for name resolution (graceful fallback if not yet extracted)
    let skillsDb = {};
    let classesDb = { classes: {}, masteries: {} };
    try {
      const reconPath = path.join(__dirname, '..', 'db', 'data', 'skill_tree_reconciled.json');
      const rawNodes = JSON.parse(fs.readFileSync(reconPath, 'utf-8'));
      for (const { treeID, treeName, nodeID, nodeName, description, maxPoints, stats } of rawNodes) {
        if (!skillsDb[treeID]) skillsDb[treeID] = { name: treeName, nodes: {} };
        skillsDb[treeID].nodes[String(nodeID)] = { id: nodeID, nodeName, description, maxPoints, stats };
      }
    } catch { /* DB not yet extracted — skill names fall back to skillKey */ }
    try {
      const classesPath = path.join(__dirname, '..', 'db', 'data', 'classes.json');
      classesDb = JSON.parse(fs.readFileSync(classesPath, 'utf-8'));
    } catch { /* DB not yet extracted — class names fall back to IDs */ }

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

    let skillsDb = {};
    let classesDb = { classes: {}, masteriesByClass: {}, passiveTreeByClass: {} };
    try {
      const reconPath = path.join(__dirname, '..', 'db', 'data', 'skill_tree_reconciled.json');
      const rawNodes = JSON.parse(fs.readFileSync(reconPath, 'utf-8'));
      for (const { treeID, treeName, nodeID, nodeName, description, maxPoints, stats } of rawNodes) {
        if (!skillsDb[treeID]) skillsDb[treeID] = { name: treeName, nodes: {} };
        skillsDb[treeID].nodes[String(nodeID)] = { id: nodeID, nodeName, description, maxPoints, stats };
      }
    } catch { /* DB not yet extracted — skill names fall back to skillKey */ }
    try {
      const classesPath = path.join(__dirname, '..', 'db', 'data', 'classes.json');
      classesDb = JSON.parse(fs.readFileSync(classesPath, 'utf-8'));
    } catch { /* DB not yet extracted */ }

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

ipcMain.handle('fetch-build-url', async (event, url) => {
  // Config window requests a build from a Maxroll planner URL.
  // We fetch from the main process to avoid CORS restrictions in the renderer.
  try {
    const { fetchFromUrl } = require('../parser/fetch-build');
    const buildObj = await fetchFromUrl(url);
    // Return the raw Maxroll JSON string — config.js passes it straight to load-build
    return { success: true, json: JSON.stringify(buildObj) };
  } catch (err) {
    console.error('[main] fetch-build-url error:', err.message);
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
