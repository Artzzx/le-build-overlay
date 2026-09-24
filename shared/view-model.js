/**
 * shared/view-model.js
 * ─────────────────────
 * Pure derivation of everything the UI renders for a loadout: one "lane" per
 * track (passive + skills) with its allocation path, the node to allocate NOW,
 * what comes NEXT, and progress totals.
 *
 * UMD like tree-utils.js: `require()` in Node (tests), `window.ViewModel` in the
 * renderer. Depends on TreeUtils (passed in Node, global in the browser).
 *
 * ─── Lane shape ──────────────────────────────────────────────────────────────
 * {
 *   index, hotkey,            // 0-based position, 1-based key label
 *   colorSlot,                // buildView only: 0 passive, 1–5 skills (stable across phases)
 *   type, treeId, treeIcon, title, subtitle,
 *   unresolved,               // no tree data → cannot be advanced
 *   done, total, pct, complete,
 *   steps: Step[],            // one per history group, in allocation order
 *   nowIdx,                   // index into steps of the current step (-1 when complete)
 *   now, next, upcoming,      // Step | null, Step | null, Step[] (after next)
 * }
 * Step: {
 *   idx, nodeId, count, startIdx, state: 'done'|'current'|'upcoming',
 *   pointsDone,               // points of THIS step already allocated
 *   nodeTotalAfter,           // points in this node once this step is done
 *   name, description, maxPoints, stats, known,
 *   icon,                     // art path relative to db/data/icons/, or null
 *   iconKey,                  // "<treeId>/<nodeId>" — stable seed for the placeholder glyph
 * }
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tree-utils'));
  } else {
    root.ViewModel = factory(root.TreeUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (TreeUtils) {
  'use strict';

  const { groupHistory, lookupNode, isTrackUnresolved } = TreeUtils;

  function className(db, classId) {
    return db?.classes?.classes?.[String(classId)] ?? null;
  }

  /** Mastery name, or null for mastery 0 (no mastery chosen yet — the plain class). */
  function masteryName(db, classId, masteryId) {
    if (!masteryId) return null;
    return db?.classes?.masteriesByClass?.[String(classId)]?.[String(masteryId)] ?? null;
  }

  function passiveTreeId(db, classId) {
    return db?.classes?.passiveTreeByClass?.[String(classId)] ?? null;
  }

  /** Title/subtitle for a lane header. Prefers live DB names over labels baked into build.json. */
  function laneTitles(track, ctx) {
    const { db, classId, masteryId } = ctx;
    if (track.type === 'passive') {
      const cls = className(db, classId);
      const mastery = masteryName(db, classId, masteryId);
      return {
        treeId: passiveTreeId(db, classId),
        treeIcon: null, // class passive trees have no root node / emblem in the data
        title: mastery ?? cls ?? track.label,
        subtitle: cls ? `${cls} passives` : 'Passive tree',
      };
    }
    const tree = db?.skills?.[track.skillKey];
    return { treeId: track.skillKey, treeIcon: tree?.icon ?? null, title: tree?.name || track.label || track.skillKey, subtitle: 'Skill tree' };
  }

  /**
   * Build the lane view-model for one track.
   * @param {object} track  - { type, skillKey?, label, history, currentStep }
   * @param {number} index  - position in the phase's track list
   * @param {{ db, classId, masteryId }} ctx
   */
  function buildLane(track, index, ctx) {
    const { db, classId } = ctx;
    const { treeId, treeIcon, title, subtitle } = laneTitles(track, ctx);
    const unresolved = isTrackUnresolved(db, classId, track);
    const total = track.history.length;
    const done = Math.max(0, Math.min(total, track.currentStep));

    const nodeCounts = new Map();
    const steps = groupHistory(track.history).map((g, idx) => {
      const end = g.startIdx + g.count;
      const state = done >= end ? 'done' : done >= g.startIdx ? 'current' : 'upcoming';
      const nodeTotalAfter = (nodeCounts.get(g.nodeId) ?? 0) + g.count;
      nodeCounts.set(g.nodeId, nodeTotalAfter);
      const node = lookupNode(db, classId, track, g.nodeId);
      return {
        idx,
        nodeId: g.nodeId,
        count: g.count,
        startIdx: g.startIdx,
        state,
        pointsDone: state === 'done' ? g.count : state === 'current' ? done - g.startIdx : 0,
        nodeTotalAfter,
        name: node?.nodeName || `Node ${g.nodeId}`,
        description: node?.description ?? '',
        maxPoints: node?.maxPoints ?? null,
        stats: node?.stats ?? [],
        known: !!node,
        icon: node?.icon ?? null,
        iconKey: `${treeId ?? 'unknown'}/${g.nodeId}`,
      };
    });

    const nowIdx = steps.findIndex(s => s.state === 'current');
    return {
      index,
      hotkey: index + 1,
      type: track.type,
      treeId,
      treeIcon,
      title,
      subtitle,
      unresolved,
      done,
      total,
      pct: total ? done / total : 0,
      complete: done >= total,
      steps,
      nowIdx,
      now: nowIdx >= 0 ? steps[nowIdx] : null,
      next: nowIdx >= 0 ? (steps[nowIdx + 1] ?? null) : null,
      upcoming: nowIdx >= 0 ? steps.slice(nowIdx + 2) : [],
    };
  }

  const SKILL_COLOR_SLOTS = 5;

  /**
   * Colour slot per tree, stable across every phase of the loadout, so a skill
   * keeps its colour when phases reorder or drop skills. Passive = 0; skills get
   * 1..5 in order of first appearance.
   */
  function colorSlots(loadout) {
    const slots = new Map();
    for (const phase of loadout?.phases ?? []) {
      for (const t of phase.tracks ?? []) {
        if (t.type === 'skill' && !slots.has(t.skillKey)) {
          slots.set(t.skillKey, 1 + (slots.size % SKILL_COLOR_SLOTS));
        }
      }
    }
    return slots;
  }

  /**
   * View-model for the whole active phase.
   * @returns {{ name, classLabel, phases, currentPhase, lanes, done, total, pct }}
   */
  function buildView(loadout, db) {
    if (!loadout?.phases?.length) return null;
    const currentPhase = Math.min(Math.max(loadout.currentPhase ?? 0, 0), loadout.phases.length - 1);
    // Mastery is per phase (leveling can be the plain class, mastery 0).
    const phaseMastery = (p) => (typeof p?.masteryId === 'number' ? p.masteryId : loadout.masteryId);
    const masteryId = phaseMastery(loadout.phases[currentPhase]);
    const ctx = { db, classId: loadout.classId, masteryId };
    const slots = colorSlots(loadout);
    const lanes = loadout.phases[currentPhase].tracks.map((t, i) => ({
      ...buildLane(t, i, ctx),
      colorSlot: t.type === 'passive' ? 0 : (slots.get(t.skillKey) ?? 1),
    }));
    const done = lanes.reduce((n, l) => n + l.done, 0);
    const total = lanes.reduce((n, l) => n + l.total, 0);
    const cls = className(db, loadout.classId);
    const mastery = masteryName(db, loadout.classId, masteryId);
    return {
      name: loadout.name,
      classLabel: [cls, mastery].filter(Boolean).join(' · ') || `Class ${loadout.classId}`,
      masteryId,
      phases: loadout.phases.map((p, i) => ({
        index: i,
        name: p.name,
        masteryId: phaseMastery(p),
        masteryName: masteryName(db, loadout.classId, phaseMastery(p)),
      })),
      currentPhase,
      lanes,
      done,
      total,
      pct: total ? done / total : 0,
    };
  }

  /**
   * Progress value that makes step `stepIdx` the current one
   * (everything before it allocated, nothing of it yet).
   */
  function stepStartProgress(track, stepIdx) {
    const g = groupHistory(track.history)[stepIdx];
    return g ? g.startIdx : track.currentStep;
  }

  return { buildLane, buildView, colorSlots, stepStartProgress, masteryName };
}));
