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
 *  - the character state (what's held in game) and entering a phase from it
 *  - guide updates: diffLoadout / mergeProgress (a newer version of the same build)
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

  /**
   * How well a passive history fits a passive tree: points on nodes the tree
   * doesn't have, and points beyond a node's max. A real build fits its own
   * class's tree exactly (0 / 0) — anything else means the class id maps to the
   * wrong tree (see classes.json).
   * @returns {{ missing: number, over: number, fits: boolean }}
   */
  function passiveFit(history, tree) {
    const counts = new Map();
    for (const id of history ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    let missing = 0;
    let over = 0;
    for (const [id, n] of counts) {
      const node = tree?.nodes?.[String(id)];
      if (!node) missing += n;
      else if (Number.isFinite(node.maxPoints) && node.maxPoints > 0 && n > node.maxPoints) over += n - node.maxPoints;
    }
    return { missing, over, fits: !!tree && missing === 0 && over === 0 };
  }

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

  /**
   * Wrap legacy single-phase builds ({ tracks }) into the loadout shape ({ phases }),
   * backfill per-phase masteries, and make sure the character state exists (ensureHeld).
   */
  function normalizeBuild(raw) {
    if (!raw) return null;
    let b = raw;
    if (!b.phases && b.tracks) {
      b = {
        name:         raw.name,
        classId:      raw.classId,
        masteryId:    raw.masteryId,
        currentPhase: 0,
        phases: [{ name: 'Main', masteryId: raw.masteryId ?? 0, tracks: raw.tracks }],
      };
    }
    if (!b.phases) return null;
    // Each phase carries its own mastery (0 = plain class); older files only had loadout.masteryId.
    if (!b.phases.every(p => typeof p.masteryId === 'number')) {
      b = { ...b, phases: b.phases.map(p => (typeof p.masteryId === 'number' ? p : { ...p, masteryId: b.masteryId ?? 0 })) };
    }
    return ensureHeld(b);
  }

  // ─── Character state ────────────────────────────────────────────────────────
  //
  // build.held    = { passive: { [nodeId]: points }, [skillKey]: { … } } — what the
  //                 character has in game, per tree, whatever the phase. Skills not used
  //                 by the current phase stay here while they're still specialized.
  // build.mastery = the mastery the character has chosen (0 = none yet).
  //
  // Invariant: for every track of the CURRENT phase, held[key] ⊇ the counts of
  // history[0, currentStep). Entering a phase reorders its route so the points the
  // character already holds come first (rebaseTrack), so progress stays a flat prefix.

  const trackKey = (t) => (t.type === 'passive' ? 'passive' : t.skillKey);
  /** The route as the guide gives it (a phase entry may have reordered `history`). */
  const guideRoute = (t) => t.guide ?? t.history;
  const total = (counts) => Object.values(counts ?? {}).reduce((a, n) => a + n, 0);

  function countPoints(history, upTo = history.length) {
    const out = {};
    for (let i = 0; i < upTo; i++) out[history[i]] = (out[history[i]] ?? 0) + 1;
    return out;
  }

  /** Builds saved before the character state existed: derive it from the current phase. */
  function ensureHeld(b) {
    if (b.held && typeof b.held === 'object' && typeof b.mastery === 'number') return b;
    const phase = b.phases[b.currentPhase ?? 0] ?? b.phases[0];
    const held = {};
    let any = false;
    for (const t of phase.tracks) {
      held[trackKey(t)] = countPoints(t.history, t.currentStep ?? 0);
      if (t.currentStep > 0) any = true;
    }
    // Someone already playing the phase has picked its mastery; a fresh load hasn't picked any.
    return { ...b, held, mastery: any ? (phase.masteryId ?? 0) : 0 };
  }

  /** Move held points of `key` from the old prefix to the new one (both of `history`). */
  function shiftHeld(held, key, history, from, to) {
    if (!held || from === to) return held;
    const tree = { ...(held[key] ?? {}) };
    if (to > from) for (let i = from; i < to; i++) tree[history[i]] = (tree[history[i]] ?? 0) + 1;
    else for (let i = to; i < from; i++) { const n = history[i]; tree[n] = Math.max(0, (tree[n] ?? 0) - 1); if (!tree[n]) delete tree[n]; }
    return { ...held, [key]: tree };
  }

  /**
   * Set one track of the active phase to an absolute progress value, clamped to
   * [0, history.length], keeping the character state in step. Returns the same
   * loadout reference when nothing changes, otherwise a new object.
   */
  function setTrackProgress(loadout, trackIndex, value) {
    const cp = loadout?.currentPhase ?? 0;
    const track = loadout?.phases?.[cp]?.tracks?.[trackIndex];
    if (!track || !Number.isFinite(value)) return loadout;
    const next = Math.max(0, Math.min(track.history.length, Math.trunc(value)));
    if (next === track.currentStep) return loadout;
    return {
      ...loadout,
      held: shiftHeld(loadout.held, trackKey(track), track.history, track.currentStep, next),
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

  // ─── Entering a phase ───────────────────────────────────────────────────────

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
   * A track's route with the points the character already holds moved to the front
   * (in the guide's order), the rest after them (also in the guide's order).
   * The game only cares how many points each node has, never in which order they
   * were taken — so a route that takes the same nodes in another order loses nothing.
   * @returns {{ track, kept, surplus }} kept/surplus: { [nodeId]: points }
   */
  function rebaseTrack(track, held = {}) {
    const route = guideRoute(track);
    const left = { ...held };
    const covered = route.map(n => (left[n] > 0 ? (left[n]--, true) : false));
    const have = route.filter((_, i) => covered[i]);
    const history = [...have, ...route.filter((_, i) => !covered[i])];
    const surplus = {};
    for (const n in left) if (left[n] > 0) surplus[n] = left[n];
    const { guide, ...rest } = track;
    const reordered = history.some((n, i) => n !== route[i]);
    return {
      track: { ...rest, history, currentStep: have.length, ...(reordered ? { guide: route } : {}) },
      kept: countPoints(have),
      surplus,
    };
  }

  /** Specialization slots unlock at these character levels (5 slots in total). */
  const SLOT_LEVELS = [4, 8, 20, 35, 50];
  const slotsAt = (level) => (Number.isFinite(level) ? SLOT_LEVELS.filter(l => l <= level).length : SLOT_LEVELS.length);

  /**
   * The order to take surplus points off in game: the reverse of the order they
   * were taken (a node picked later can depend on an earlier one, never the other
   * way round). `taken` = the route the points came from; nodes not in it go last.
   */
  function removalOrder(surplus, held, taken = []) {
    const last = {};
    taken.forEach((n, i) => { last[n] = i; });
    return Object.keys(surplus)
      .map(n => ({ nodeId: Number(n), remove: surplus[n], from: held[n] ?? surplus[n], to: (held[n] ?? surplus[n]) - surplus[n] }))
      .sort((a, b) => (last[b.nodeId] ?? -1) - (last[a.nodeId] ?? -1) || a.nodeId - b.nodeId);
  }

  /**
   * Put the character into phase `to` of `phases` (the build's own phases, or a
   * newer version of them after a guide update). The character state is NOT
   * changed here: what to do in game becomes `build.pending`, applied by
   * applyPending() when the player confirms it's done (so a misclicked switch
   * loses nothing).
   *
   * Forward (or a guide update): unspec only points the new routes don't want
   * (node by node, in a safe order); skills the phase doesn't use stay specialized
   * when a slot is free and they come back, otherwise they're to be despecialized
   * (all points lost); a different mastery is to be chosen.
   * Backward: nothing to do in game.
   *
   * @returns {{ build, transition }} transition = null when there is nothing to tell
   *   { toPhase, fromName, toName, forward,
   *     unspecNeeded: [{ type, skillKey, label, amount, isRemove, backIn?, nodes?: [{ nodeId, remove, from, to }] }],
   *     keptSkills: [{ skillKey, label, points, backIn }], masteryChange: { from, to } | null }
   */
  function enterPhase(build, phases, to, { forward = true, fromName = null, takenFrom = null } = {}) {
    const b = ensureHeld(build);
    const target = phases[to];
    const held = b.held;
    const unspecNeeded = [];
    const keptSkills = [];
    const takenRoute = (key) => {
      const t = takenFrom?.tracks.find(x => trackKey(x) === key);
      return t ? t.history.slice(0, t.currentStep) : [];
    };

    const tracks = target.tracks.map(t => {
      const key = trackKey(t);
      const r = rebaseTrack(t, held[key]);
      const extra = total(r.surplus);
      if (forward && extra) {
        unspecNeeded.push({
          type: t.type, skillKey: t.skillKey, label: t.label, amount: extra, isRemove: false,
          nodes: removalOrder(r.surplus, held[key] ?? {}, takenRoute(key)),
        });
      }
      return r.track;
    });

    let masteryChange = null;
    if (forward) {
      // Skills held but not used here: keep them specialized if a slot is free and they come back.
      const inTarget = new Set(target.tracks.map(trackKey));
      const labelOf = (k) => phases.flatMap(p => p.tracks).find(t => t.skillKey === k)?.label
        ?? b.phases.flatMap(p => p.tracks).find(t => t.skillKey === k)?.label ?? k;
      const nextUse = (k) => {
        const i = phases.findIndex((p, j) => j > to && p.tracks.some(t => t.skillKey === k));
        return i < 0 ? Infinity : i;
      };
      const benched = Object.keys(held)
        .filter(k => k !== 'passive' && !inTarget.has(k) && total(held[k]) > 0)
        .sort((x, y) => nextUse(x) - nextUse(y));
      let free = Math.max(0, slotsAt(target.level) - target.tracks.filter(t => t.type === 'skill').length);
      for (const k of benched) {
        const back = nextUse(k);
        const backIn = Number.isFinite(back) ? phases[back].name : null;
        const points = total(held[k]);
        if (backIn && free > 0) {
          free--;
          keptSkills.push({ skillKey: k, label: labelOf(k), points, backIn });
        } else {
          unspecNeeded.push({ type: 'skill', skillKey: k, label: labelOf(k), amount: points, isRemove: true, backIn });
        }
      }
      const m = target.masteryId ?? 0;
      if (m > 0 && m !== b.mastery) masteryChange = { from: b.mastery ?? 0, to: m };
    }

    const hasNews = unspecNeeded.length || keptSkills.length || masteryChange;
    const transition = hasNews ? { toPhase: to, fromName, toName: target.name, forward, unspecNeeded, keptSkills, masteryChange } : null;
    return {
      build: { ...b, currentPhase: to, phases: phases.map((p, i) => (i === to ? { ...p, tracks } : p)) },
      transition,
    };
  }

  /**
   * Switch the build to phase `to` (see enterPhase). Forward: the new instructions
   * replace any pending ones — applied first when they were for the phase being left. Backward: pending instructions are kept — a
   * misclick back and forth never hides them.
   */
  function switchPhase(build, to) {
    let b = ensureHeld(build);
    const from = b.currentPhase ?? 0;
    const forward = to > from;
    // Moving on from the phase the pending instructions were for = the player played it,
    // so they did them (e.g. despecialized a skill) even if Done wasn't pressed. Instructions
    // for another phase (a misclick forward, then back) are never assumed done.
    if (forward && b.pending && b.pending.toPhase === from) b = applyPending(b);
    const r = enterPhase(b, b.phases, to, { forward, fromName: b.phases[from]?.name ?? null, takenFrom: b.phases[from] });
    const pending = forward ? r.transition : (b.pending ?? null);
    return { build: { ...r.build, pending }, transition: pending };
  }

  /**
   * The player did what `build.pending` asked in game: take the unspecced points
   * off, drop despecialized skills, set the mastery. Never takes off points the
   * current phase counts as allocated (in case the player moved on meanwhile).
   */
  function applyPending(build) {
    const p = build?.pending;
    if (!p) return build;
    const held = { ...build.held };
    const phase = build.phases[build.currentPhase ?? 0];
    const floor = (key) => {
      const t = phase?.tracks.find(x => trackKey(x) === key);
      return t ? countPoints(t.history, t.currentStep) : {};
    };
    for (const u of p.unspecNeeded ?? []) {
      const key = u.type === 'passive' ? 'passive' : u.skillKey;
      if (u.isRemove) {
        if (!phase?.tracks.some(x => trackKey(x) === key)) delete held[key];
        continue;
      }
      const tree = { ...(held[key] ?? {}) };
      const min = floor(key);
      for (const n of u.nodes ?? []) {
        const next = Math.max(min[n.nodeId] ?? 0, (tree[n.nodeId] ?? 0) - n.remove);
        if (next > 0) tree[n.nodeId] = next; else delete tree[n.nodeId];
      }
      held[key] = tree;
    }
    return { ...build, held, mastery: p.masteryChange ? p.masteryChange.to : build.mastery, pending: null };
  }

  /**
   * Full clear: every phase back to 0, the character holds nothing, no mastery,
   * no pending instructions, back to the first phase. Routes return to the guide's
   * order. The build itself (phases, routes, source) is untouched.
   */
  function clearProgress(build) {
    if (!build?.phases) return build;
    return {
      ...build,
      currentPhase: 0,
      held: {},
      mastery: 0,
      pending: null,
      phases: build.phases.map(p => ({
        ...p,
        tracks: p.tracks.map(({ guide, ...t }) => ({ ...t, history: guide ?? t.history, currentStep: 0 })),
      })),
    };
  }

  /** True when any point is allocated in any phase, or the character holds anything. */
  function hasProgress(build) {
    return !!build?.phases?.some(p => p.tracks.some(t => t.currentStep > 0))
      || Object.values(build?.held ?? {}).some(tree => total(tree) > 0);
  }

  // ─── Guide updates (same build, newer version of the guide) ─────────────────

  /**
   * What changed between two versions of the same loadout, phase by phase
   * (phases are paired by index — the caller lines them up). Routes are compared
   * as the guide gives them, not as reordered on entering a phase.
   * @returns {{ changed: boolean, phases: { index, name, added: object[], removed: object[], changed: object[], masteryChange }[] }}
   *   added/removed: { type, skillKey, label, points }; changed: { type, skillKey, label, before, after, common }
   */
  function diffLoadout(oldBuild, newBuild) {
    const phases = newBuild.phases.map((np, index) => {
      const op = oldBuild.phases[index] ?? { tracks: [] };
      const added = [];
      const changed = [];
      np.tracks.forEach(nt => {
        const ot = op.tracks.find(t => sameTrack(nt, t));
        if (!ot) { added.push({ type: nt.type, skillKey: nt.skillKey, label: nt.label, points: guideRoute(nt).length }); return; }
        const before = guideRoute(ot);
        const after = guideRoute(nt);
        const common = commonPrefixLength(before, after);
        if (common !== before.length || common !== after.length) {
          changed.push({ type: nt.type, skillKey: nt.skillKey, label: nt.label, before: before.length, after: after.length, common });
        }
      });
      const removed = op.tracks
        .filter(ot => !np.tracks.some(nt => sameTrack(nt, ot)))
        .map(ot => ({ type: ot.type, skillKey: ot.skillKey, label: ot.label, points: guideRoute(ot).length }));
      const masteryChange = typeof op.masteryId === 'number' && op.masteryId !== np.masteryId ? { from: op.masteryId, to: np.masteryId } : null;
      return { index, name: np.name, added, removed, changed, masteryChange };
    });
    const changed = newBuild.phases.length !== oldBuild.phases.length
      || phases.some(p => p.added.length || p.removed.length || p.changed.length || p.masteryChange);
    return { changed, phases };
  }

  /**
   * The new version of the guide with the character carried over: the phase being
   * played is re-entered from what the character holds (enterPhase), so every point
   * the new routes still want is kept, in any order. Other phases take the new
   * routes and are rebased when the player switches to them.
   * `transition` = what to do in game (enterPhase's shape), or null.
   */
  function mergeProgress(oldBuild, newBuild) {
    const b = ensureHeld(oldBuild);
    const cur = Math.min(b.currentPhase ?? 0, newBuild.phases.length - 1);
    const phases = newBuild.phases.map(p => ({ ...p, tracks: p.tracks.map(({ guide, ...t }) => ({ ...t, currentStep: 0 })) }));
    const { build, transition } = enterPhase({ ...newBuild, held: b.held, mastery: b.mastery, currentPhase: cur }, phases, cur, {
      forward: true, fromName: b.phases[cur]?.name ?? null, takenFrom: b.phases[cur],
    });
    const pending = transition ? { ...transition, reason: 'update' } : (b.pending ?? null);
    return { build: { ...build, pending }, transition: pending };
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
    rebaseTrack,
    switchPhase,
    applyPending,
    clearProgress,
    hasProgress,
    slotsAt,
    passiveFit,
    diffLoadout,
    mergeProgress,
  };
}));
