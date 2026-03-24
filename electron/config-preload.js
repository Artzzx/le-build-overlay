/**
 * electron/config-preload.js
 * ───────────────────────────
 * Preload script for the config window (overlay/config.html).
 * Exposes a minimal `window.configAPI` bridge for the config renderer.
 *
 * Security:
 *  - contextIsolation is ON (set in createConfigWindow)
 *  - nodeIntegration is OFF
 *  - Only the `loadBuild` invoke channel is exposed
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('configAPI', {
  /**
   * Parse and load a multi-phase loadout.
   * main.js validates, saves to config/build.json, and notifies the overlay.
   *
   * @param {Array<{ name: string, json: string }>} phases - one entry per phase
   * @param {string} loadoutName - optional display name for the loadout
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  loadLoadout: (phases, loadoutName) =>
    ipcRenderer.invoke('load-loadout', { phases, loadoutName }),

  /**
   * Parse and load a single-phase Maxroll build JSON string (legacy / compat).
   * @param {string} jsonString - raw Maxroll JSON (string)
   * @param {string} buildName  - optional display name for the build
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  loadBuild: (jsonString, buildName) =>
    ipcRenderer.invoke('load-build', { jsonString, buildName }),

  // ── Template save / load ─────────────────────────────────────────────────

  /** Save raw form inputs as a named template in config/saves/. */
  saveTemplate: (loadoutName, phases) =>
    ipcRenderer.invoke('save-template', { loadoutName, phases }),

  /** List all saved templates (metadata only — no raw JSON). */
  listTemplates: () =>
    ipcRenderer.invoke('list-templates'),

  /** Return the full template data for a given filename. */
  loadTemplate: (filename) =>
    ipcRenderer.invoke('load-template', { filename }),

  /** Permanently delete a saved template file. */
  deleteTemplate: (filename) =>
    ipcRenderer.invoke('delete-template', { filename }),
});
