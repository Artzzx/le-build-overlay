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
   * Parse and load a Maxroll build JSON string.
   * main.js validates, saves to config/build.json, and notifies the overlay.
   *
   * @param {string} jsonString - raw Maxroll JSON (string)
   * @param {string} buildName  - optional display name for the build
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  loadBuild: (jsonString, buildName) =>
    ipcRenderer.invoke('load-build', { jsonString, buildName }),

  /**
   * Fetch a build from a Maxroll planner URL.
   * The actual HTTP request runs in the main process (avoids CORS).
   *
   * @param {string} url - e.g. https://maxroll.gg/last-epoch/planner/abc123
   * @returns {Promise<{ success: boolean, json?: string, error?: string }>}
   *   json is the raw Maxroll JSON string, ready to pass to loadBuild()
   */
  fetchBuildUrl: (url) =>
    ipcRenderer.invoke('fetch-build-url', url),
});
