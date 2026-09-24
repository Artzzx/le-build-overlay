/**
 * app/js/main.js
 * ───────────────
 * App shell: state, actions, and orchestration of the views.
 *
 *   ┌ topbar ─ build · phase switcher · overall progress · actions ─────────┐
 *   ├ banner ─ phase-change instructions (unspec / remove skills)           │
 *   ├ lanes (passive + skills) ───────────────────────┬ inspector ──────────┤
 *   └ statusbar ─ last action (+undo) · hotkey legend · warnings ───────────┘
 *
 * Mini mode (settings.display.mode = 'compact', Ctrl+M) swaps the lanes for
 * one-line rows (mini.js) and hides the inspector and legend; main.js in the
 * electron folder resizes the window and keeps it on top.
 *
 * State changes go through commit(), which persists the build and re-renders
 * only what changed. All pure logic lives in shared/ (TreeUtils, ViewModel).
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';
import { renderLane, revealCurrent, keycap, laneAccent } from './lanes.js';
import { renderMiniLane } from './mini.js';
import { playCue } from './feedback.js';
import { renderInspector } from './inspector.js';
import { openLoadout } from './loadout-dialog.js';
import { openSettings } from './settings-dialog.js';
import { openHelp } from './help-dialog.js';
import { createToaster } from './toast.js';

const { laneKeyLabel, laneKey, laneFromCode, prettyAccelerator, LANE_KEYSET_LABELS } = window.HotkeyScheme;
let toast = () => {}; // set in boot() once the container exists

const { normalizeBuild, stepTrack, setTrackProgress, computeTransition, applyCarryOver } = window.TreeUtils;
const { buildView, stepStartProgress } = window.ViewModel;
const api = window.api;


// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  db: null,            // { passives, skills, classes } — same shape TreeUtils expects
  build: null,         // multi-phase loadout
  view: null,          // ViewModel.buildView(build, db)
  settings: null,
  defaults: null,
  missingData: [],     // required game-data files not found
  failedHotkeys: [],
  focusLane: 0,        // keyboard / inspector focus
  pinned: null,        // { lane, step } — clicked node
  hover: null,         // { lane, step } — hovered node (transient)
  transition: null,    // { toName, unspecNeeded } after a phase switch
  latch: false,        // global hotkeys armed (latch mode)
  undoStack: [],       // [{ phase, lane, prev }] — Ctrl+Z / "Undo" in the status bar, newest last
  lastAction: null,    // { lane, sign, amount, title, detail, accent } — status bar chip
};

const UNDO_LIMIT = 50;

const $ = (id) => document.getElementById(id);
const els = {};

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  for (const id of ['topbar', 'banner', 'workspace', 'lanes', 'inspector', 'statusbar', 'toasts', 'dlg-loadout', 'dlg-settings', 'dlg-help']) {
    els[id] = $(id);
  }
  toast = createToaster(els.toasts);

  const res = await api.init();
  if (!res.ok) {
    mount(els.workspace, h('div.fatal', ui('alert', { size: 28 }), h('h2', 'Could not start'), h('p', res.error)));
    return;
  }

  const trees = res.db.trees;
  state.db = { passives: trees, skills: trees, classes: res.db.classes };
  state.build = normalizeBuild(res.build);
  state.settings = res.settings;
  state.defaults = res.defaultSettings;
  state.missingData = res.missingData ?? [];
  state.failedHotkeys = res.failedHotkeys ?? [];

  api.onHotkey(onGlobalHotkey);
  document.addEventListener('keydown', onKeyDown);
  // One reveal per frame while resizing, not one per resize event.
  let revealQueued = false;
  window.addEventListener('resize', () => {
    if (revealQueued) return;
    revealQueued = true;
    requestAnimationFrame(() => { revealQueued = false; revealAll(false); });
  });

  renderAll();
  requestAnimationFrame(() => revealAll(false));
  document.body.classList.add('is-ready');
}

// ─── Derived ──────────────────────────────────────────────────────────────────

function refreshView() {
  state.view = state.build ? buildView(state.build, state.db) : null;
  if (state.view) state.focusLane = Math.min(state.focusLane, state.view.lanes.length - 1);
}

const lanes = () => state.view?.lanes ?? [];

function inspectorContext() {
  const pick = state.hover ?? state.pinned;
  if (pick) {
    const lane = lanes()[pick.lane];
    const step = lane?.steps[pick.step];
    if (step) return { lane, step, mode: state.hover ? 'hover' : 'pinned' };
  }
  const focus = lanes()[state.focusLane];
  const lane = focus?.now ? focus : lanes().find(l => l.now && !l.unresolved);
  return lane?.now ? { lane, step: lane.now, mode: 'next' } : null;
}

const isCompact = () => state.settings?.display.mode === 'compact';

/** Key shown on a lane: the in-game key when global hotkeys are on, else the in-app digit. */
function hotkeyLabel(index, kind = 'adv') {
  const hk = state.settings?.hotkeys;
  if (hk?.enabled) return laneKeyLabel(hk, index, kind);
  return kind === 'undo' ? `Shift+${index + 1}` : String(index + 1);
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Replace the build, persist it, and re-render.
 * @param {object} next
 * @param {object} [o] — { lanes: number[] } re-render only these lanes; { flash } lane to flash
 */
function commit(next, o = {}) {
  if (!next || next === state.build) return false;
  state.build = next;
  refreshView();
  api.saveBuild(next).then(r => { if (!r.ok) toast(`Couldn’t save progress: ${r.error}`, { kind: 'error' }); });
  if (o.lanes) {
    o.lanes.forEach(i => renderLaneAt(i, { smooth: true }));
    renderTopbar();
    renderInspectorPanel();
  } else {
    renderAll();
    requestAnimationFrame(() => revealAll(true));
  }
  if (o.flash != null) flashLane(o.flash);
  document.title = `${state.build.name} — LE Build Planner`;
  return true;
}

/**
 * Move lane i by one point (delta ±1) — or, with `fill`, to the end of its
 * current step. `source: 'global'` = a hotkey pressed while the game had focus:
 * those get a sound cue, since the player is not looking at this window.
 */
function allocate(i, delta, { source = 'app', fill = false } = {}) {
  const lane = lanes()[i];
  if (!lane) return;
  const cue = (name) => { if (source === 'global' && state.settings.display.sound) playCue(name, state.settings.display.volume); };
  if (lane.unresolved) {
    cue('denied');
    toast(`${lane.title} has no tree data — it can’t be tracked yet.`, { kind: 'warn' });
    return;
  }
  const phase = state.build.currentPhase;
  const prev = state.build.phases[phase].tracks[i].currentStep;
  const next = fill && delta > 0 && lane.now
    ? setTrackProgress(state.build, i, lane.now.startIdx + lane.now.count)
    : stepTrack(state.build, i, delta);

  const prevFocus = state.focusLane;
  state.focusLane = i;
  const hadPin = state.pinned;
  state.pinned = null;
  if (state.transition) dismissTransition(false);
  const changed = commit(next, {
    lanes: [...new Set([i, prevFocus, hadPin?.lane].filter(n => n != null))],
    flash: delta > 0 ? i : null,
  });
  if (!changed) {
    cue('denied');
    if (delta > 0 && lane.complete) toast(`${lane.title} is already complete.`);
    // Still reflect the focus change.
    [i, prevFocus].forEach(n => renderLaneAt(n));
    renderInspectorPanel();
    return;
  }

  const after = lanes()[i];
  pushUndo({ phase, lane: i, prev });
  const treeDone = after.complete && !lane.complete;
  const stepDone = delta > 0 && after.nowIdx !== lane.nowIdx;
  cue(delta < 0 ? 'undo' : treeDone ? 'treeDone' : stepDone ? 'stepDone' : 'allocate');
  setLastAction(lane, after, after.done - lane.done);
  if (treeDone) celebrate(after);
}

function pushUndo(entry) {
  state.undoStack.push(entry);
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
}

/** Revert the most recent point change in this phase, whichever tree it was in (Ctrl+Z). */
function undoLast() {
  const phase = state.build?.currentPhase;
  while (state.undoStack.length && state.undoStack[state.undoStack.length - 1].phase !== phase) state.undoStack.pop();
  const entry = state.undoStack.pop();
  if (!entry) {
    toast('Nothing to undo.', { duration: 1800 });
    return;
  }
  const before = lanes()[entry.lane];
  state.pinned = null;
  state.focusLane = entry.lane;
  if (commit(setTrackProgress(state.build, entry.lane, entry.prev), { lanes: [entry.lane] })) {
    const after = lanes()[entry.lane];
    setLastAction(before, after, after.done - before.done, { undone: true });
  } else {
    renderStatusbar();
  }
}

/** Status bar chip: what the last key press did, so a global press can be checked at a glance. */
function setLastAction(before, after, amount, { undone = false } = {}) {
  if (!amount) return;
  // Added points: the step they went into. Removed: the step they came out of.
  const step = amount > 0 ? before.now : (after.now ?? after.steps[after.steps.length - 1]);
  let detail = step?.name ?? '';
  if (amount > 0 && step?.maxPoints) {
    const inNode = step.nodeTotalAfter - step.count + Math.min(step.count, step.pointsDone + amount);
    detail += ` ${inNode}/${step.maxPoints}`;
  }
  state.lastAction = {
    lane: after.index,
    sign: amount > 0 ? '+' : '−',
    amount: Math.abs(amount),
    title: after.title,
    detail,
    undone,
    accent: laneAccent(after),
    complete: after.complete,
  };
  renderStatusbar();
}

/** Tree complete → toast; whole phase complete → offer the next phase. */
function celebrate(lane) {
  const all = lanes();
  const phaseDone = all.every(l => l.complete || l.unresolved);
  const v = state.view;
  if (!phaseDone) {
    toast(`${lane.title}${lane.type === 'passive' ? ' passives' : ''} complete ✓`, { kind: 'success' });
    return;
  }
  const nextPhase = v.phases[v.currentPhase + 1];
  if (nextPhase) {
    toast(`${v.phases[v.currentPhase].name} complete — every tree is done.`, {
      kind: 'success',
      duration: 12000,
      action: { label: `Go to ${nextPhase.name}`, run: () => gotoPhase(nextPhase.index) },
    });
  } else {
    toast(`Build complete — all ${v.total} points allocated. GG!`, { kind: 'success', duration: 8000 });
  }
}

function setCurrent(laneIdx, stepIdx) {
  const phase = state.build.currentPhase;
  const track = state.build.phases[phase].tracks[laneIdx];
  const previousStep = track.currentStep;
  state.pinned = null;
  state.focusLane = laneIdx;
  if (commit(setTrackProgress(state.build, laneIdx, stepStartProgress(track, stepIdx)), { lanes: [laneIdx] })) {
    const lane = lanes()[laneIdx];
    pushUndo({ phase, lane: laneIdx, prev: previousStep });
    toast(`${lane.title}: now at step ${stepIdx + 1} of ${lane.steps.length}.`, {
      // Undo only this tree's progress — never clobber points allocated elsewhere since.
      action: {
        label: 'Undo',
        run: () => {
          if (state.build.currentPhase !== phase) return;
          commit(setTrackProgress(state.build, laneIdx, previousStep), { lanes: [laneIdx] });
        },
      },
    });
  }
}

function gotoPhase(to) {
  const b = state.build;
  if (!b || b.phases.length < 2) return;
  const total = b.phases.length;
  to = ((to % total) + total) % total;
  if (to === b.currentPhase) return;
  const from = b.currentPhase;
  const targetBefore = b.phases[to];
  const transition = computeTransition(b.phases, from, to);
  state.pinned = null;
  state.hover = null;
  state.focusLane = 0;
  state.lastAction = null;
  // Carry-over rewrites the target phase's progress: its old undo entries no longer apply.
  state.undoStack = state.undoStack.filter(u => u.phase !== to);
  commit({ ...b, currentPhase: to, phases: applyCarryOver(b.phases, from, to) });
  if (transition.unspecNeeded.length || transition.masteryChange) {
    state.transition = transition;
    renderBanner();
  } else {
    dismissTransition();
  }
  toast(`Switched to ${transition.toName}.`, {
    action: {
      label: 'Undo',
      // Go back and restore the target phase's pre-switch progress; ignored if the user has moved on.
      run: () => {
        if (state.build.currentPhase !== to) return;
        dismissTransition();
        state.undoStack = state.undoStack.filter(u => u.phase !== to);
        state.lastAction = null;
        commit({ ...state.build, currentPhase: from, phases: state.build.phases.map((p, i) => (i === to ? targetBefore : p)) });
      },
    },
  });
}

function dismissTransition(render = true) {
  state.transition = null;
  if (render) renderBanner();
}

function setUiScale(scale) {
  const uiScale = Math.round(Math.min(1.6, Math.max(0.8, scale)) * 10) / 10;
  if (uiScale === state.settings.display.uiScale) return;
  saveSettings({ ...state.settings, display: { ...state.settings.display, uiScale } }).then(r => {
    if (r.ok) toast(`Interface size ${Math.round(uiScale * 100)}%`, { duration: 1500 });
  });
}

function resetHistory() {
  state.undoStack = [];
  state.lastAction = null;
}

/** Full window ↔ mini mode. Main resizes the window; the renderer swaps layouts. */
async function toggleMiniMode() {
  const mode = isCompact() ? 'full' : 'compact';
  const res = await api.setWindowMode(mode);
  if (!res.ok) return toast(`Couldn’t switch layout: ${res.error}`, { kind: 'error' });
  state.settings = res.settings;
  state.pinned = null;
  state.hover = null;
  renderAll();
  requestAnimationFrame(() => revealAll(false));
}

function toggleOnTop() {
  const alwaysOnTop = !state.settings.display.alwaysOnTop;
  saveSettings({ ...state.settings, display: { ...state.settings.display, alwaysOnTop } }).then(r => {
    if (r.ok) toast(alwaysOnTop ? 'Window stays on top.' : 'Window no longer stays on top.', { duration: 2000 });
  });
}

async function saveSettings(next) {
  const res = await api.saveSettings(next);
  if (res.ok) {
    state.settings = res.settings;
    state.failedHotkeys = res.failedHotkeys ?? [];
    renderTopbar();
    renderStatusbar();
    lanes().forEach((_, i) => renderLaneAt(i));
  }
  return res;
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

function showLoadout() {
  if (els['dlg-loadout'].open) return;
  openLoadout({
    dialog: els['dlg-loadout'],
    api,
    trees: state.db?.skills ?? {},
    currentSource: state.build?.source ?? null,
    hasProgress: lanes().some(l => l.done > 0),
    onLoaded(build) {
      state.pinned = null;
      state.hover = null;
      state.focusLane = 0;
      state.transition = null;
      resetHistory();
      state.build = null; // force full render
      commit(normalizeBuild(build));
      renderBanner();
      toast(`Loaded “${build.name}”.`, { kind: 'success' });
    },
  });
}

function showSettings() {
  if (els['dlg-settings'].open) return;
  openSettings({
    dialog: els['dlg-settings'],
    settings: state.settings,
    defaults: state.defaults,
    save: saveSettings,
    pauseHotkeys: (paused) => api.pauseHotkeys(paused),
  });
}

async function loadExample() {
  const res = await api.loadExample();
  if (!res.ok) return toast(`Couldn’t load the example: ${res.error}`, { kind: 'error' });
  resetHistory();
  state.build = null;
  commit(normalizeBuild(res.build));
  toast('Example build loaded — replace it with yours any time (Ctrl+O).');
}

// ─── Input ────────────────────────────────────────────────────────────────────

function onGlobalHotkey(e) {
  if (e.action === 'latch') {
    state.latch = e.active;
    if (state.settings.display.sound) playCue(e.active ? 'armed' : 'disarmed', state.settings.display.volume);
    renderTopbar();
    return;
  }
  if (!state.build) return;
  const source = e.source ?? 'global';
  if (e.action === 'advance') allocate(e.trackIndex, +1, { source });
  else if (e.action === 'undo') allocate(e.trackIndex, -1, { source });
  else if (e.action === 'phase') gotoPhase(state.build.currentPhase + e.direction);
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function onKeyDown(e) {
  if (document.querySelector('dialog[open]')) return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl) {
    // Ctrl+1–6 / Ctrl+Enter: put every remaining point of the step in.
    const fillDigit = /^(Digit|Numpad)([1-6])$/.exec(e.code);
    if (fillDigit && state.view && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (!e.repeat) allocate(Number(fillDigit[2]) - 1, +1, { fill: true });
      return;
    }
    const actions = {
      KeyO: showLoadout,
      Comma: showSettings,
      KeyM: toggleMiniMode,
      KeyZ: () => { if (state.view && !e.shiftKey) undoLast(); },
      Enter: () => { if (state.view && !e.repeat) allocate(state.focusLane, +1, { fill: true }); },
      Equal: () => setUiScale(state.settings.display.uiScale + 0.1),
      NumpadAdd: () => setUiScale(state.settings.display.uiScale + 0.1),
      Minus: () => setUiScale(state.settings.display.uiScale - 0.1),
      NumpadSubtract: () => setUiScale(state.settings.display.uiScale - 0.1),
      Digit0: () => setUiScale(1),
    };
    if (actions[e.code]) { e.preventDefault(); actions[e.code](); }
    return;
  }
  if (isTyping(e.target) || e.altKey) return;

  // Shortcut sheet: "?" anywhere, F1 when F-keys aren't the lane keys.
  if (e.key === '?' || (e.code === 'F1' && state.settings?.hotkeys.laneKeys !== 'fkeys')) {
    e.preventDefault();
    showHelp();
    return;
  }
  if (!state.view) return;

  // Lane keys: digits always; the in-game lane keys (F1–F6 / numpad) too, so
  // the same fingers work whether the game or this window has focus.
  const digit = /^(Digit|Numpad)([1-6])$/.exec(e.code);
  const laneKeyIdx = laneFromCode(state.settings.hotkeys, e.code);
  if (digit || laneKeyIdx >= 0) {
    e.preventDefault();
    if (e.repeat) return; // holding a key must never burn through points
    allocate(digit ? Number(digit[2]) - 1 : laneKeyIdx, e.shiftKey ? -1 : +1);
    return;
  }

  const onButton = e.target instanceof HTMLButtonElement;
  const focus = state.focusLane;
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      e.preventDefault();
      const n = lanes().length;
      const prev = state.focusLane;
      state.focusLane = (focus + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      if (state.pinned) { state.pinned = null; }
      renderLaneAt(prev);
      renderLaneAt(state.focusLane);
      els.lanes.querySelector(`[data-lane="${state.focusLane}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      renderInspectorPanel();
      break;
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      e.preventDefault();
      const lane = lanes()[focus];
      if (!lane?.steps.length) break;
      const from = state.pinned?.lane === focus ? state.pinned.step : (lane.now?.idx ?? lane.steps.length - 1);
      const step = Math.min(lane.steps.length - 1, Math.max(0, from + (e.key === 'ArrowRight' ? 1 : -1)));
      pin(focus, step, { reveal: true });
      break;
    }
    case 'Enter':
    case ' ':
      if (onButton) return; // let the focused button activate itself
      e.preventDefault();
      if (!e.repeat) allocate(focus, +1);
      break;
    case 'Backspace':
      e.preventDefault();
      if (!e.repeat) allocate(focus, -1);
      break;
    case 'Escape':
      // Never leaves mini mode: Esc is the game's menu key, a stray press must not
      // blow the window up over the game.
      if (state.pinned) unpin();
      else if (state.transition) dismissTransition();
      break;
    case 'PageDown':
      e.preventDefault();
      gotoPhase(state.build.currentPhase + 1);
      break;
    case 'PageUp':
      e.preventDefault();
      gotoPhase(state.build.currentPhase - 1);
      break;
    default:
  }
}

function pin(laneIdx, stepIdx, { reveal = false } = {}) {
  const prev = state.pinned;
  const same = prev && prev.lane === laneIdx && prev.step === stepIdx;
  state.pinned = same && !reveal ? null : { lane: laneIdx, step: stepIdx };
  const prevFocus = state.focusLane;
  state.focusLane = laneIdx;
  new Set([laneIdx, prev?.lane, prevFocus].filter(n => n != null)).forEach(n => renderLaneAt(n));
  if (reveal) revealCurrent(laneEl(laneIdx), { stepIdx, smooth: true });
  renderInspectorPanel();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderAll() {
  refreshView();
  document.body.classList.toggle('has-build', !!state.view);
  document.body.classList.toggle('is-compact', isCompact());
  document.title = state.build ? `${state.build.name} — LE Build Planner` : 'LE Build Planner';
  renderTopbar();
  renderBanner();
  renderWorkspace();
  renderStatusbar();
}

/** The global phase key when set (and hotkeys are on), else the in-app key. */
function phaseKeyLabel(acc, inApp) {
  return state.settings.hotkeys.enabled && acc ? prettyAccelerator(acc) : inApp;
}

function renderTopbar() {
  const v = state.view;
  const actions = h('div.top-actions',
    state.latch ? h('span.latch-pill', { title: 'Global number keys are armed' }, h('span.pulse'), 'Hotkeys armed') : null,
    h('button.btn.btn-secondary', { type: 'button', onclick: showLoadout, title: 'Load build (Ctrl+O)' }, ui('upload', { size: 16 }), h('span.btn-text', v ? 'Load build' : 'Load')),
    h('button.btn-icon', { type: 'button', onclick: toggleMiniMode, title: 'Mini mode — small, always on top (Ctrl+M)', 'aria-label': 'Switch to mini mode' }, ui('shrink', { size: 18 })),
    h('button.btn-icon', {
      type: 'button', onclick: toggleOnTop,
      class: state.settings?.display.alwaysOnTop ? 'is-on' : '',
      'aria-pressed': String(!!state.settings?.display.alwaysOnTop),
      title: state.settings?.display.alwaysOnTop ? 'Keep on top: on' : 'Keep on top: off',
      'aria-label': 'Keep window on top',
    }, ui('pin', { size: 18 })),
    h('button.btn-icon', { type: 'button', onclick: showSettings, title: 'Settings (Ctrl+,)', 'aria-label': 'Settings' }, ui('gear', { size: 18 })),
  );

  if (isCompact()) {
    mount(els.topbar, miniTopbar(v));
    return;
  }

  if (!v) {
    mount(els.topbar, h('div.brand', h('span.brand-mark', ui('sparkles', { size: 18 })), h('span.brand-name', 'LE Build Planner')), h('div.top-spacer'), actions);
    return;
  }

  const pct = Math.round(v.pct * 100);
  const phaseSwitcher = v.phases.length > 1
    ? h('nav.phase-switch', { 'aria-label': 'Phases' },
      h('button.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Previous phase', title: `Previous phase (${phaseKeyLabel(state.settings.hotkeys.phasePrevKey, 'PgUp')})`, onclick: () => gotoPhase(v.currentPhase - 1) }, ui('chevronLeft', { size: 16 })),
      h('div.segmented', { role: 'tablist' },
        v.phases.map(p => h('button.seg', {
          type: 'button', role: 'tab', 'aria-selected': String(p.index === v.currentPhase),
          title: p.masteryName ?? state.db.classes.classes?.[state.build.classId] ?? '',
          class: p.index === v.currentPhase ? 'is-active' : '',
          onclick: () => gotoPhase(p.index),
        }, p.name))),
      h('button.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Next phase', title: `Next phase (${phaseKeyLabel(state.settings.hotkeys.phaseNextKey, 'PgDn')})`, onclick: () => gotoPhase(v.currentPhase + 1) }, ui('chevronRight', { size: 16 })))
    : null;

  mount(els.topbar,
    h('div.brand',
      h('span.brand-mark', ui('sparkles', { size: 18 })),
      h('div.brand-text',
        h('div.build-name', { title: v.name }, v.name),
        h('div.build-class', v.classLabel))),
    phaseSwitcher,
    h('div.top-spacer'),
    h('div.overall', { title: `${v.done} of ${v.total} points in this phase` },
      h('span.ring', { style: { '--p': v.pct.toFixed(3) } }, h('span.ring-val', `${pct}%`)),
      h('div.overall-text', h('b', `${v.done} / ${v.total}`), h('span', 'points this phase'))),
    actions,
  );
}

/** Mini mode header: phase (with arrows) · points · expand / settings. */
function miniTopbar(v) {
  const multi = v && v.phases.length > 1;
  const arrow = (dir) => h('button.btn-icon.btn-xs', {
    type: 'button', 'aria-label': dir < 0 ? 'Previous phase' : 'Next phase',
    onclick: () => gotoPhase(v.currentPhase + dir),
  }, ui(dir < 0 ? 'chevronLeft' : 'chevronRight', { size: 14 }));
  return [
    h('div.mini-head',
      multi ? arrow(-1) : null,
      h('div.mini-phase', { title: v ? `${v.name} · ${v.classLabel}` : '' },
        h('span.mini-phase-name', v ? (multi ? v.phases[v.currentPhase].name : v.name) : 'LE Build Planner'),
        v ? h('span.mini-phase-pts', `${v.done}/${v.total}`) : null),
      multi ? arrow(+1) : null),
    state.latch ? h('span.latch-pill.is-mini', { title: 'Global lane keys are armed' }, h('span.pulse')) : null,
    h('div.top-spacer'),
    h('button.btn-icon.btn-xs', { type: 'button', onclick: toggleMiniMode, title: 'Full window (Ctrl+M)', 'aria-label': 'Back to the full window' }, ui('expand', { size: 15 })),
    h('button.btn-icon.btn-xs', { type: 'button', onclick: showSettings, title: 'Settings (Ctrl+,)', 'aria-label': 'Settings' }, ui('gear', { size: 15 })),
  ];
}

function renderBanner() {
  const t = state.transition;
  if (!t) { els.banner.hidden = true; mount(els.banner); return; }
  els.banner.hidden = false;
  const mc = t.masteryChange;
  const mName = (id) => window.ViewModel.masteryName(state.db, state.build.classId, id);
  const masteryLine = !mc ? null
    : !mc.from ? h('li', 'Choose the ', h('b', mName(mc.to) ?? `mastery ${mc.to}`), ' mastery')
      : h('li', 'Mastery: ', h('b', mName(mc.from) ?? `mastery ${mc.from}`), ' → ', h('b', mName(mc.to) ?? (mc.to ? `mastery ${mc.to}` : 'none')));
  mount(els.banner,
    h('div.banner.banner-warn', { role: 'alert' },
      ui('alert', { size: 20 }),
      h('div.banner-body',
        h('div.banner-title', t.unspecNeeded.length ? `Before continuing in ${t.toName}, respec in game:` : `Before continuing in ${t.toName}:`),
        h('ul.banner-list',
          masteryLine,
          t.unspecNeeded.map((u) => {
            const pts = `${u.amount} point${u.amount > 1 ? 's' : ''}`;
            return h('li', h('b', transitionLabel(u)),
              u.isRemove ? ` — remove from your skill bar (${pts} allocated)` : ` — unspec ${pts}`);
          }))),
      h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => dismissTransition() }, 'Done'),
    ),
  );
}

/** Display name for a transition entry — same names the lanes use, not labels baked into build.json. */
function transitionLabel(u) {
  if (u.type === 'passive') {
    const title = lanes().find(l => l.type === 'passive')?.title;
    return title ? `${title} passives` : 'Passive tree';
  }
  return state.db.skills[u.skillKey]?.name ?? u.label;
}

function renderWorkspace() {
  if (!state.view) {
    els.workspace.classList.add('is-empty');
    mount(els.lanes, emptyState());
    mount(els.inspector);
    return;
  }
  els.workspace.classList.remove('is-empty');
  mount(els.lanes, lanes().map(laneElement));
  renderInspectorPanel();
}

function laneElement(lane) {
  if (isCompact()) {
    return renderMiniLane(lane, {
      keyLabel: hotkeyLabel(lane.index),
      focused: lane.index === state.focusLane,
      onAllocate: () => allocate(lane.index, +1),
      onUndo: () => allocate(lane.index, -1),
    });
  }
  return renderLane(lane, {
    focused: lane.index === state.focusLane,
    selectedIdx: state.pinned?.lane === lane.index ? state.pinned.step : null,
    hotkeyLabel: hotkeyLabel(lane.index),
    undoLabel: hotkeyLabel(lane.index, 'undo'),
    onAllocate: () => allocate(lane.index, +1),
    onUndo: () => allocate(lane.index, -1),
    onFill: () => allocate(lane.index, +1, { fill: true }),
    onSelect: (stepIdx) => pin(lane.index, stepIdx),
    onHover: (stepIdx) => {
      const next = stepIdx == null ? null : { lane: lane.index, step: stepIdx };
      if (next?.lane === state.hover?.lane && next?.step === state.hover?.step) return;
      state.hover = next;
      renderInspectorPanel();
    },
    onFocus: () => {
      if (state.focusLane === lane.index) return;
      const prev = state.focusLane;
      state.focusLane = lane.index;
      renderLaneAt(prev);
      renderLaneAt(lane.index);
      renderInspectorPanel();
    },
  });
}

const laneEl = (i) => els.lanes.querySelector(`[data-lane="${i}"]`);

function renderLaneAt(i, { smooth = false } = {}) {
  const lane = lanes()[i];
  const old = laneEl(i);
  if (!lane || !old) return;
  const scroll = old.querySelector('.lane-path')?.scrollLeft ?? 0;
  const fresh = laneElement(lane);
  old.replaceWith(fresh);
  const scroller = fresh.querySelector('.lane-path');
  if (scroller) scroller.scrollLeft = scroll;
  if (smooth) requestAnimationFrame(() => revealCurrent(fresh, { smooth: true }));
}

function revealAll(smooth) {
  els.lanes.querySelectorAll('.lane').forEach(el => revealCurrent(el, { smooth }));
}

function flashLane(i) {
  const el = laneEl(i)?.querySelector('.lane-now, .mini-hit');
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function unpin() {
  const l = state.pinned?.lane;
  state.pinned = null;
  if (l != null) renderLaneAt(l);
  renderInspectorPanel();
}

function renderInspectorPanel() {
  if (!state.view || isCompact()) return;
  // On narrow windows the inspector is a drawer, open while a node is pinned.
  els.workspace.classList.toggle('is-inspecting', !!state.pinned);
  const ctx = inspectorContext();
  mount(els.inspector,
    h('div.inspector-head',
      h('span', 'Node details'),
      h('button.btn-icon.btn-sm.inspector-close', { type: 'button', 'aria-label': 'Close details', title: 'Close (Esc)', onclick: unpin }, ui('x', { size: 16 }))),
    renderInspector(ctx, {
      onSetCurrent: setCurrent,
      onUnpin: unpin,
      onPick: (laneIdx, stepIdx) => pin(laneIdx, stepIdx, { reveal: true }),
    }),
  );
}

function renderStatusbar() {
  const hk = state.settings?.hotkeys;
  const global = !!hk?.enabled;
  const legend = [];
  const item = (keys, label) => h('span.legend-item', keys, h('span', label));
  // "[mod] + [F1] – [F6]": in-game keys when global hotkeys are on, in-app digits otherwise.
  const range = (mod) => {
    const k = (i) => prettyAccelerator(global ? laneKey(hk, i) : String(i + 1));
    return [mod ? [keycap(mod), h('span.plus', '+')] : null, keycap(k(0)), h('span.dash', '–'), keycap(k(5))];
  };

  if (state.view) {
    if (global && hk.hotkeyMode === 'latch') legend.push(item([keycap(prettyAccelerator(hk.latchKey))], 'arm'));
    legend.push(item(range(global ? hk.advanceModifier : ''), 'allocate'));
    legend.push(item(range(global ? hk.undoModifier || 'Shift' : 'Shift'), 'undo'));
    if (state.view.phases.length > 1 && global && hk.phaseNextKey) legend.push(item([keycap(prettyAccelerator(hk.phaseNextKey))], 'next phase'));
    if (global && hk.toggle) legend.push(item([keycap(prettyAccelerator(hk.toggle))], 'show / hide'));
  }

  const notes = [];
  if (state.view && !global) notes.push(h('span.note', 'Global hotkeys off'));
  if (state.failedHotkeys.length) {
    notes.push(h('button.note.note-warn', { type: 'button', onclick: showSettings, title: 'Open settings' },
      ui('alert', { size: 13 }), `Hotkey unavailable: ${state.failedHotkeys.map(prettyAccelerator).join(', ')}`));
  }
  if (state.missingData.length) {
    notes.push(h('span.note.note-error', { title: `Missing in db/data/: ${state.missingData.join(', ')} — run python extractor/extract.py` },
      ui('alert', { size: 13 }), 'Game data missing'));
  }
  notes.push(h('button.note.note-help', { type: 'button', onclick: showHelp, title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts' }, ui('keyboard', { size: 14 }), h('span.note-help-text', 'Shortcuts')));

  mount(els.statusbar,
    lastActionChip(),
    h('div.legend', legend.length ? [h('span.legend-scope', global ? 'In game' : 'In app'), legend] : null),
    h('div.notes', notes),
  );
}

/** "+1 Flay · Go For The Throat 2/3  [Undo]" — confirms what the last key press did. */
function lastActionChip() {
  const a = state.lastAction;
  if (!a || !state.view) return null;
  const canUndo = state.undoStack.some(u => u.phase === state.build.currentPhase);
  return h('div.last-action', { style: { '--accent': a.accent }, role: 'status', title: a.undone ? 'Undone' : 'Last change' },
    h('span.last-delta', { class: a.sign === '+' ? 'is-add' : 'is-remove' }, `${a.sign}${a.amount}`),
    h('span.last-text',
      h('b', a.title),
      a.detail ? h('span.last-detail', ` · ${a.detail}`) : null,
      a.complete ? h('span.last-done', ' ✓') : null),
    canUndo ? h('button.last-undo', { type: 'button', onclick: undoLast, title: 'Undo the last change (Ctrl+Z)' }, ui('undo', { size: 13 }), h('span', 'Undo')) : null,
  );
}

function showHelp() {
  openHelp({ dialog: els['dlg-help'], hotkeys: state.settings.hotkeys, onOpenSettings: showSettings });
}

function emptyState() {
  return h('div.empty',
    h('div.empty-card',
      h('span.empty-mark', ui('sparkles', { size: 28 })),
      h('h1', 'Load your build'),
      h('p.empty-lead', 'See every tree at a glance — what to allocate now, what comes next — and tick points off as you level.'),
      h('ol.empty-steps',
        h('li', h('b', 'Copy'), ' your Maxroll planner link (or its export codes, or the in-game export).'),
        h('li', h('b', 'Paste'), ' it into ', h('i', 'Load build'), ' — each planner variant becomes a phase.'),
        h('li', h('b', 'Allocate'), ' in game, then press the lane’s key (', h('b', state.settings?.hotkeys.enabled ? LANE_KEYSET_LABELS[state.settings.hotkeys.laneKeys] : '1–6'), ') — even while the game has focus.')),
      h('div.empty-actions',
        h('button.btn.btn-primary.btn-lg', { type: 'button', onclick: showLoadout }, ui('upload', { size: 18 }), 'Load build', h('kbd.key.key-sm.key-on-primary', 'Ctrl O')),
        h('button.btn.btn-ghost.btn-lg', { type: 'button', onclick: loadExample }, 'Try the example build')),
    ),
  );
}

boot();

