/**
 * electron/settings-preload.js
 * ─────────────────────────────
 * Secure IPC bridge for the settings window (settings.html).
 * Exposes window.settingsAPI to the renderer.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  /**
   * Fetch current settings from main process.
   * @returns {Promise<object>} settings object
   */
  getSettings: () => ipcRenderer.invoke('get-settings'),

  /**
   * Save updated settings to main process.
   * Main will persist, apply, and broadcast to overlay.
   * @param {object} settings - full settings object
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
});
