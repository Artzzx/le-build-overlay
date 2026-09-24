/**
 * app/js/settings-dialog.js — display + global hotkey settings (Ctrl+,).
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';
import { keyRecorder } from './keys.js';
import { playCue } from './feedback.js';

const { hotkeyConflicts, laneKeyLabel, prettyAccelerator, LANE_KEYSET_LABELS } = window.HotkeyScheme;

const MODIFIERS = [['', 'None'], ['Alt', 'Alt'], ['Ctrl', 'Ctrl'], ['Shift', 'Shift']];

const LANE_KEY_HINTS = {
  fkeys: 'Games rarely use F1–F6. On a laptop you may need Fn Lock.',
  digits: 'Careful: while the planner runs, 1–6 are taken from the game and its chat (use “Arm first” below to avoid that).',
  numpad: 'Free in almost every game — needs a keyboard with a numpad and Num Lock on.',
};

/** Range slider with a live percentage label. */
function slider({ value, min, max, step, label, onInput }) {
  const out = h('span.range-val', `${value}%`);
  return h('div.range-wrap',
    h('input.range', {
      type: 'range', min, max, step, value, 'aria-label': label,
      oninput: (e) => { out.textContent = `${e.target.value}%`; onInput(Number(e.target.value)); },
    }),
    out);
}

function segmented(options, value, onChange, label) {
  return h('div.segmented.seg-field', { role: 'radiogroup', 'aria-label': label },
    options.map(([v, text]) => h('button.seg', {
      type: 'button', role: 'radio', 'aria-checked': String(v === value),
      class: v === value ? 'is-active' : '',
      onclick: () => onChange(v),
    }, text)));
}

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
    const chips = (acc) => acc.split('+').map((p, i) => [i ? h('span.plus', '+') : null, h('kbd.key.key-sm', prettyAccelerator(p))]);
    const lane2 = (kind) => chips(laneKeyLabel(k, 1, kind).replace(/Num /g, 'num'));
    if (!k.enabled) return h('div.hk-preview.is-off', 'Global hotkeys are off — use the app window or its keyboard shortcuts.');
    const clashes = hotkeyConflicts(k);
    return h('div.hk-preview', { class: clashes.length ? 'has-conflict' : '' },
      k.hotkeyMode === 'latch'
        ? h('div', 'Press ', chips(k.latchKey || '?'), ' in game, then ', lane2('adv'), ' allocates lane 2.')
        : h('div', 'In game, ', lane2('adv'), ' allocates lane 2 and ', lane2('undo'), ' undoes it.'),
      clashes.map(c => h('div.hk-conflict', ui('alert', { size: 13 }), ' ', chips(c.accelerator), ` is used twice: ${c.actions.join(' and ')}.`)),
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
          slider({ value: Math.round(draft.display.uiScale * 100), min: 80, max: 160, step: 10, label: 'Interface size', onInput: (v) => { draft.display.uiScale = v / 100; } })),
        field('Keep on top', 'Full window only — mini mode is always on top. Needs the game in Windowed or Borderless mode.',
          toggle(draft.display.alwaysOnTop, (v) => { draft.display.alwaysOnTop = v; }, 'Keep on top')),
        field('Mini mode opacity', 'See the game through the mini window (Ctrl+M). Windows and macOS.',
          slider({ value: Math.round(draft.display.opacity * 100), min: 35, max: 100, step: 5, label: 'Mini mode opacity', onInput: (v) => { draft.display.opacity = v / 100; } })),
      ),

      h('section.dialog-section',
        h('h3', 'Sound'),
        field('Hotkey sounds', 'A short cue when a global hotkey lands — a tick per point, a chime when a step or tree is done, a buzz when nothing happened.',
          toggle(draft.display.sound, (v) => { draft.display.sound = v; paint(); }, 'Hotkey sounds')),
        draft.display.sound
          ? field('Volume', null, h('div.range-wrap',
            slider({ value: Math.round(draft.display.volume * 100), min: 5, max: 100, step: 5, label: 'Volume', onInput: (v) => { draft.display.volume = v / 100; } }),
            h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => playCue('stepDone', draft.display.volume) }, ui('volume', { size: 14 }), 'Test')))
          : null,
      ),

      h('section.dialog-section',
        h('h3', 'Global hotkeys'),
        field('Enable global hotkeys', 'Allocate and undo while the game has focus. Released automatically while this window is focused, so typing here always works.',
          toggle(k.enabled, (v) => { k.enabled = v; paint(); }, 'Enable global hotkeys')),
        k.enabled ? [
          field('Lane keys', LANE_KEY_HINTS[k.laneKeys],
            segmented(Object.entries(LANE_KEYSET_LABELS), k.laneKeys, (v) => { k.laneKeys = v; paint(); }, 'Lane keys')),
          h('div.mode-cards',
            mode('direct', 'Direct', 'Lane keys always allocate while the game has focus. Fastest.'),
            mode('latch', 'Arm first', 'Press the arm key, then the lane keys work for 5 s. The game keeps them otherwise.'),
          ),
          k.hotkeyMode === 'latch' ? field('Arm key', 'Single key, pressed before a number.', rec('latchKey', { single: true })) : null,
          field('Allocate modifier', `Held with ${LANE_KEYSET_LABELS[k.laneKeys]} to allocate.`, select(MODIFIERS, k.advanceModifier, (v) => { k.advanceModifier = v; paint(); }, 'Allocate modifier')),
          field('Undo modifier', `Held with ${LANE_KEYSET_LABELS[k.laneKeys]} to undo.`, select(MODIFIERS, k.undoModifier, (v) => { k.undoModifier = v; paint(); }, 'Undo modifier')),
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
    const clashes = hotkeyConflicts(k);
    if (clashes.length) {
      return setStatus(`${prettyAccelerator(clashes[0].accelerator)} is assigned twice (${clashes[0].actions.join(' / ')}) — change one of them.`);
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
