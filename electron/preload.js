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
  loadLoadout: (phases, loadoutName, source) => invoke('build:load', { phases, loadoutName, source }),
  fetchMaxroll: (link) => invoke('maxroll:fetch', { link }),
  maxrollClipboardLink: () => invoke('maxroll:clipboardLink'),
  openMaxroll: (link) => invoke('maxroll:open', { link }),
  loadExample: () => invoke('build:example'),

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
