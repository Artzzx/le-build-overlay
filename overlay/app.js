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
 *  state.db            — { passives, skills, classes } from db/data/
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
  } catch (err) {
    console.error('[app] Initialization error:', err);
  }

  render();
  subscribeToHotkeys();
  subscribeToReload();
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
  const [passives, skills, classes] = await Promise.all([
    fetchJson('../db/data/passives.json', {}),
    fetchJson('../db/data/skills.json', {}),
    fetchJson('../db/data/classes.json', { classes: {}, masteries: {} }),
  ]);
  return { passives, skills, classes };
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

// ─── Hotkey handlers ──────────────────────────────────────────────────────────

function handleAdvance(trackIndex) {
  const track = state.build?.tracks?.[trackIndex];
  if (!track) return;

  const groups = groupHistory(track.history);
  if (track.currentStep >= groups.length - 1) return; // already at end

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
  const isCompleted = track.currentStep >= groups.length;
  const isExpanded = index === state.expandedTrack && !isCompleted;
  const currentGroup = groups[track.currentStep] ?? null;

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

  // Node / track name
  const nameEl = document.createElement('span');
  nameEl.className = 'track-name';
  if (isCompleted) {
    nameEl.textContent = track.label;
  } else {
    nameEl.textContent = node?.name ?? (track.label);
  }
  header.appendChild(nameEl);

  // Progress: currentStep / totalGroups
  const progressEl = document.createElement('span');
  progressEl.className = 'track-progress';
  progressEl.textContent = `${isCompleted ? groups.length : track.currentStep}/${groups.length}`;
  header.appendChild(progressEl);

  // Hotkey number
  const hotkeyEl = document.createElement('span');
  hotkeyEl.className = 'track-hotkey';
  hotkeyEl.textContent = String(index + 1);
  header.appendChild(hotkeyEl);

  div.appendChild(header);

  // ── Body (expanded only) ─────────────────────────────────────────────────
  if (isExpanded && node) {
    const body = document.createElement('div');
    body.className = 'track-body';

    // Description
    if (node.description) {
      const descEl = document.createElement('div');
      descEl.className = 'track-desc';
      descEl.textContent = node.description;
      body.appendChild(descEl);
    }

    // Point dots
    if (currentGroup && node.maxPoints > 1) {
      const dotsEl = document.createElement('div');
      dotsEl.className = 'track-dots';

      // Count how many points already placed in this node from history
      // (sum of all previous groups with same nodeId — or just group.count context)
      // For simplicity: dots filled = points already allocated in prior occurrences
      const pointsAllocated = 0; // TODO: compute from history if same node repeats

      for (let p = 0; p < node.maxPoints; p++) {
        const dot = document.createElement('span');
        if (p < pointsAllocated) {
          dot.className = `dot filled ${track.type}`;
        } else if (p === pointsAllocated) {
          dot.className = 'dot current';
        } else {
          dot.className = 'dot empty';
        }
        dotsEl.appendChild(dot);
      }
      body.appendChild(dotsEl);
    }

    div.appendChild(body);
  }

  return div;
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
 * @param {number} nodeId
 * @param {object} track
 * @returns {object|null}
 */
function resolveNode(nodeId, track) {
  if (!state.db) return null;
  const key = String(nodeId);
  if (track.type === 'passive') {
    return state.db.passives?.[key] ?? null;
  } else {
    return state.db.skills?.[track.skillKey]?.nodes?.[key] ?? null;
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
