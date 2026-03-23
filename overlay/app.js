/**
 * overlay/app.js
 * ───────────────
 * Renderer process script for the overlay window.
 * Runs in the browser context (NOT Node.js — no require() available here).
 * Communicates with main.js exclusively via window.electronAPI (set up in preload.js).
 *
 * ─── Responsibilities ────────────────────────────────────────────────────────
 *
 *  1. Load build.json at startup (via fetch or electronAPI)
 *  2. Load db/data/*.json for node name resolution
 *  3. Render all track rows into #tracks
 *  4. Handle hotkey IPC events:
 *     - 'toggle'   → show/hide #overlay-root
 *     - 'advance'  → increment track's currentStep, re-render, flash, persist
 *     - 'undo'     → decrement track's currentStep, re-render, persist
 *     - 'phase'    → switch to next/previous phase (loadout feature)
 *  5. On reload-build event: re-initialize from disk
 *
 * ─── Data model ──────────────────────────────────────────────────────────────
 *
 *  config/build.json now stores a multi-phase LOADOUT:
 *  {
 *    name, classId, masteryId, currentPhase,
 *    phases: [{ name, tracks: [...] }, ...]
 *  }
 *
 *  Old single-phase format ({ name, classId, masteryId, tracks }) is auto-wrapped
 *  by normalizeBuild() on load so all downstream code uses the loadout shape.
 *
 *  activeTracks() returns the tracks for the currently active phase.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  build: null,           // loadout: { name, classId, masteryId, currentPhase, phases }
  db: null,              // { passives, skills, classes }
  expandedTrack: 0,      // 0-based index of expanded track row
  visible: true,         // overlay visibility
  settings: null,        // last-received settings object (for display toggles)
  positionMode: false,   // true while drag/resize mode is active
  transition: null,      // { fromName, toName, unspecNeeded } | null
  _transitionTimer: null,
};

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  try {
    state.db    = await loadDb();
    state.build = await loadBuild();

    if (window.electronAPI?.getSettings) {
      const s = await window.electronAPI.getSettings();
      if (s) state.settings = s;
    }
  } catch (err) {
    console.error('[app] Initialization error:', err);
  }

  if (state.settings?.display) {
    const d = state.settings.display;
    document.documentElement.style.setProperty('--font-size-base', `${d.fontSize}px`);
    document.documentElement.style.setProperty('--bg', `rgba(6, 8, 14, ${d.opacity})`);
    const overlayRoot = document.getElementById('overlay-root');
    overlayRoot?.classList.toggle('always-progress', d.alwaysShowProgress ?? false);
  }

  render();
  subscribeToHotkeys();
  subscribeToReload();
  subscribeToSettings();
  subscribeToPositionMode();
  initPositionModeUI();
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadBuild() {
  try {
    const res = await fetch('../config/build.json');
    if (!res.ok) return null;
    const raw = await res.json();
    return normalizeBuild(raw);
  } catch {
    return null;
  }
}

/**
 * Ensure build.json is always in the multi-phase loadout format.
 * Old single-phase format ({ tracks }) is auto-wrapped so all code
 * downstream uses the same shape.
 */
function normalizeBuild(raw) {
  if (!raw) return null;
  if (raw.phases) return raw;               // already loadout format
  if (raw.tracks) {                          // old single-phase format
    return {
      name:         raw.name,
      classId:      raw.classId,
      masteryId:    raw.masteryId,
      currentPhase: 0,
      phases: [{ name: 'Main', tracks: raw.tracks }],
    };
  }
  return null;
}

/**
 * Returns the tracks array for the currently active phase.
 * @returns {object[]|null}
 */
function activeTracks() {
  return state.build?.phases?.[state.build.currentPhase]?.tracks ?? null;
}

