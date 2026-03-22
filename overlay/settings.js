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
  display: { fontSize: 13, opacity: 0.88, showDescription: true, alwaysShowProgress: false },
  hotkeys: { toggle: 'F1', advanceModifier: '', undoModifier: 'Shift', settingsKey: 'F2', configKey: 'F5', positionKey: 'F3' },
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const fontSizeEl      = document.getElementById('font-size');
const fontSizeVal     = document.getElementById('font-size-val');
const opacityEl       = document.getElementById('opacity');
const opacityVal      = document.getElementById('opacity-val');
const showDescEl      = document.getElementById('show-desc');
const alwaysProgressEl = document.getElementById('always-progress');
const hkToggle        = document.getElementById('hk-toggle');
const hkAdvMod        = document.getElementById('hk-advance-mod');
const hkUndoMod       = document.getElementById('hk-undo-mod');
const hkSettings      = document.getElementById('hk-settings');
const hkConfig        = document.getElementById('hk-config');
const hkPosition      = document.getElementById('hk-position');
const saveBtn         = document.getElementById('save-btn');
const resetBtn        = document.getElementById('reset-btn');
const statusEl        = document.getElementById('status');

// ─── Populate form ────────────────────────────────────────────────────────────

function populate(settings) {
  const s = settings ?? DEFAULTS;

  fontSizeEl.value = s.display.fontSize;
  fontSizeVal.textContent = s.display.fontSize;
  const opPct = Math.round(s.display.opacity * 100);
  opacityEl.value = opPct;
  opacityVal.textContent = `${opPct}%`;
  showDescEl.checked      = s.display.showDescription ?? true;
  alwaysProgressEl.checked = s.display.alwaysShowProgress ?? false;

  hkToggle.value    = s.hotkeys.toggle;
  hkAdvMod.value    = s.hotkeys.advanceModifier;
  hkUndoMod.value   = s.hotkeys.undoModifier;
  hkSettings.value  = s.hotkeys.settingsKey;
  hkConfig.value    = s.hotkeys.configKey;
  hkPosition.value  = s.hotkeys.positionKey ?? 'F3';
}

// ─── Read form → settings object ─────────────────────────────────────────────

function readForm() {
  // Preserve current window bounds from main (position mode manages these)
  return {
    window: {
      x:      null,
      y:      null,
      width:  DEFAULTS.window.width,
      height: DEFAULTS.window.height,
    },
    display: {
      fontSize:          parseInt(fontSizeEl.value, 10),
      opacity:           parseInt(opacityEl.value, 10) / 100,
      showDescription:   showDescEl.checked,
      alwaysShowProgress: alwaysProgressEl.checked,
    },
    hotkeys: {
      toggle:          hkToggle.value.trim()    || 'F1',
      advanceModifier: hkAdvMod.value,
      undoModifier:    hkUndoMod.value,
      settingsKey:     hkSettings.value.trim()  || 'F2',
      configKey:       hkConfig.value.trim()    || 'F5',
      positionKey:     hkPosition.value.trim()  || 'F3',
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
    // Fetch current window bounds from main so we don't overwrite them
    const current = await window.settingsAPI.getSettings();
    const form = readForm();
    // Preserve the window bounds that position mode manages
    form.window = current.window ?? DEFAULTS.window;

    const result = await window.settingsAPI.saveSettings(form);
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
