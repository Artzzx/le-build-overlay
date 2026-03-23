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
 *  5. On reload-build event: re-initialize from disk
 *
 * ─── State model ─────────────────────────────────────────────────────────────
 *
 *  state.build         — full normalized build object (see build-schema.js)
 *  state.db            — { passives, skills, classes } parsed from db/data/skill_tree_reconciled.json + classes.json
 *  state.expandedTrack — index of the track row currently expanded (0-based)
 *  state.visible       — whether the overlay div is showing
 *
 * ─── Rendering ───────────────────────────────────────────────────────────────
 *
 *  The DOM is fully re-rendered on each state change (simple, predictable).
 *  Each track renders as:
 *    [collapsed] .track-badge + .track-name + .track-progress + .track-hotkey
 *    [expanded]  + .track-body (description + point dots)
 *
 * ─── Data flow for a hotkey press ────────────────────────────────────────────
 *
 *  main.js globalShortcut → IPC 'hotkey' → preload.js onHotkey → app.js handler
 *  → advance/undo in state.build → re-render → electronAPI.saveBuild(state.build)
 *
 * ─── Important: no require() ─────────────────────────────────────────────────
 *
 *  This file runs in the renderer (web context). All Node.js functionality
 *  (file I/O, path resolution) must go through electronAPI (preload.js bridge).
 *  Build data is loaded via fetch() from relative paths, which works because
 *  Electron loads index.html via file:// protocol with the project root as base.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  build: null,           // normalized build (from config/build.json)
  db: null,              // { passives, skills, classes }
  expandedTrack: 0,      // 0-based index of expanded track row
  visible: true,         // overlay visibility
  settings: null,        // last-received settings object (for display toggles)
  positionMode: false,   // true while drag/resize mode is active
};

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Entry point — called once on page load.
 * Loads data files, renders UI, subscribes to IPC events.
 */