async function loadDb() {
  const [rawNodes, classes] = await Promise.all([
    fetchJson('../db/data/skill_tree_reconciled.json', []),
    fetchJson('../db/data/classes.json', { classes: {}, masteries: {} }),
  ]);

  const trees = {};
  for (const { treeID, treeName, nodeID, nodeName, description, maxPoints, stats } of rawNodes) {
    if (!trees[treeID]) trees[treeID] = { name: treeName, nodes: {} };
    trees[treeID].nodes[String(nodeID)] = { id: nodeID, nodeName, description, maxPoints, stats };
  }

  return { passives: trees, skills: trees, classes };
}

async function fetchJson(url, fallback) {
  try {
    const res = await fetch(url);
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

// ─── IPC subscriptions ────────────────────────────────────────────────────────

function subscribeToHotkeys() {
  if (!window.electronAPI) {
    console.warn('[app] window.electronAPI not available — hotkeys will not work');
    return;
  }

  window.electronAPI.onHotkey((payload) => {
    const { action, trackIndex, visible, direction } = payload;

    if (action === 'toggle') {
      state.visible = visible;
      return;
    }

    if (!state.build) return;

    if (action === 'advance') {
      handleAdvance(trackIndex);
    } else if (action === 'undo') {
      handleUndo(trackIndex);
    } else if (action === 'phase') {
      switchPhase(direction);
    }
  });
}

function subscribeToReload() {
  if (!window.electronAPI?.onReloadBuild) return;
  window.electronAPI.onReloadBuild(async () => {
    state.build = await loadBuild();
    state.expandedTrack = 0;
    state.transition = null;
    clearTimeout(state._transitionTimer);
    render();
  });
}

function subscribeToSettings() {
  if (!window.electronAPI?.onSettingsChanged) return;
  window.electronAPI.onSettingsChanged((s) => applyDisplaySettings(s));
}

function applyDisplaySettings(s) {
  if (!s?.display) return;
  state.settings = s;
  const root = document.documentElement;
  root.style.setProperty('--font-size-base', `${s.display.fontSize}px`);
  root.style.setProperty('--bg', `rgba(6, 8, 14, ${s.display.opacity})`);
  const overlayRoot = document.getElementById('overlay-root');
  overlayRoot?.classList.toggle('always-progress', s.display.alwaysShowProgress ?? false);
  render();
}

// ─── Position mode ────────────────────────────────────────────────────────────

function subscribeToPositionMode() {
  if (!window.electronAPI) return;
  window.electronAPI.onEnterPositionMode?.(() => enterPositionMode());
  window.electronAPI.onExitPositionMode?.(() => exitPositionMode());
}

function enterPositionMode() {
  state.positionMode = true;
  document.getElementById('overlay-root')?.classList.add('position-mode');
  document.getElementById('position-bar')?.classList.remove('hidden');
  document.querySelectorAll('.resize-grip').forEach(g => g.classList.remove('hidden'));
}

function exitPositionMode() {
  state.positionMode = false;
  document.getElementById('overlay-root')?.classList.remove('position-mode');
  document.getElementById('position-bar')?.classList.add('hidden');
  document.querySelectorAll('.resize-grip').forEach(g => g.classList.add('hidden'));
}

function initPositionModeUI() {
  const posBar  = document.getElementById('position-bar');
  const doneBtn = document.getElementById('pos-done-btn');
  if (!posBar || !doneBtn) return;

  let dragging = false;
  let lastX = 0, lastY = 0;

  posBar.addEventListener('mousedown', (e) => {
    if (e.target === doneBtn) return;
    dragging = true; lastX = e.screenX; lastY = e.screenY; e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    window.electronAPI?.moveWindow?.(e.screenX - lastX, e.screenY - lastY);
    lastX = e.screenX; lastY = e.screenY;
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  doneBtn.addEventListener('click', () => window.electronAPI?.endPositionMode?.());

  document.querySelectorAll('.resize-grip').forEach((grip) => {
    const corner = grip.dataset.corner;
    let resizing = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;

    grip.addEventListener('mousedown', (e) => {
      resizing = true; startX = e.screenX; startY = e.screenY;
      startW = window.innerWidth; startH = window.innerHeight;
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const dx = e.screenX - startX, dy = e.screenY - startY;
      let newW = startW, newH = startH;
      if (corner.includes('e')) newW = startW + dx;
      if (corner.includes('w')) newW = startW - dx;
      if (corner.includes('s')) newH = startH + dy;
      if (corner.includes('n')) newH = startH - dy;
      window.electronAPI?.resizeWindow?.(Math.max(180, Math.round(newW)), Math.max(200, Math.round(newH)));
    });
    document.addEventListener('mouseup', () => { resizing = false; });
  });
}

// ─── Hotkey handlers ──────────────────────────────────────────────────────────

function handleAdvance(trackIndex) {
  // Dismiss transition panel on any interaction
  if (state.transition) { state.transition = null; clearTimeout(state._transitionTimer); }

  const tracks = activeTracks();
  const track  = tracks?.[trackIndex];
  if (!track) return;
  if (isTrackUnresolved(track)) return;
  if (track.currentStep >= track.history.length) return;

  const cp = state.build.currentPhase;
  state.build = {
    ...state.build,
    phases: state.build.phases.map((phase, i) =>
      i !== cp ? phase : {
        ...phase,
        tracks: phase.tracks.map((t, j) =>
          j === trackIndex ? { ...t, currentStep: t.currentStep + 1 } : t
        ),
      }
    ),
  };

  state.expandedTrack = trackIndex;
  render();
  flashTrack(trackIndex);
  persistBuild();
}

function handleUndo(trackIndex) {
  if (state.transition) { state.transition = null; clearTimeout(state._transitionTimer); }

  const tracks = activeTracks();
  const track  = tracks?.[trackIndex];
  if (!track || track.currentStep <= 0) return;
  if (isTrackUnresolved(track)) return;

  const cp = state.build.currentPhase;
  state.build = {
    ...state.build,
    phases: state.build.phases.map((phase, i) =>
      i !== cp ? phase : {
        ...phase,
        tracks: phase.tracks.map((t, j) =>
          j === trackIndex ? { ...t, currentStep: t.currentStep - 1 } : t
        ),
      }
    ),
  };

  state.expandedTrack = trackIndex;
  render();
  persistBuild();
}

// ─── Phase switching ──────────────────────────────────────────────────────────

/**
 * Switch to the next (+1) or previous (-1) phase, wrapping around.
 * Computes a transition summary and applies smart carry-over of progress.
 */
function switchPhase(direction) {
  if (state.transition) { state.transition = null; clearTimeout(state._transitionTimer); }
  if (!state.build?.phases) return;

  const total = state.build.phases.length;
  if (total <= 1) return;

  const from = state.build.currentPhase;
  const to   = ((from + direction) % total + total) % total;

  const transition = computeTransition(from, to);
  const newPhases  = applyCarryOver(state.build.phases, from, to);

  state.build = { ...state.build, currentPhase: to, phases: newPhases };
  state.expandedTrack = 0;
  state.transition = transition;

  render();
  persistBuild();

  // Auto-clear transition panel: 15s when unspec needed, 3s otherwise
  const delay = transition.unspecNeeded.length > 0 ? 15000 : 3000;
  clearTimeout(state._transitionTimer);
  state._transitionTimer = setTimeout(() => {
    state.transition = null;
    render();
  }, delay);
}

/**
 * Compute what the user needs to do when switching from → to phase.
 * Returns { fromName, toName, unspecNeeded: [{label, amount, isRemove}] }
 */
function computeTransition(fromIdx, toIdx) {
  const fromTracks = state.build.phases[fromIdx].tracks;
  const toTracks   = state.build.phases[toIdx].tracks;
  const unspecNeeded = [];

  // Skills shared between phases: check if common prefix covers all progress
  toTracks.forEach(toT => {
    const fromT = fromTracks.find(t =>
      toT.type === 'passive' ? t.type === 'passive' : t.skillKey === toT.skillKey
    );
    if (!fromT || fromT.currentStep === 0) return;

    const common = commonPrefixLength(fromT.history, toT.history);
    if (fromT.currentStep > common) {
      unspecNeeded.push({
        label:    toT.label,
        amount:   fromT.currentStep - common,
        isRemove: false,
      });
    }
  });

  // Skills in old phase NOT in new phase — user must remove from skill bar
  fromTracks.forEach(fromT => {
    if (fromT.type === 'passive' || fromT.currentStep === 0) return;
    const inTo = toTracks.find(t => t.skillKey === fromT.skillKey);
    if (!inTo) {
      unspecNeeded.push({ label: fromT.label, amount: fromT.currentStep, isRemove: true });
    }
  });

  return {
    fromName: state.build.phases[fromIdx].name,
    toName:   state.build.phases[toIdx].name,
    unspecNeeded,
  };
}

/**
 * Returns the number of leading elements that are identical in arrays a and b.
 */
function commonPrefixLength(a, b) {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

/**
 * Apply carry-over: set the to-phase's currentStep for each track to
 * min(fromStep, commonPrefixLength). Skills not in the from phase start at 0.
 */
function applyCarryOver(phases, fromIdx, toIdx) {
  const fromTracks = phases[fromIdx].tracks;
  return phases.map((phase, i) => {
    if (i !== toIdx) return phase;
    return {
      ...phase,
      tracks: phase.tracks.map(toT => {
        const fromT = fromTracks.find(t =>
          toT.type === 'passive' ? t.type === 'passive' : t.skillKey === toT.skillKey
        );
        if (!fromT) return { ...toT, currentStep: 0 };
        const common = commonPrefixLength(fromT.history, toT.history);
        return { ...toT, currentStep: Math.min(fromT.currentStep, common) };
      }),
    };
  });
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function persistBuild() {
  if (!window.electronAPI?.saveBuild || !state.build) return;
  window.electronAPI.saveBuild(state.build);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function render() {
  const noBuildMsg = document.getElementById('no-build-msg');
  const tracksEl   = document.getElementById('tracks');
  const phaseBar   = document.getElementById('phase-bar');

  const tracks = activeTracks();

  if (!tracks || !tracks.length) {
    noBuildMsg?.classList.remove('hidden');
    if (tracksEl) tracksEl.innerHTML = '';
    phaseBar?.classList.add('hidden');
    return;
  }

  noBuildMsg?.classList.add('hidden');

  // ── Phase bar ──────────────────────────────────────────────────────────────
  const phases = state.build?.phases;
  if (phaseBar) {
    if (phases && phases.length > 1) {
      const cur = state.build.currentPhase;
      phaseBar.classList.remove('hidden');
      phaseBar.textContent = `\u25c4 ${cur + 1}/${phases.length} ${phases[cur].name} \u25ba`;
    } else {
      phaseBar.classList.add('hidden');
    }
  }

  // ── Transition panel or normal tracks ─────────────────────────────────────
  if (tracksEl) {
    tracksEl.innerHTML = '';
    if (state.transition) {
      renderTransitionPanel(tracksEl, state.transition);
    } else {
      tracks.forEach((track, index) => {
        tracksEl.appendChild(renderTrack(track, index));
      });
    }
  }

  // ── Hotkey hint bar (update for multi-phase) ───────────────────────────────
  const hint = document.getElementById('hotkey-hint');
  if (hint) {
    if (phases && phases.length > 1) {
      hint.textContent = 'F1 hide \u00b7 1\u20136 advance \u00b7 Shift+N undo \u00b7 F6 phase';
    } else {
      hint.textContent = 'F1 hide \u00b7 1\u20136 advance \u00b7 Shift+N undo';
    }
  }
}

/**
 * Render the transition panel that shows after a phase switch.
 * Replaces normal tracks until dismissed.
 */
function renderTransitionPanel(container, t) {
  const div = document.createElement('div');
  div.className = 'transition-panel';

  const title = document.createElement('div');
  title.className = 'transition-title';
  title.textContent = `\u2192 ${t.toName}`;
  div.appendChild(title);

  if (t.unspecNeeded.length === 0) {
    const ok = document.createElement('div');
    ok.className = 'transition-ok';
    ok.textContent = 'No changes needed';
    div.appendChild(ok);
  } else {
    const warn = document.createElement('div');
    warn.className = 'transition-warn';
    warn.textContent = '\u26a0 Unspec required:';
    div.appendChild(warn);

    t.unspecNeeded.forEach(u => {
      const row = document.createElement('div');
      row.className = 'transition-row';
      if (u.isRemove) {
        row.textContent = `\u2715 Remove ${u.label} from skill bar`;
      } else {
        row.textContent = `\u21a9 ${u.label}: remove ${u.amount} pt${u.amount !== 1 ? 's' : ''}`;
      }
      div.appendChild(row);
    });
  }

  const hint = document.createElement('div');
  hint.className = 'transition-hint';
  hint.textContent = 'Clears automatically\u2026';
  div.appendChild(hint);

  container.appendChild(div);
}

/**
 * Build the DOM element for a single track row.
 */
function renderTrack(track, index) {
  // ── Unresolved: DB loaded but skill has no data ──────────────────────────
  if (isTrackUnresolved(track)) {
    const div = document.createElement('div');
    div.className = 'track unresolved';
    div.dataset.trackIndex = index;

    const header = document.createElement('div');
    header.className = 'track-header';

    const badge = document.createElement('span');
    badge.className = `track-badge ${track.type}`;
    badge.textContent = track.type === 'passive' ? 'P' : 'S';
    header.appendChild(badge);

    const nameEl = document.createElement('span');
    nameEl.className = 'track-name';
    nameEl.textContent = track.label;
    header.appendChild(nameEl);

    const infoEl = document.createElement('span');
    infoEl.className = 'track-unresolved-label';
    infoEl.textContent = 'no data';
    header.appendChild(infoEl);

    const hotkeyEl = document.createElement('span');
    hotkeyEl.className = 'track-hotkey';
    hotkeyEl.textContent = String(index + 1);
    header.appendChild(hotkeyEl);

    div.appendChild(header);
    return div;
  }

  const groups      = groupHistory(track.history);
  const isCompleted = track.currentStep >= track.history.length;
  const isExpanded  = index === state.expandedTrack && !isCompleted;

  const currentGroup = groups.find(
    g => track.currentStep >= g.startIdx && track.currentStep < g.startIdx + g.count
  ) ?? null;

  const pointsInNode = currentGroup ? track.currentStep - currentGroup.startIdx : 0;
  const node         = currentGroup ? resolveNode(currentGroup.nodeId, track) : null;

  // Wrapper
  const div = document.createElement('div');
  div.className = 'track'
    + (isExpanded  ? ' expanded'  : '')
    + (isCompleted ? ' completed' : '');
  div.dataset.trackIndex = index;

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'track-header';

  const badge = document.createElement('span');
  badge.className = `track-badge ${track.type}`;
  badge.textContent = track.type === 'passive' ? 'P' : 'S';
  header.appendChild(badge);

  const trackLabel = track.type === 'passive'
    ? resolvePassiveLabel(state.build.classId, state.build.masteryId) ?? track.label
    : track.label;

  const nameEl = document.createElement('span');
  nameEl.className = 'track-name';
  if (isCompleted) {
    nameEl.textContent = trackLabel;
  } else {
    const nodeName = node?.nodeName || node?.name;
    nameEl.textContent = nodeName ? `${trackLabel} \u2014 ${nodeName}` : trackLabel;
  }
  header.appendChild(nameEl);

  const progressEl = document.createElement('span');
  progressEl.className = 'track-progress';
  progressEl.textContent = `${track.currentStep}/${track.history.length}`;
  header.appendChild(progressEl);

  const hotkeyEl = document.createElement('span');
  hotkeyEl.className = 'track-hotkey';
  hotkeyEl.textContent = String(index + 1);
  header.appendChild(hotkeyEl);

  div.appendChild(header);

  // ── Inline progress (always-progress mode) ────────────────────────────────
  if (!isCompleted && currentGroup && currentGroup.count > 0) {
    const inlineEl = document.createElement('div');
    inlineEl.className = 'track-progress-inline';
    buildProgressContent(inlineEl, pointsInNode, currentGroup.count, track.type);
    div.appendChild(inlineEl);
  }

  // ── Expanded body ─────────────────────────────────────────────────────────
  if (isExpanded && node) {
    const body = document.createElement('div');
    body.className = 'track-body';

    const showDesc = state.settings?.display?.showDescription ?? true;
    if (node.description && showDesc) {
      const descEl = document.createElement('div');
      descEl.className = 'track-desc';
      descEl.textContent = node.description;
      body.appendChild(descEl);
    }

    if (currentGroup && currentGroup.count > 0) {
      buildProgressContent(body, pointsInNode, currentGroup.count, track.type);
    }

    div.appendChild(body);
  }

  return div;
}

/**
 * Append pts label + dots to a container element.
 */
function buildProgressContent(container, pointsInNode, stepCount, trackType) {
  const ptsEl = document.createElement('div');
  ptsEl.className = 'track-pts';
  ptsEl.textContent = `${pointsInNode} / ${stepCount} pts`;
  container.appendChild(ptsEl);

  if (stepCount > 1) {
    const dotsEl = document.createElement('div');
    dotsEl.className = 'track-dots';
    for (let p = 0; p < stepCount; p++) {
      const dot = document.createElement('span');
      if (p < pointsInNode)     dot.className = `dot filled ${trackType}`;
      else if (p === pointsInNode) dot.className = 'dot current';
      else                         dot.className = 'dot empty';
      dotsEl.appendChild(dot);
    }
    container.appendChild(dotsEl);
  }
}

function flashTrack(trackIndex) {
  const el = document.querySelectorAll('.track')[trackIndex];
  if (!el) return;
  el.classList.remove('flashing');
  void el.offsetWidth;
  el.classList.add('flashing');
  setTimeout(() => el.classList.remove('flashing'), 250);
}

// ─── Passive label resolution ─────────────────────────────────────────────────

function resolvePassiveLabel(classId, masteryId) {
  if (!state.db?.classes) return null;
  const cId = String(classId ?? 0);
  const mId = String(masteryId ?? 0);
  const className   = state.db.classes.classes?.[cId];
  const masteryName = state.db.classes.masteriesByClass?.[cId]?.[mId];
  if (!className || !masteryName) return null;
  return `${className} \u2014 ${masteryName} Passives`;
}

// ─── Track resolution check ───────────────────────────────────────────────────

function isTrackUnresolved(track) {
  if (!state.db) return false;
  if (track.type === 'skill') {
    return !state.db.skills?.[track.skillKey];
  }
  const classId = String(state.build?.classId ?? 0);
  const treeId  = state.db.classes?.passiveTreeByClass?.[classId];
  return !treeId || !state.db.passives?.[treeId];
}

// ─── Utility (mirrored from build-schema.js — no require() in renderer) ──────

function groupHistory(history) {
  const groups = [];
  let i = 0;
  while (i < history.length) {
    const nodeId = history[i];
    let count = 0;
    while (i < history.length && history[i] === nodeId) { count++; i++; }
    groups.push({ nodeId, count, startIdx: i - count });
  }
  return groups;
}

function resolveNode(nodeId, track) {
  if (!state.db) return null;
  const key = String(nodeId);
  if (track.type === 'passive') {
    const classId = String(state.build?.classId ?? 0);
    const treeId  = state.db.classes?.passiveTreeByClass?.[classId];
    return treeId ? (state.db.passives?.[treeId]?.nodes?.[key] ?? null) : null;
  }
  return state.db.skills?.[track.skillKey]?.nodes?.[key] ?? null;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
