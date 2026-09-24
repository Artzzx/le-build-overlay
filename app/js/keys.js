/**
 * app/js/keys.js
 * ───────────────
 * Keyboard helpers: convert a KeyboardEvent into an Electron accelerator
 * string, and a "press a key" recorder button for the settings dialog.
 */

import { h } from './dom.js';

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

const CODE_MAP = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};

/** Electron accelerator key name for e.code (layout-independent), or null. */
function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_MAP[code] ?? null;
}

/** KeyboardEvent → "Ctrl+Shift+F6" (null for lone modifiers / unsupported keys). */
export function eventToAccelerator(e) {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = keyName(e.code);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return [...mods, key].join('+');
}

/** Pretty label for an accelerator (keeps it short for keycaps) — see shared/hotkey-scheme.js. */
export const prettyAccelerator = (acc) => window.HotkeyScheme.prettyAccelerator(acc);

/**
 * A button that records the next key combo pressed.
 * @param {object} o
 * @param {string} o.value            — current accelerator ('' = none)
 * @param {boolean} [o.optional]      — Backspace clears to ''
 * @param {boolean} [o.single]        — reject modifier combos (e.g. latch key)
 * @param {(recording: boolean) => void} o.onRecording — pause/resume global hotkeys
 * @param {(value: string) => void} [o.onChange]
 */
export function keyRecorder({ value, optional = false, single = false, onRecording, onChange }) {
  let current = value ?? '';
  let recording = false;

  const btn = h('button.key-recorder', { type: 'button' });
  const paint = (hint) => {
    btn.classList.toggle('is-recording', recording);
    btn.textContent = recording ? (hint ?? 'Press a key…') : prettyAccelerator(current);
    btn.title = recording
      ? `Esc to cancel${optional ? ' · Backspace to clear' : ''}`
      : 'Click, then press the key you want';
  };

  const stop = () => {
    if (!recording) return;
    recording = false;
    window.removeEventListener('keydown', onKey, true);
    onRecording(false);
    paint();
  };

  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stop();
    if (optional && (e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      current = '';
      onChange?.(current);
      return stop();
    }
    const acc = eventToAccelerator(e);
    if (!acc) return paint(MODIFIER_KEYS.has(e.key) ? `${e.key}+…` : 'Unsupported key');
    if (single && acc.includes('+')) return paint('Single key only');
    current = acc;
    onChange?.(current);
    stop();
  }

  btn.addEventListener('click', () => {
    if (recording) return stop();
    recording = true;
    onRecording(true);
    window.addEventListener('keydown', onKey, true);
    paint();
  });
  btn.addEventListener('blur', stop);

  paint();
  return { el: btn, get value() { return current; }, set value(v) { current = v ?? ''; paint(); }, stop };
}