async function init() {
  try {
    // Load DB data (may be empty if extractor hasn't been run yet)
    state.db = await loadDb();

    // Load user's active build (may not exist on first run)
    state.build = await loadBuild();

    // Fetch initial settings from main so display toggles apply on the very first render.
    // This is necessary because the 'settings-changed' IPC sent by did-finish-load can
    // arrive before subscribeToSettings() registers its listener (during the awaits above).
    if (window.electronAPI?.getSettings) {
      const s = await window.electronAPI.getSettings();
      if (s) state.settings = s;
    }
  } catch (err) {
    console.error('[app] Initialization error:', err);
  }

  // Apply CSS variables and always-progress class before first render
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

/**
 * Load the active build from config/build.json.
 * Returns null if the file doesn't exist or is invalid.
 *
 * NOTE: In Electron, fetch() with a relative URL resolves against the
 * file:// path of index.html. The relative path '../config/build.json'
 * navigates up from overlay/ to the project root, then into config/.
 *
 * @returns {object|null}
 */
async function loadBuild() {
  try {
    const res = await fetch('../config/build.json');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Load all game data JSONs from db/data/.
 * Returns an object with passives/skills/classes, each empty if file missing.
 *
 * @returns {{ passives: object, skills: object, classes: object }}
 */
async function loadDb() {
  const [rawNodes, classes] = await Promise.all([
    fetchJson('../db/data/skill_tree_reconciled.json', []),
    fetchJson('../db/data/classes.json', { classes: {}, masteries: {} }),
  ]);

  // Parse flat array into { [treeID]: { name, nodes: { [nodeID]: node } } }
  const trees = {};
  for (const { treeID, treeName, nodeID, nodeName, description, maxPoints, stats } of rawNodes) {
    if (!trees[treeID]) trees[treeID] = { name: treeName, nodes: {} };
    trees[treeID].nodes[String(nodeID)] = { id: nodeID, nodeName, description, maxPoints, stats };
  }

  // passives and skills share the same unified map
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
    const { action, trackIndex, visible } = payload;

    if (action === 'toggle') {
      state.visible = visible;
      // The window itself is hidden/shown by main.js; this just syncs internal state
      return;
    }

    if (!state.build) return;

    if (action === 'advance') {
      handleAdvance(trackIndex);
    } else if (action === 'undo') {
      handleUndo(trackIndex);
    }
  });
}

function subscribeToReload() {
  if (!window.electronAPI?.onReloadBuild) return;
  window.electronAPI.onReloadBuild(async () => {
    state.build = await loadBuild();
    state.expandedTrack = 0;
    render();
  });
}

function subscribeToSettings() {
  if (!window.electronAPI?.onSettingsChanged) return;
  window.electronAPI.onSettingsChanged((s) => applyDisplaySettings(s));
}

/**
 * Apply display settings as CSS custom properties and re-render if needed.
 * @param {object} s - settings object from main
 */
function applyDisplaySettings(s) {
  if (!s?.display) return;
  state.settings = s;
  const root = document.documentElement;
  root.style.setProperty('--font-size-base', `${s.display.fontSize}px`);
  const bg = `rgba(6, 8, 14, ${s.display.opacity})`;
  root.style.setProperty('--bg', bg);
  // Toggle always-progress class on overlay root
  const overlayRoot = document.getElementById('overlay-root');
  overlayRoot?.classList.toggle('always-progress', s.display.alwaysShowProgress ?? false);
  // Re-render so description / inline progress toggles take effect immediately
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
  const overlayRoot = document.getElementById('overlay-root');
  overlayRoot?.classList.add('position-mode');
  document.getElementById('position-bar')?.classList.remove('hidden');
  document.querySelectorAll('.resize-grip').forEach(g => g.classList.remove('hidden'));
}

function exitPositionMode() {
  state.positionMode = false;
  const overlayRoot = document.getElementById('overlay-root');
  overlayRoot?.classList.remove('position-mode');
  document.getElementById('position-bar')?.classList.add('hidden');
  document.querySelectorAll('.resize-grip').forEach(g => g.classList.add('hidden'));
}

/**
 * Wire up drag (position bar) and resize (corner grips) mouse event handlers.
 * Called once on init after DOM is ready.
 */
function initPositionModeUI() {
  const posBar = document.getElementById('position-bar');
  const doneBtn = document.getElementById('pos-done-btn');

  if (!posBar || !doneBtn) return;

  // ── Drag to move ─────────────────────────────────────────────────────────
  let dragging = false;
  let lastX = 0, lastY = 0;

  posBar.addEventListener('mousedown', (e) => {
    if (e.target === doneBtn) return; // don't start drag when clicking Done
    dragging = true;
    lastX = e.screenX;
    lastY = e.screenY;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    lastX = e.screenX;
    lastY = e.screenY;
    window.electronAPI?.moveWindow?.(dx, dy);
  });

  document.addEventListener('mouseup', () => { dragging = false; });

  // ── Done button ───────────────────────────────────────────────────────────
  doneBtn.addEventListener('click', () => {
    window.electronAPI?.endPositionMode?.();
  });

  // ── Resize grips ──────────────────────────────────────────────────────────
  document.querySelectorAll('.resize-grip').forEach((grip) => {
    const corner = grip.dataset.corner; // 'nw' | 'ne' | 'sw' | 'se'
    let resizing = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;

    grip.addEventListener('mousedown', (e) => {
      resizing = true;
      startX = e.screenX;
      startY = e.screenY;
      startW = window.innerWidth;
      startH = window.innerHeight;
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      let newW = startW;
      let newH = startH;
      // East edges grow right, west edges grow left (invert dx)
      if (corner.includes('e')) newW = startW + dx;
      if (corner.includes('w')) newW = startW - dx;
      if (corner.includes('s')) newH = startH + dy;
      if (corner.includes('n')) newH = startH - dy;
      window.electronAPI?.resizeWindow?.(
        Math.max(180, Math.round(newW)),
        Math.max(200, Math.round(newH))
      );
    });

    document.addEventListener('mouseup', () => { resizing = false; });
  });
}

// ─── Hotkey handlers ──────────────────────────────────────────────────────────

function handleAdvance(trackIndex) {
  const track = state.build?.tracks?.[trackIndex];
  if (!track) return;

  if (track.currentStep >= track.history.length) return; // already completed

  // Update state (immutable-ish)
  state.build = {
    ...state.build,
    tracks: state.build.tracks.map((t, i) =>
      i === trackIndex ? { ...t, currentStep: t.currentStep + 1 } : t
    ),
  };

  state.expandedTrack = trackIndex;
  render();
  flashTrack(trackIndex);
  persistBuild();
}

function handleUndo(trackIndex) {
  const track = state.build?.tracks?.[trackIndex];
  if (!track || track.currentStep <= 0) return;

  state.build = {
    ...state.build,
    tracks: state.build.tracks.map((t, i) =>
      i === trackIndex ? { ...t, currentStep: t.currentStep - 1 } : t
    ),
  };

  state.expandedTrack = trackIndex;
  render();
  persistBuild();
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function persistBuild() {
  if (!window.electronAPI?.saveBuild || !state.build) return;
  window.electronAPI.saveBuild(state.build);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function render() {
  const root = document.getElementById('overlay-root');
  const noBuildMsg = document.getElementById('no-build-msg');
  const tracksEl = document.getElementById('tracks');

  if (!state.build || !state.build.tracks?.length) {
    noBuildMsg.classList.remove('hidden');
    tracksEl.innerHTML = '';
    return;
  }

  noBuildMsg.classList.add('hidden');
  tracksEl.innerHTML = '';

  state.build.tracks.forEach((track, index) => {
    const el = renderTrack(track, index);
    tracksEl.appendChild(el);
  });
}

/**
 * Build the DOM element for a single track row.
 *
 * @param {object} track - normalized track object
 * @param {number} index - 0-based index (used for hotkey label)
 * @returns {HTMLElement}
 */
function renderTrack(track, index) {
  const groups = groupHistory(track.history);
  const isCompleted = track.currentStep >= track.history.length;
  const isExpanded = index === state.expandedTrack && !isCompleted;

  // Find which group contains the current flat history position
  const currentGroup = groups.find(
    g => track.currentStep >= g.startIdx && track.currentStep < g.startIdx + g.count
  ) ?? null;

  // How many points within the current node have been allocated
  const pointsInNode = currentGroup ? track.currentStep - currentGroup.startIdx : 0;

  // Resolve current node info from DB
  const node = currentGroup ? resolveNode(currentGroup.nodeId, track) : null;

  // Wrapper div
  const div = document.createElement('div');
  div.className = 'track'
    + (isExpanded ? ' expanded' : '')
    + (isCompleted ? ' completed' : '');
  div.dataset.trackIndex = index;

  // ── Header ──────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'track-header';

  // [P] or [S] badge
  const badge = document.createElement('span');
  badge.className = `track-badge ${track.type}`;
  badge.textContent = track.type === 'passive' ? 'P' : 'S';
  header.appendChild(badge);

  // Node / track name — format: "Skill Label — Node Name" (or just label when completed)
  const nameEl = document.createElement('span');
  nameEl.className = 'track-name';
  if (isCompleted) {
    nameEl.textContent = track.label;
  } else {
    const nodeName = node?.nodeName || node?.name;
    nameEl.textContent = nodeName ? `${track.label} \u2014 ${nodeName}` : track.label;
  }
  header.appendChild(nameEl);

  // Progress: currentStep / totalGroups
  const progressEl = document.createElement('span');
  progressEl.className = 'track-progress';
  progressEl.textContent = `${track.currentStep}/${track.history.length}`;
  header.appendChild(progressEl);

  // Hotkey number
  const hotkeyEl = document.createElement('span');
  hotkeyEl.className = 'track-hotkey';
  hotkeyEl.textContent = String(index + 1);
  header.appendChild(hotkeyEl);

  div.appendChild(header);

  // ── Inline progress (always-progress mode, hidden when expanded) ──────────
  if (!isCompleted && currentGroup && currentGroup.count > 0) {
    const inlineEl = document.createElement('div');
    inlineEl.className = 'track-progress-inline';
    buildProgressContent(inlineEl, pointsInNode, currentGroup.count, track.type);
    div.appendChild(inlineEl);
  }

  // ── Body (expanded only) ─────────────────────────────────────────────────
  if (isExpanded && node) {
    const body = document.createElement('div');
    body.className = 'track-body';

    // Description (respects showDescription setting)
    const showDesc = state.settings?.display?.showDescription ?? true;
    if (node.description && showDesc) {
      const descEl = document.createElement('div');
      descEl.className = 'track-desc';
      descEl.textContent = node.description;
      body.appendChild(descEl);
    }

    // Point dots + pts label
    if (currentGroup && currentGroup.count > 0) {
      buildProgressContent(body, pointsInNode, currentGroup.count, track.type);
    }

    div.appendChild(body);
  }

  return div;
}

/**
 * Append pts label + dots to a container element.
 * Shared by the expanded body and the always-visible inline progress.
 *
 * @param {HTMLElement} container
 * @param {number} pointsInNode - points already applied within current step
 * @param {number} stepCount - total points required by this build step (group.count)
 * @param {string} trackType - 'passive' | 'skill' (for dot color class)
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
      if (p < pointsInNode) {
        dot.className = `dot filled ${trackType}`;
      } else if (p === pointsInNode) {
        dot.className = 'dot current';
      } else {
        dot.className = 'dot empty';
      }
      dotsEl.appendChild(dot);
    }
    container.appendChild(dotsEl);
  }
}

/**
 * Flash a track row with a green border for 200ms (visual feedback on advance).
 * @param {number} trackIndex
 */
function flashTrack(trackIndex) {
  const trackEls = document.querySelectorAll('.track');
  const el = trackEls[trackIndex];
  if (!el) return;

  el.classList.remove('flashing'); // reset if already flashing
  // Force reflow to re-trigger animation
  void el.offsetWidth;
  el.classList.add('flashing');

  setTimeout(() => el.classList.remove('flashing'), 250);
}

// ─── Utility (mirrored from build-schema.js — no require() in renderer) ──────

/**
 * Collapse flat history array into grouped steps.
 * (Duplicated from build-schema.js because renderer can't require Node modules.)
 *
 * @param {number[]} history
 * @returns {{ nodeId: number, count: number, startIdx: number }[]}
 */
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

/**
 * Resolve nodeId → node info from the in-memory db.
 *
 * Passive: uses state.build.classId → passiveTreeByClass → treeID → node
 * Skill:   uses track.skillKey (= treeID) → node
 *
 * @param {number} nodeId
 * @param {object} track
 * @returns {object|null}
 */
function resolveNode(nodeId, track) {
  if (!state.db) return null;
  const key = String(nodeId);
  if (track.type === 'passive') {
    const classId = String(state.build?.classId ?? 0);
    const treeId  = state.db.classes?.passiveTreeByClass?.[classId];
    return treeId ? (state.db.passives?.[treeId]?.nodes?.[key] ?? null) : null;
  } else {
    return state.db.skills?.[track.skillKey]?.nodes?.[key] ?? null;
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
