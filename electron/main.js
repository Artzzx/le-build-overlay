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

let overlayWin = null;
let configWin = null;
let overlayVisible = true;

// Path to the user's active build config (runtime file, not a source file)
const BUILD_CONFIG_PATH = path.join(__dirname, '..', 'config', 'build.json');

// ─── Window creation ─────────────────────────────────────────────────────────

function createOverlayWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  overlayWin = new BrowserWindow({
    width: 260,
    height: 400,
    x: screenWidth - 270,   // right edge with 10px margin
    y: screenHeight - 620,  // above action bar
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

  overlayWin.on('closed', () => { overlayWin = null; });
}

function createConfigWindow() {
  // TODO: implement config window
  // This is a separate, focusable BrowserWindow that:
  //  - Loads overlay/config.html (to be created)
  //  - Has a textarea for Maxroll JSON paste
  //  - Has a "Build name" input and a "Load" button
  //  - On load: calls parser/maxroll.js, saves result to config/build.json,
  //             sends 'reload-build' IPC to overlay renderer
  //  - Closes itself after a successful load
  //
  // For now, log a placeholder
  console.log('[main] Config window not yet implemented — use F5 to open when ready');
}

// ─── Global hotkeys ──────────────────────────────────────────────────────────

function registerHotkeys() {
  // Toggle overlay visibility
  globalShortcut.register('F1', () => {
    if (!overlayWin) return;
    overlayVisible = !overlayVisible;
    if (overlayVisible) {
      overlayWin.show();
    } else {
      overlayWin.hide();
    }
    // Notify renderer so it can update any internal state
    overlayWin.webContents.send('hotkey', { action: 'toggle', visible: overlayVisible });
  });

  // Advance / undo tracks 1–6
  for (let i = 1; i <= 6; i++) {
    const trackIndex = i - 1; // 0-based internally

    globalShortcut.register(`${i}`, () => {
      if (!overlayWin || !overlayVisible) return;
      overlayWin.webContents.send('hotkey', { action: 'advance', trackIndex });
    });

    globalShortcut.register(`Shift+${i}`, () => {
      if (!overlayWin || !overlayVisible) return;
      overlayWin.webContents.send('hotkey', { action: 'undo', trackIndex });
    });
  }

  // Open config window
  globalShortcut.register('F5', () => {
    if (configWin && !configWin.isDestroyed()) {
      configWin.focus();
    } else {
      createConfigWindow();
    }
  });
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.on('save-build', (event, buildJson) => {
  // Renderer sends updated build state after each advance/undo so currentStep persists
  try {
    fs.writeFileSync(BUILD_CONFIG_PATH, JSON.stringify(buildJson, null, 2), 'utf-8');
  } catch (err) {
    console.error('[main] Failed to save build.json:', err);
  }
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createOverlayWindow();
  registerHotkeys();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
