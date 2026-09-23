/**
 * app/js/settings-dialog.js — display + global hotkey settings (Ctrl+,).
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';
import { keyRecorder, prettyAccelerator } from './keys.js';

const MODIFIERS = [['', 'None'], ['Alt', 'Alt'], ['Ctrl', 'Ctrl'], ['Shift', 'Shift']];

function field(label, hint, control) {
  return h('div.field', h('div.field-text', h('div.field-label', label), hint ? h('div.field-hint', hint) : null), h('div.field-control', control));
}

function toggle(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked, onchange: (e) => onChange(e.target.checked) });
  return h('label.switch', input, h('span.switch-track', h('span.switch-thumb')));
}

function select(options, value, onChange, label) {
  return h('select.select', { 'aria-label': label, onchange: (e) => onChange(e.target.value) },
    options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
}

/**
 * @param {object} o
 * @param {HTMLDialogElement} o.dialog
 * @param {object} o.settings, o.defaults
 * @param {(settings) => Promise<{ok, settings?, failedHotkeys?, error?}>} o.save
 * @param {(paused: boolean) => void} o.pauseHotkeys
 */
export function openSettings({ dialog, settings, defaults, save, pauseHotkeys }) {
  let draft = structuredClone(settings);
  const recorders = [];

  const status = h('div.dialog-status', { role: 'status' });
  const setStatus = (msg, kind = 'error') => { status.className = `dialog-status is-${kind}`; status.textContent = msg; };

  const rec = (path, { optional = false, single = false } = {}) => {
    const r = keyRecorder({
      value: draft.hotkeys[path],
      optional,
      single,
      onRecording: (on) => pauseHotkeys(on),
      onChange: (v) => { draft.hotkeys[path] = v; paint(); },
    });
    recorders.push(r);
    return r.el;
  };

  const body = h('div.dialog-body');

  function preview() {
    const k = draft.hotkeys;
    const combo = (mod, n) => (mod ? `${mod}+${n}` : `${n}`);
    const chips = (acc) => acc.split('+').map((p, i) => [i ? h('span.plus', '+') : null, h('kbd.key.key-sm', prettyAccelerator(p))]);
    if (!k.enabled) return h('div.hk-preview.is-off', 'Global hotkeys are off — use the app window or its keyboard shortcuts.');
    return h('div.hk-preview',
      k.hotkeyMode === 'latch'
        ? h('div', 'Press ', chips(k.latchKey || '?'), ' in game, then ', chips(combo(k.advanceModifier, 2)), ' allocates lane 2.')
        : h('div', 'In game, ', chips(combo(k.advanceModifier, 2)), ' allocates lane 2 and ', chips(combo(k.undoModifier, 2)), ' undoes it.'),
    );
  }

  function paint() {
    recorders.length = 0;
    const k = draft.hotkeys;
    const mode = (value, title, text) => h('label.mode-card', { class: k.hotkeyMode === value ? 'is-active' : '' },
      h('input', { type: 'radio', name: 'hk-mode', value, checked: k.hotkeyMode === value, onchange: () => { k.hotkeyMode = value; paint(); } }),
      h('span.mode-title', title), h('span.mode-text', text));

    mount(body,
      h('section.dialog-section',
        h('h3', 'Display'),
        field('Interface size', 'Bigger is easier to read from across the desk. Also Ctrl + / Ctrl −.',
          h('div.range-wrap',
            h('input.range', {
              type: 'range', min: 80, max: 160, step: 10, value: Math.round(draft.display.uiScale * 100), 'aria-label': 'Interface size',
              oninput: (e) => { draft.display.uiScale = Number(e.target.value) / 100; e.target.nextSibling.textContent = `${e.target.value}%`; },
            }),
            h('span.range-val', `${Math.round(draft.display.uiScale * 100)}%`))),
        field('Keep on top', 'Stay above other windows — handy next to a windowed game.',
          toggle(draft.display.alwaysOnTop, (v) => { draft.display.alwaysOnTop = v; }, 'Keep on top')),
      ),

      h('section.dialog-section',
        h('h3', 'Global hotkeys'),
        field('Enable global hotkeys', 'Allocate and undo while the game has focus. Released automatically while this window is focused, so typing here always works.',
          toggle(k.enabled, (v) => { k.enabled = v; paint(); }, 'Enable global hotkeys')),
        k.enabled ? [
          h('div.mode-cards',
            mode('direct', 'Direct', 'Number keys always allocate. Fastest — but digits in game chat are captured too.'),
            mode('latch', 'Arm first', 'Press the arm key, then numbers work for 5 s. Chat stays usable.'),
          ),
          k.hotkeyMode === 'latch' ? field('Arm key', 'Single key, pressed before a number.', rec('latchKey', { single: true })) : null,
          field('Allocate modifier', 'Held with 1–6 to allocate.', select(MODIFIERS, k.advanceModifier, (v) => { k.advanceModifier = v; paint(); }, 'Allocate modifier')),
          field('Undo modifier', 'Held with 1–6 to undo.', select(MODIFIERS, k.undoModifier, (v) => { k.undoModifier = v; paint(); }, 'Undo modifier')),
          field('Show / hide window', null, rec('toggle', { optional: true })),
          field('Next phase', null, rec('phaseNextKey', { optional: true })),
          field('Previous phase', null, rec('phasePrevKey', { optional: true })),
          preview(),
        ] : preview(),
      ),
    );
  }

  const close = () => { recorders.forEach(r => r.stop()); dialog.close(); };

  async function onSave() {
    const k = draft.hotkeys;
    if (k.enabled && k.advanceModifier === k.undoModifier) {
      return setStatus('Allocate and undo need different modifiers.');
    }
    if (k.enabled && k.hotkeyMode === 'latch' && !k.latchKey) {
      return setStatus('Pick an arm key for “Arm first” mode.');
    }
    const res = await save(draft);
    if (!res.ok) return setStatus(res.error || 'Could not save settings.');
    if (res.failedHotkeys?.length) {
      draft = structuredClone(res.settings);
      paint();
      return setStatus(`Saved — but ${res.failedHotkeys.map(prettyAccelerator).join(', ')} could not be registered (invalid, or used by another app).`, 'warn');
    }
    close();
  }

  mount(dialog,
    h('div.dialog-card.dialog-settings',
      h('header.dialog-head',
        h('h2', 'Settings'),
        h('button.btn-icon', { type: 'button', 'aria-label': 'Close', onclick: close }, ui('x', { size: 18 }))),
      body,
      h('footer.dialog-foot',
        status,
        h('div.dialog-foot-actions',
          h('button.btn.btn-ghost', { type: 'button', onclick: () => { draft = { ...structuredClone(defaults), window: draft.window }; paint(); setStatus('Defaults restored — Save to apply.', 'info'); } }, 'Reset defaults'),
          h('button.btn.btn-secondary', { type: 'button', onclick: close }, 'Cancel'),
          h('button.btn.btn-primary', { type: 'button', onclick: onSave }, 'Save'),
        ),
      ),
    ),
  );

  dialog.onclose = () => recorders.forEach(r => r.stop());
  paint();
  dialog.showModal();
}
