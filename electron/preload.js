/**
 * electron/preload.js
 * ────────────────────
 * Runs in the renderer context BEFORE the page loads, with access to
 * Node.js APIs AND the DOM. Acts as a secure bridge between main and renderer.
 *
 * Security rules:
 *  - contextIsolation is ON (see main.js webPreferences)
 *  - nodeIntegration is OFF
 *  - We NEVER expose ipcRenderer directly — only wrap specific channels
 *  - Only expose the minimum surface area needed
 *
 * Exposes `window.electronAPI` to the renderer (overlay/app.js):
 *
 *   window.electronAPI.onHotkey(callback)
 *     → callback receives: { action: 'toggle'|'advance'|'undo', trackIndex?: number }
 *     → called whenever main.js sends a 'hotkey' IPC event
 *
 *   window.electronAPI.saveBuild(buildJson)
 *     → sends build JSON to main.js via 'save-build' channel
 *     → main.js writes it to config/build.json
 *
 *   window.electronAPI.onReloadBuild(callback)
 *     → callback fires when main sends 'reload-build' (after config window saves new build)
 *     → renderer should re-read build.json and re-render
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Subscribe to hotkey events from the main process.
   * @param {function} callback - receives { action, trackIndex?, visible? }
   */
  onHotkey: (callback) => {
    ipcRenderer.on('hotkey', (_event, payload) => callback(payload));
  },

  /**
   * Persist the current build state to disk via main process.
   * Called after every advance/undo so currentStep survives app restart.
   * @param {object} buildJson - full normalized build object (see build-schema.js)
   */
  saveBuild: (buildJson) => {
    ipcRenderer.send('save-build', buildJson);
  },

  /**
   * Subscribe to reload-build events (triggered when config window loads a new build).
   * @param {function} callback - no arguments; renderer should re-initialize from disk
   */
  onReloadBuild: (callback) => {
    ipcRenderer.on('reload-build', () => callback());
  },
});
