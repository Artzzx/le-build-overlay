/**
 * app/js/main.js
 * ───────────────
 * App shell: state, actions, and orchestration of the views.
 *
 *   ┌ topbar ─ build · phase switcher · overall progress · actions ─────────┐
 *   ├ banner ─ phase-change instructions (unspec / remove skills)           │
 *   ├ lanes (passive + skills) ───────────────────────┬ inspector ──────────┤
 *   └ statusbar ─ hotkey legend · data / hotkey warnings ───────────────────┘
 *
 * State changes go through commit(), which persists the build and re-renders
 * only what changed. All pure logic lives in shared/ (TreeUtils, ViewModel).
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';
import { renderLane, revealCurrent, keycap } from './lanes.js';
import { renderInspector } from './inspector.js';
import { openLoadout } from './loadout-dialog.js';
import { openSettings } from './settings-dialog.js';
import { prettyAccelerator } from './keys.js';

const { normalizeBuild, stepTrack, setTrackProgress, computeTransition, applyCarryOver } = window.TreeUtils;
const { buildView, stepStartProgress } = window.ViewModel;
const api = window.api;

const SAMPLE_SOURCE = 'skill_tree_reconciled.sample.json';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  db: null,            // { passives, skills, classes } — same shape TreeUtils expects
  build: null,         // multi-phase loadout
  view: null,          // ViewModel.buildView(build, db)
  settings: null,
  defaults: null,
  dataSource: null,
  failedHotkeys: [],
  focusLane: 0,        // keyboard / inspector focus
  pinned: null,        // { lane, step } — clicked node
  hover: null,         // { lane, step } — hovered node (transient)
  transition: null,    // { toName, unspecNeeded } after a phase switch
  latch: false,        // global hotkeys armed (latch mode)
};

const $ = (id) => document.getElementById(id);
const els = {};

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  for (const id of ['topbar', 'banner', 'workspace', 'lanes', 'inspector', 'statusbar', 'toasts', 'dlg-loadout', 'dlg-settings']) {
    els[id] = $(id);
  }

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
  state.dataSource = res.dataSource;
  state.failedHotkeys = res.failedHotkeys ?? [];

  api.onHotkey(onGlobalHotkey);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => requestAnimationFrame(() => revealAll(false)));

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

function hotkeyLabel(index) {
  const mod = state.settings?.hotkeys?.advanceModifier;
  return mod ? `${mod}+${index + 1}` : String(index + 1);
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

function allocate(i, delta) {
  const lane = lanes()[i];
  if (!lane) return;
  if (lane.unresolved) {
    toast(`${lane.title} has no tree data — it can’t be tracked yet.`, { kind: 'warn' });
    return;
  }
  const prevFocus = state.focusLane;
  state.focusLane = i;
  const hadPin = state.pinned;
  state.pinned = null;
  if (state.transition) dismissTransition(false);
  const changed = commit(stepTrack(state.build, i, delta), {
    lanes: [...new Set([i, prevFocus, hadPin?.lane].filter(n => n != null))],
    flash: delta > 0 ? i : null,
  });
  if (!changed) {
    if (delta > 0 && lane.complete) toast(`${lane.title} is already complete.`);
    // Still reflect the focus change.
    [i, prevFocus].forEach(n => renderLaneAt(n));
    renderInspectorPanel();
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
  commit({ ...b, currentPhase: to, phases: applyCarryOver(b.phases, from, to) });
  if (transition.unspecNeeded.length) {
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
    hasProgress: lanes().some(l => l.done > 0),
    onLoaded(build) {
      state.pinned = null;
      state.hover = null;
      state.focusLane = 0;
      state.transition = null;
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
  state.build = null;
  commit(normalizeBuild(res.build));
  toast('Example build loaded — replace it with yours any time (Ctrl+O).');
}

// ─── Input ────────────────────────────────────────────────────────────────────

function onGlobalHotkey(e) {
  if (e.action === 'latch') {
    state.latch = e.active;
    renderTopbar();
    return;
  }
  if (!state.build) return;
  if (e.action === 'advance') allocate(e.trackIndex, +1);
  else if (e.action === 'undo') allocate(e.trackIndex, -1);
  else if (e.action === 'phase') gotoPhase(state.build.currentPhase + e.direction);
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function onKeyDown(e) {
  if (document.querySelector('dialog[open]')) return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl) {
    const actions = {
      KeyO: showLoadout,
      Comma: showSettings,
      Equal: () => setUiScale(state.settings.display.uiScale + 0.1),
      NumpadAdd: () => setUiScale(state.settings.display.uiScale + 0.1),
      Minus: () => setUiScale(state.settings.display.uiScale - 0.1),
      NumpadSubtract: () => setUiScale(state.settings.display.uiScale - 0.1),
      Digit0: () => setUiScale(1),
    };
    if (actions[e.code]) { e.preventDefault(); actions[e.code](); }
    return;
  }
  if (isTyping(e.target) || !state.view || e.altKey) return;

  const digit = /^(Digit|Numpad)([1-6])$/.exec(e.code);
  if (digit) {
    e.preventDefault();
    if (e.repeat) return; // holding a key must never burn through points
    allocate(Number(digit[2]) - 1, e.shiftKey ? -1 : +1);
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
  document.title = state.build ? `${state.build.name} — LE Build Planner` : 'LE Build Planner';
  renderTopbar();
  renderBanner();
  renderWorkspace();
  renderStatusbar();
}

function renderTopbar() {
  const v = state.view;
  const actions = h('div.top-actions',
    state.latch ? h('span.latch-pill', { title: 'Global number keys are armed' }, h('span.pulse'), 'Hotkeys armed') : null,
    h('button.btn.btn-secondary', { type: 'button', onclick: showLoadout, title: 'Load build (Ctrl+O)' }, ui('upload', { size: 16 }), h('span.btn-text', v ? 'Load build' : 'Load')),
    h('button.btn-icon', {
      type: 'button', onclick: toggleOnTop,
      class: state.settings?.display.alwaysOnTop ? 'is-on' : '',
      'aria-pressed': String(!!state.settings?.display.alwaysOnTop),
      title: state.settings?.display.alwaysOnTop ? 'Keep on top: on' : 'Keep on top: off',
      'aria-label': 'Keep window on top',
    }, ui('pin', { size: 18 })),
    h('button.btn-icon', { type: 'button', onclick: showSettings, title: 'Settings (Ctrl+,)', 'aria-label': 'Settings' }, ui('gear', { size: 18 })),
  );

  if (!v) {
    mount(els.topbar, h('div.brand', h('span.brand-mark', ui('sparkles', { size: 18 })), h('span.brand-name', 'LE Build Planner')), h('div.top-spacer'), actions);
    return;
  }

  const pct = Math.round(v.pct * 100);
  const phaseSwitcher = v.phases.length > 1
    ? h('nav.phase-switch', { 'aria-label': 'Phases' },
      h('button.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Previous phase', title: `Previous phase (${prettyAccelerator(state.settings.hotkeys.phasePrevKey) || 'PgUp'})`, onclick: () => gotoPhase(v.currentPhase - 1) }, ui('chevronLeft', { size: 16 })),
      h('div.segmented', { role: 'tablist' },
        v.phases.map(p => h('button.seg', {
          type: 'button', role: 'tab', 'aria-selected': String(p.index === v.currentPhase),
          class: p.index === v.currentPhase ? 'is-active' : '',
          onclick: () => gotoPhase(p.index),
        }, p.name))),
      h('button.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Next phase', title: `Next phase (${prettyAccelerator(state.settings.hotkeys.phaseNextKey) || 'PgDn'})`, onclick: () => gotoPhase(v.currentPhase + 1) }, ui('chevronRight', { size: 16 })))
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

function renderBanner() {
  const t = state.transition;
  if (!t) { els.banner.hidden = true; mount(els.banner); return; }
  els.banner.hidden = false;
  mount(els.banner,
    h('div.banner.banner-warn', { role: 'alert' },
      ui('alert', { size: 20 }),
      h('div.banner-body',
        h('div.banner-title', `Before continuing in ${t.toName}, respec in game:`),
        h('ul.banner-list', t.unspecNeeded.map((u) => {
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
  return renderLane(lane, {
    focused: lane.index === state.focusLane,
    selectedIdx: state.pinned?.lane === lane.index ? state.pinned.step : null,
    hotkeyLabel: hotkeyLabel(lane.index),
    onAllocate: () => allocate(lane.index, +1),
    onUndo: () => allocate(lane.index, -1),
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
  const el = laneEl(i)?.querySelector('.lane-now');
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
  if (!state.view) return;
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
  const legend = [];
  const item = (keys, label) => h('span.legend-item', keys, h('span', label));
  const range = (mod) => [mod ? [keycap(mod), h('span.plus', '+')] : null, keycap('1'), h('span.dash', '–'), keycap('6')];

  if (state.view) {
    if (hk?.enabled && hk.hotkeyMode === 'latch') legend.push(item([keycap(prettyAccelerator(hk.latchKey))], 'arm'));
    legend.push(item(range(hk?.enabled ? hk.advanceModifier : ''), 'allocate'));
    legend.push(item(range(hk?.enabled ? hk.undoModifier || 'Shift' : 'Shift'), 'undo'));
    if (state.view.phases.length > 1 && hk?.enabled && hk.phaseNextKey) legend.push(item([keycap(prettyAccelerator(hk.phaseNextKey))], 'next phase'));
    if (hk?.enabled && hk.toggle) legend.push(item([keycap(prettyAccelerator(hk.toggle))], 'show / hide'));
  }

  const notes = [];
  if (state.view && !hk?.enabled) notes.push(h('span.note', 'Global hotkeys off'));
  if (state.failedHotkeys.length) {
    notes.push(h('button.note.note-warn', { type: 'button', onclick: showSettings, title: 'Open settings' },
      ui('alert', { size: 13 }), `Hotkey unavailable: ${state.failedHotkeys.map(prettyAccelerator).join(', ')}`));
  }
  if (state.dataSource === SAMPLE_SOURCE) {
    notes.push(h('span.note.note-warn', { title: 'db/data/skill_tree_reconciled.json not found — using the small committed sample. Run python extractor/extract.py.' },
      ui('info', { size: 13 }), 'Sample game data'));
  } else if (!state.dataSource) {
    notes.push(h('span.note.note-error', ui('alert', { size: 13 }), 'No game data found'));
  }

  mount(els.statusbar,
    h('div.legend', legend.length ? [h('span.legend-scope', hk?.enabled ? 'In game' : 'In app'), legend] : null),
    h('div.notes', notes),
  );
}

function emptyState() {
  return h('div.empty',
    h('div.empty-card',
      h('span.empty-mark', ui('sparkles', { size: 28 })),
      h('h1', 'Load your build'),
      h('p.empty-lead', 'See every tree at a glance — what to allocate now, what comes next — and tick points off as you level.'),
      h('ol.empty-steps',
        h('li', h('b', 'Copy'), ' the export codes from your Maxroll planner (or the in-game export).'),
        h('li', h('b', 'Paste'), ' them into ', h('i', 'Load build'), '. Add phases for leveling and endgame.'),
        h('li', h('b', 'Allocate'), ' in game, then press the lane’s number key — even while the game has focus.')),
      h('div.empty-actions',
        h('button.btn.btn-primary.btn-lg', { type: 'button', onclick: showLoadout }, ui('upload', { size: 18 }), 'Load build', h('kbd.key.key-sm.key-on-primary', 'Ctrl O')),
        h('button.btn.btn-ghost.btn-lg', { type: 'button', onclick: loadExample }, 'Try the example build')),
    ),
  );
}

// ─── Toasts ───────────────────────────────────────────────────────────────────

function toast(message, { kind = 'info', action = null, duration = action ? 6000 : 3200 } = {}) {
  const el = h(`div.toast.toast-${kind}`, { role: 'status' },
    h('span.toast-msg', message),
    action ? h('button.toast-action', { type: 'button', onclick: () => { action.run(); remove(); } }, action.label) : null,
    h('button.toast-x', { type: 'button', 'aria-label': 'Dismiss', onclick: () => remove() }, ui('x', { size: 14 })),
  );
  function remove() {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 180);
  }
  // Keep at most 3 toasts.
  while (els.toasts.children.length >= 3) els.toasts.firstElementChild.remove();
  els.toasts.append(el);
  setTimeout(remove, duration);
}

boot();

