/**
 * electron/preload.js
 * ────────────────────
 * The only bridge between the app window and the main process.
 * Exposes `window.api`; never exposes ipcRenderer itself (contextIsolation ON,
 * sandbox ON). Every invoke resolves to { ok: true, ... } or { ok: false, error }.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld('api', {
  init: () => invoke('app:init'),

  saveBuild: (build) => invoke('build:save', build),
  previewPhase: (json) => invoke('build:preview', { json }),
  loadLoadout: (phases, loadoutName, source, target) => invoke('build:load', { phases, loadoutName, source, target }),
  fetchMaxroll: (link) => invoke('maxroll:fetch', { link }),
  maxrollClipboardLink: () => invoke('maxroll:clipboardLink'),
  openMaxroll: (link) => invoke('maxroll:open', { link }),
  checkGuideUpdate: (manual) => invoke('maxroll:checkUpdate', { manual }),
  dismissGuideUpdate: (date) => invoke('maxroll:dismissUpdate', { date }),
  loadExample: () => invoke('build:example'),

  createProfile: (name) => invoke('profiles:create', { name }),
  switchProfile: (id) => invoke('profiles:switch', { id }),
  renameProfile: (id, name) => invoke('profiles:rename', { id, name }),
  deleteProfile: (id) => invoke('profiles:delete', { id }),

  changelog: () => invoke('app:changelog'),
  checkAppUpdate: () => invoke('appUpdate:check'),
  installAppUpdate: () => invoke('appUpdate:install'),
  /** App update state: { state: 'off'|'idle'|'checking'|'downloading'|'ready'|'available'|'error', version?, progress?, current } */
  onAppUpdate: (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('app-update', listener);
    return () => ipcRenderer.removeListener('app-update', listener);
  },

  saveSettings: (settings) => invoke('settings:save', settings),
  pauseHotkeys: (paused) => invoke('hotkeys:pause', { paused }),
  setWindowMode: (mode) => invoke('window:setMode', { mode }),

  listTemplates: () => invoke('templates:list'),
  saveTemplate: (loadoutName, phases) => invoke('templates:save', { loadoutName, phases }),
  loadTemplate: (filename) => invoke('templates:load', { filename }),
  deleteTemplate: (filename) => invoke('templates:delete', { filename }),

  /** Global hotkey events: { action: 'advance'|'undo'|'phase'|'latch', trackIndex?, direction?, active? } */
  onHotkey: (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('hotkey', listener);
    return () => ipcRenderer.removeListener('hotkey', listener);
  },
});
