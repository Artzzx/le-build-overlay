/**
 * shared/hotkey-scheme.js
 * ────────────────────────
 * The single source of truth for which keys drive the lanes. Used by the main
 * process (electron/hotkeys.js registers them), the settings dialog (conflict
 * check) and the renderer (keycaps, legend, shortcut sheet, in-app keys).
 *
 * UMD: require() in Node, window.HotkeyScheme in the renderer. Pure.
 *
 * settings.hotkeys fields used here:
 *   laneKeys         'fkeys' | 'digits' | 'numpad'   → F1–F6 | 1–6 | num1–num6
 *   advanceModifier  '' | 'Alt' | 'Ctrl' | 'Shift'
 *   undoModifier     same set, must differ from advanceModifier
 *   hotkeyMode, latchKey, toggle, phaseNextKey, phasePrevKey
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HotkeyScheme = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LANE_COUNT = 6;
  const LANE_KEYSETS = Object.freeze({ fkeys: 'F', digits: '', numpad: 'num' });
  const LANE_KEYSET_LABELS = Object.freeze({ fkeys: 'F1–F6', digits: '1–6', numpad: 'Numpad 1–6' });

  const prefix = (hk) => LANE_KEYSETS[hk?.laneKeys] ?? '';
  const combo = (mod, key) => (mod ? `${mod}+${key}` : key);

  /** Bare key for lane i (0-based): "F2", "2" or "num2". */
  function laneKey(hk, i) {
    return `${prefix(hk)}${i + 1}`;
  }

  /** Accelerators per lane: [{ trackIndex, adv, undo }] (undo null when identical to adv). */
  function trackAccelerators(hk) {
    const out = [];
    for (let i = 0; i < LANE_COUNT; i++) {
      const adv = combo(hk.advanceModifier, laneKey(hk, i));
      const undo = combo(hk.undoModifier, laneKey(hk, i));
      out.push({ trackIndex: i, adv, undo: undo === adv ? null : undo });
    }
    return out;
  }

  /** "num2" → "Num 2", "Super" → "Win". Short enough for keycaps. */
  function prettyAccelerator(acc) {
    if (!acc) return '—';
    return String(acc).replace(/num(\d)/gi, 'Num $1').replace('Super', 'Win');
  }

  /** Label for lane i's allocate (or undo) key, e.g. "F2", "Num 2", "Alt+2". */
  function laneKeyLabel(hk, i, kind = 'adv') {
    const mod = kind === 'undo' ? hk.undoModifier : hk.advanceModifier;
    return prettyAccelerator(combo(mod, laneKey(hk, i)));
  }

  const MOD_ALIASES = { control: 'ctrl', ctrl: 'ctrl', commandorcontrol: 'ctrl', cmdorctrl: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', super: 'super', meta: 'super', command: 'super', cmd: 'super' };

  /** Canonical form for comparing accelerators: lower case, modifiers sorted. */
  function normalize(acc) {
    const parts = String(acc).split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
    const key = parts.pop() ?? '';
    const mods = [...new Set(parts.map(p => MOD_ALIASES[p] ?? p))].sort();
    return [...mods, key].join('+');
  }

  /**
   * Accelerators bound to more than one action.
   * @returns {{ accelerator: string, actions: string[] }[]}  (empty when hotkeys are off)
   */
  function hotkeyConflicts(hk) {
    if (!hk?.enabled) return [];
    const uses = new Map();
    const add = (acc, action) => {
      if (!acc) return;
      const k = normalize(acc);
      if (!uses.has(k)) uses.set(k, { accelerator: acc, actions: [] });
      uses.get(k).actions.push(action);
    };
    for (const { trackIndex, adv, undo } of trackAccelerators(hk)) {
      add(adv, `Allocate lane ${trackIndex + 1}`);
      add(undo, `Undo lane ${trackIndex + 1}`);
    }
    if (hk.hotkeyMode === 'latch') add(hk.latchKey, 'Arm key');
    add(hk.toggle, 'Show / hide');
    add(hk.phaseNextKey, 'Next phase');
    add(hk.phasePrevKey, 'Previous phase');
    return [...uses.values()].filter(u => u.actions.length > 1);
  }

  /**
   * In-app key → lane index for the configured lane keys (F-keys / numpad), or -1.
   * Digits are handled by the app regardless of the setting.
   */
  function laneFromCode(hk, code) {
    const m = prefix(hk) === 'F' ? /^F([1-6])$/.exec(code) : prefix(hk) === 'num' ? /^Numpad([1-6])$/.exec(code) : null;
    return m ? Number(m[1]) - 1 : -1;
  }

  return {
    LANE_COUNT, LANE_KEYSETS, LANE_KEYSET_LABELS,
    laneKey, trackAccelerators, laneKeyLabel, prettyAccelerator, normalize, hotkeyConflicts, laneFromCode,
  };
}));
