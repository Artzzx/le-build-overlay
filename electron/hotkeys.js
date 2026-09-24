/**
 * electron/hotkeys.js
 * ────────────────────
 * Global (system-wide) shortcuts so the player can advance while the GAME has
 * focus. When the app window itself is focused, the track keys (1–6, their
 * undo variants and the latch key) are released so they reach the app's own
 * keyboard handling and text inputs — otherwise the OS would swallow every
 * digit typed into a textarea.
 *
 * Modes (settings.hotkeys.hotkeyMode):
 *   direct — lane keys (F1–F6 by default) always captured while the app is in the background
 *   latch  — only the latch key is captured; it arms the lane keys until LATCH_TIMEOUT_MS
 *            passes without an advance/undo (each use re-arms the timer)
 *
 * Which keys drive the lanes (F1–F6 / 1–6 / numpad + modifiers) comes from
 * shared/hotkey-scheme.js, the same module the UI uses for its keycaps.
 *
 * Every registration goes through safeRegister(): a malformed or already-taken
 * accelerator is reported, never thrown, and never blocks the other keys.
 *
 * Key auto-repeat: a held key re-fires a global shortcut ~30×/s. Every handler is
 * wrapped in repeatGuard(): an event less than REPEAT_GUARD_MS after the previous
 * event of the SAME accelerator is dropped (and still resets the clock), so a held
 * key can never burn through points or cycle phases. Deliberate taps are further
 * apart than that and all count.
 */

'use strict';

const { trackAccelerators } = require('../shared/hotkey-scheme');

const LATCH_TIMEOUT_MS = 5000;
const REPEAT_GUARD_MS = 110;

/**
 * @param {object} deps
 * @param {Electron.GlobalShortcut} deps.globalShortcut
 * @param {(event: object) => void} deps.emit   — forward { action, ... } to the renderer
 * @param {() => void} deps.toggleWindow        — show / hide the app window
 */
function createHotkeys({ globalShortcut, emit, toggleWindow, log = console, now = Date.now }) {
  let hk = null;              // current settings.hotkeys
  let suspended = false;      // app window focused → track keys released
  let paused = false;         // settings key recorder active → nothing registered
  let latchArmed = false;
  let latchTimer = null;
  let failures = [];
  const lastEvent = new Map(); // accelerator → time of its last event (repeat guard)

  function repeatGuard(accelerator, handler) {
    return () => {
      const t = now();
      const prev = lastEvent.get(accelerator);
      lastEvent.set(accelerator, t);
      if (prev != null && t - prev < REPEAT_GUARD_MS) return;
      handler();
    };
  }

  function safeRegister(accelerator, handler) {
    if (!accelerator) return false;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, repeatGuard(accelerator, handler));
    } catch (err) {
      log.error(`[hotkeys] invalid "${accelerator}": ${err.message}`);
    }
    if (!ok) {
      log.warn(`[hotkeys] could not register "${accelerator}"`);
      if (!failures.includes(accelerator)) failures.push(accelerator);
    }
    return ok;
  }

  function safeUnregister(accelerator) {
    if (!accelerator) return;
    try { globalShortcut.unregister(accelerator); } catch { /* invalid accelerator */ }
  }

  const trackKeys = () => trackAccelerators(hk);

  function onTrackKey(action, trackIndex) {
    emit({ action, trackIndex, source: 'global' });
    if (latchArmed) armLatchTimer();
  }

  function registerTrackKeys() {
    for (const { trackIndex, adv, undo } of trackKeys()) {
      safeRegister(adv, () => onTrackKey('advance', trackIndex));
      if (undo) safeRegister(undo, () => onTrackKey('undo', trackIndex));
    }
  }

  function unregisterTrackKeys() {
    for (const { adv, undo } of trackKeys()) {
      safeUnregister(adv);
      safeUnregister(undo);
    }
  }

  // ─── Latch mode ─────────────────────────────────────────────────────────────

  function armLatchTimer() {
    clearTimeout(latchTimer);
    latchTimer = setTimeout(disarmLatch, LATCH_TIMEOUT_MS);
  }

  function armLatch() {
    if (latchArmed) return;
    latchArmed = true;
    registerTrackKeys();
    emit({ action: 'latch', active: true });
    armLatchTimer();
  }

  function disarmLatch() {
    if (!latchArmed) return;
    clearTimeout(latchTimer);
    latchTimer = null;
    latchArmed = false;
    unregisterTrackKeys();
    emit({ action: 'latch', active: false });
  }

  // ─── Background-only keys (released while the app is focused) ──────────────

  function registerBackgroundKeys() {
    if (hk.hotkeyMode === 'latch') {
      safeRegister(hk.latchKey, () => (latchArmed ? disarmLatch() : armLatch()));
    } else {
      registerTrackKeys();
    }
  }

  function unregisterBackgroundKeys() {
    if (hk.hotkeyMode === 'latch') {
      disarmLatch();
      safeUnregister(hk.latchKey);
    } else {
      unregisterTrackKeys();
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** (Re)register everything for these hotkey settings. Returns failed accelerators. */
  function apply(hotkeySettings) {
    disarmLatch();
    globalShortcut.unregisterAll();
    hk = hotkeySettings;
    failures = [];
    if (!hk.enabled || paused) return failures;

    // Always-on keys
    safeRegister(hk.toggle, toggleWindow);
    safeRegister(hk.phaseNextKey, () => emit({ action: 'phase', direction: +1, source: 'global' }));
    safeRegister(hk.phasePrevKey, () => emit({ action: 'phase', direction: -1, source: 'global' }));

    if (!suspended) registerBackgroundKeys();
    return failures;
  }

  /** Called with true when the app window gains focus, false when it loses it. */
  function setSuspended(value) {
    if (value === suspended) return;
    suspended = value;
    if (!hk?.enabled || paused) return;
    if (suspended) unregisterBackgroundKeys();
    else registerBackgroundKeys();
  }

  /** Release every key (e.g. while the user records a new shortcut), then restore. */
  function pause(value) {
    if (value === paused) return;
    if (value) {
      disarmLatch();
      globalShortcut.unregisterAll();
      paused = true;
    } else {
      paused = false;
      if (hk) apply(hk);
    }
  }

  function dispose() {
    disarmLatch();
    globalShortcut.unregisterAll();
  }

  return { apply, setSuspended, pause, dispose, getFailures: () => [...failures] };
}

module.exports = { createHotkeys, LATCH_TIMEOUT_MS, REPEAT_GUARD_MS };
