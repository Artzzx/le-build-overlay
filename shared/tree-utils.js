/**
 * shared/tree-utils.js
 * ─────────────────────
 * Pure helpers shared by the main process (Node, via require) and the overlay
 * renderer (browser, via <script> → window.TreeUtils). No fs, no DOM, no Electron.
 *
 * This is the SINGLE source of truth for:
 *  - indexing skill_tree_reconciled.json rows into a per-tree lookup
 *  - grouping a flat history into allocation steps
 *  - resolving a track's nodes against the indexed DB
 *  - stepping a track forward/back inside a multi-phase loadout
 *  - phase-switch carry-over and transition summaries
 *
 * ─── Terminology ─────────────────────────────────────────────────────────────
 *  track.currentStep = number of FLAT history entries already allocated
 *                      (0 = nothing allocated, history.length = complete).
 *  db                = { passives, skills, classes } — passives and skills are
 *                      the same tree map (treeID → { name, nodes }).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TreeUtils = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── DB indexing ────────────────────────────────────────────────────────────

  function hasRealName(row) {
    return typeof row.nodeName === 'string' && row.nodeName !== '' && row.nodeName !== 'Name';
  }

  /**
   * Index flat reconciled rows into { [treeID]: { name, icon, nodes: { [nodeId]: node } } }.
   * `icon` values are paths relative to db/data/icons/ (null = no art); a tree's
   * icon is its root node's (skill trees only — passive trees have no root).
   *
   * The reconciled export can contain several rows for the same (treeID, nodeID)
   * — stale/removed node assets exported next to the live ones. Resolution rule:
   * a row with a real nodeName beats a blank/"Name" placeholder; otherwise the
   * first row wins. Collisions are counted in `duplicates` so callers can log them.
   *
   * @param {object[]} rows - contents of skill_tree_reconciled.json
   * @returns {{ trees: object, duplicates: number }}
   */
  function indexNodes(rows) {
    const trees = {};
    let duplicates = 0;
    for (const row of rows || []) {
      const { treeID, treeName, nodeID, nodeName, description, maxPoints, stats } = row;
      const icon = typeof row.icon === 'string' && row.icon ? row.icon : null;
      if (!trees[treeID]) trees[treeID] = { name: treeName, icon: null, nodes: {} };
      // A skill tree's root node (id 0, no points) carries the skill's own icon.
      if (nodeID === 0 && maxPoints === 0 && icon && !trees[treeID].icon) trees[treeID].icon = icon;
      const key = String(nodeID);
      const existing = trees[treeID].nodes[key];
      if (existing) {
        duplicates++;
        if (hasRealName(existing) || !hasRealName(row)) continue;
      }
      trees[treeID].nodes[key] = { id: nodeID, nodeName, description, maxPoints, stats, icon };
    }
    return { trees, duplicates };
  }

  /** Build the { passives, skills, classes } shape every consumer expects. */
  function makeDb(rows, classes) {
    const { trees, duplicates } = indexNodes(rows);
    return {
      passives: trees,
      skills: trees,
      classes: classes || { classes: {}, masteriesByClass: {}, passiveTreeByClass: {} },
      duplicates,
    };
  }

  // ─── History grouping ───────────────────────────────────────────────────────

  /**
   * [6,6,6,4,4] → [{ nodeId:6, count:3, startIdx:0 }, { nodeId:4, count:2, startIdx:3 }]
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

  /** The group containing the next point to allocate, or null if the track is complete. */
  function findCurrentGroup(groups, currentStep) {
    return groups.find(g => currentStep >= g.startIdx && currentStep < g.startIdx + g.count) ?? null;
  }

  // ─── Node lookup ────────────────────────────────────────────────────────────

  /** Tree for a track: passive → classId → passiveTreeByClass; skill → skillKey (= treeID). */
  function treeForTrack(db, classId, track) {
    if (!db) return null;
    if (track.type === 'passive') {
      const treeId = db.classes?.passiveTreeByClass?.[String(classId ?? 0)];
      return treeId ? (db.passives?.[treeId] ?? null) : null;
    }
    return db.skills?.[track.skillKey] ?? null;
  }

  function lookupNode(db, classId, track, nodeId) {
    return treeForTrack(db, classId, track)?.nodes?.[String(nodeId)] ?? null;
  }

  /** True when the DB has no tree for this track (so its node names can't be shown). */
  function isTrackUnresolved(db, classId, track) {
    return !treeForTrack(db, classId, track);
  }

  // ─── Loadout shape ──────────────────────────────────────────────────────────

  /** Wrap legacy single-phase builds ({ tracks }) into the loadout shape ({ phases }). */
  function normalizeBuild(raw) {
    if (!raw) return null;
    if (raw.phases) return raw;
    if (raw.tracks) {
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
   * Set one track of the active phase to an absolute progress value, clamped to
   * [0, history.length]. Returns the same loadout reference when nothing changes,
   * otherwise a new object (inputs are never mutated).
   */
  function setTrackProgress(loadout, trackIndex, value) {
    const cp = loadout?.currentPhase ?? 0;
    const track = loadout?.phases?.[cp]?.tracks?.[trackIndex];
    if (!track || !Number.isFinite(value)) return loadout;
    const next = Math.max(0, Math.min(track.history.length, Math.trunc(value)));
    if (next === track.currentStep) return loadout;
    return {
      ...loadout,
      phases: loadout.phases.map((phase, i) => i !== cp ? phase : {
        ...phase,
        tracks: phase.tracks.map((t, j) => j === trackIndex ? { ...t, currentStep: next } : t),
      }),
    };
  }

  /** Move one track of the active phase by `delta` points (+1 advance, -1 undo). */
  function stepTrack(loadout, trackIndex, delta) {
    const cp = loadout?.currentPhase ?? 0;
    const track = loadout?.phases?.[cp]?.tracks?.[trackIndex];
    if (!track) return loadout;
    return setTrackProgress(loadout, trackIndex, track.currentStep + delta);
  }

  // ─── Phase switching ────────────────────────────────────────────────────────

  function commonPrefixLength(a, b) {
    let i = 0;
    const len = Math.min(a.length, b.length);
    while (i < len && a[i] === b[i]) i++;
    return i;
  }

  function sameTrack(a, b) {
    return a.type === 'passive' ? b.type === 'passive' : b.skillKey === a.skillKey;
  }

  /**
   * What the player must do when switching fromIdx → toIdx.
   * @returns {{ fromName, toName, unspecNeeded: {label, type, skillKey, amount, isRemove}[] }}
   */
  function computeTransition(phases, fromIdx, toIdx) {
    const fromTracks = phases[fromIdx].tracks;
    const toTracks   = phases[toIdx].tracks;
    const unspecNeeded = [];

    // Shared trees: anything allocated beyond the common history prefix must be unspecced
    toTracks.forEach(toT => {
      const fromT = fromTracks.find(t => sameTrack(toT, t));
      if (!fromT || fromT.currentStep === 0) return;
      const common = commonPrefixLength(fromT.history, toT.history);
      if (fromT.currentStep > common) {
        unspecNeeded.push({ label: toT.label, type: toT.type, skillKey: toT.skillKey, amount: fromT.currentStep - common, isRemove: false });
      }
    });

    // Skills dropped in the new phase must come off the skill bar
    fromTracks.forEach(fromT => {
      if (fromT.type === 'passive' || fromT.currentStep === 0) return;
      if (!toTracks.find(t => t.skillKey === fromT.skillKey)) {
        unspecNeeded.push({ label: fromT.label, type: fromT.type, skillKey: fromT.skillKey, amount: fromT.currentStep, isRemove: true });
      }
    });

    return { fromName: phases[fromIdx].name, toName: phases[toIdx].name, unspecNeeded };
  }

  /** Target phase's currentStep = min(from progress, common prefix); new trees start at 0. */
  function applyCarryOver(phases, fromIdx, toIdx) {
    const fromTracks = phases[fromIdx].tracks;
    return phases.map((phase, i) => {
      if (i !== toIdx) return phase;
      return {
        ...phase,
        tracks: phase.tracks.map(toT => {
          const fromT = fromTracks.find(t => sameTrack(toT, t));
          if (!fromT) return { ...toT, currentStep: 0 };
          const common = commonPrefixLength(fromT.history, toT.history);
          return { ...toT, currentStep: Math.min(fromT.currentStep, common) };
        }),
      };
    });
  }

  return {
    indexNodes,
    makeDb,
    groupHistory,
    findCurrentGroup,
    lookupNode,
    isTrackUnresolved,
    normalizeBuild,
    setTrackProgress,
    stepTrack,
    commonPrefixLength,
    computeTransition,
    applyCarryOver,
  };
}));
