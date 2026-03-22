/**
 * overlay/settings.js
 * ────────────────────
 * Renderer script for the settings window (settings.html).
 * Loads current settings, populates the form, and saves on submit.
 *
 * Communicates with main.js exclusively via window.settingsAPI (settings-preload.js).
 */

'use strict';

const DEFAULTS = {
  window:  { x: null, y: null, width: 260, height: 400 },
  display: { fontSize: 13, opacity: 0.88 },
  hotkeys: { toggle: 'F1', advanceModifier: '', undoModifier: 'Shift', settingsKey: 'F2', configKey: 'F5' },
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const winX        = document.getElementById('win-x');
const winY        = document.getElementById('win-y');
const winWidth    = document.getElementById('win-width');
const winHeight   = document.getElementById('win-height');
const fontSizeEl  = document.getElementById('font-size');
const fontSizeVal = document.getElementById('font-size-val');
const opacityEl   = document.getElementById('opacity');
const opacityVal  = document.getElementById('opacity-val');
const hkToggle    = document.getElementById('hk-toggle');
const hkAdvMod    = document.getElementById('hk-advance-mod');
const hkUndoMod   = document.getElementById('hk-undo-mod');
const hkSettings  = document.getElementById('hk-settings');
const hkConfig    = document.getElementById('hk-config');
const saveBtn     = document.getElementById('save-btn');
const resetBtn    = document.getElementById('reset-btn');
const statusEl    = document.getElementById('status');

// ─── Populate form ────────────────────────────────────────────────────────────

function populate(settings) {
  const s = settings ?? DEFAULTS;

  winX.value    = s.window.x    ?? '';
  winY.value    = s.window.y    ?? '';
  winWidth.value  = s.window.width;
  winHeight.value = s.window.height;

  fontSizeEl.value = s.display.fontSize;
  fontSizeVal.textContent = s.display.fontSize;
  const opPct = Math.round(s.display.opacity * 100);
  opacityEl.value = opPct;
  opacityVal.textContent = `${opPct}%`;

  hkToggle.value   = s.hotkeys.toggle;
  hkAdvMod.value   = s.hotkeys.advanceModifier;
  hkUndoMod.value  = s.hotkeys.undoModifier;
  hkSettings.value = s.hotkeys.settingsKey;
  hkConfig.value   = s.hotkeys.configKey;
}

// ─── Read form → settings object ─────────────────────────────────────────────

function readForm() {
  return {
    window: {
      x:      winX.value.trim()     ? parseInt(winX.value, 10)     : null,
      y:      winY.value.trim()     ? parseInt(winY.value, 10)     : null,
      width:  parseInt(winWidth.value, 10)  || 260,
      height: parseInt(winHeight.value, 10) || 400,
    },
    display: {
      fontSize: parseInt(fontSizeEl.value, 10),
      opacity:  parseInt(opacityEl.value, 10) / 100,
    },
    hotkeys: {
      toggle:          hkToggle.value.trim()   || 'F1',
      advanceModifier: hkAdvMod.value,
      undoModifier:    hkUndoMod.value,
      settingsKey:     hkSettings.value.trim() || 'F2',
      configKey:       hkConfig.value.trim()   || 'F5',
    },
  };
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function showStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls;
  setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 2500);
}

// ─── Live preview for sliders ─────────────────────────────────────────────────

fontSizeEl.addEventListener('input', () => {
  fontSizeVal.textContent = fontSizeEl.value;
});
opacityEl.addEventListener('input', () => {
  opacityVal.textContent = `${opacityEl.value}%`;
});

// ─── Save ─────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  try {
    const result = await window.settingsAPI.saveSettings(readForm());
    if (result.success) {
      showStatus('Settings saved.', 'success');
    } else {
      showStatus(result.error || 'Failed to save settings.', 'error');
    }
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
  }
});

// ─── Reset defaults ───────────────────────────────────────────────────────────

resetBtn.addEventListener('click', () => {
  populate(DEFAULTS);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const settings = await window.settingsAPI.getSettings();
    populate(settings);
  } catch {
    populate(DEFAULTS);
  }
}

document.addEventListener('DOMContentLoaded', init);
