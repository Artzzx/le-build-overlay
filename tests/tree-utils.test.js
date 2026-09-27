/**
 * tests/tree-utils.test.js
 * ─────────────────────────
 * Unit tests for shared/tree-utils.js — the pure logic shared by main and the
 * overlay renderer (indexing, lookup, stepping, phase carry-over).
 *
 * Run: npm test
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  indexNodes, makeDb, groupHistory, findCurrentGroup, lookupNode, isTrackUnresolved,
  normalizeBuild, stepTrack, commonPrefixLength, passiveFit,
  diffLoadout, mergeProgress, rebaseTrack, switchPhase, applyPending, slotsAt, clearProgress, hasProgress,
} = require('../shared/tree-utils');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const row = (treeID, nodeID, nodeName, extra = {}) => ({
  treeID, treeName: treeID.toUpperCase(), nodeID, nodeName,
  description: '', maxPoints: 4, stats: [], ...extra,
});

const ROWS = [
  row('kn-1', 0, 'Juggernaut'),
  row('kn-1', 6, 'Shield Bash'),
  row('fl44', 4, 'Scent of Death'),
  row('fl44', 14, 'Go For The Throat'),
];

const CLASSES = { classes: { 2: 'Sentinel' }, masteriesByClass: {}, passiveTreeByClass: { 2: 'kn-1' } };

const passive = (history, currentStep = 0) =>
  ({ type: 'passive', label: 'Passives', history, totalSteps: history.length, currentStep });
const skill = (skillKey, history, currentStep = 0) =>
  ({ type: 'skill', skillKey, label: skillKey, history, totalSteps: history.length, currentStep });

const loadout = (phases, currentPhase = 0) =>
  ({ name: 'L', classId: 2, masteryId: 1, currentPhase, phases });

// ─── indexNodes / makeDb ──────────────────────────────────────────────────────

describe('indexNodes', () => {
  test('groups rows by treeID and keys nodes by string nodeID', () => {
    const { trees, duplicates } = indexNodes(ROWS);
    assert.equal(duplicates, 0);
    assert.equal(trees['kn-1'].name, 'KN-1');
    assert.equal(trees['fl44'].nodes['4'].nodeName, 'Scent of Death');
    assert.deepEqual(Object.keys(trees['fl44'].nodes['4']).sort(),
      ['description', 'icon', 'id', 'maxPoints', 'nodeName', 'stats']);
    assert.equal(trees['fl44'].nodes['4'].icon, null);
  });

  test('icons: node icon kept; tree icon = root node (id 0, 0 points) only', () => {
    const { trees } = indexNodes([
      row('sk1', 0, 'Skill', { maxPoints: 0, icon: 'sk1/0.png' }),
      row('sk1', 3, 'Upgrade', { icon: 'sk1/3.png' }),
      row('kn-1', 0, 'Juggernaut', { maxPoints: 8, icon: 'kn-1/0.png' }),
      row('sk2', 1, 'Blank icon', { icon: '' }),
    ]);
    assert.equal(trees.sk1.icon, 'sk1/0.png');
    assert.equal(trees.sk1.nodes['3'].icon, 'sk1/3.png');
    assert.equal(trees['kn-1'].icon, null, 'a real passive node 0 is not a tree emblem');
    assert.equal(trees['kn-1'].nodes['0'].icon, 'kn-1/0.png');
    assert.equal(trees.sk2.nodes['1'].icon, null, 'empty string normalised to null');
  });

  test('duplicate (treeID, nodeID): named row beats blank placeholder', () => {
    const { trees, duplicates } = indexNodes([row('t', 1, ''), row('t', 1, 'Real')]);
    assert.equal(duplicates, 1);
    assert.equal(trees.t.nodes['1'].nodeName, 'Real');
  });

  test('duplicate (treeID, nodeID): "Name" placeholder loses too', () => {
    const { trees } = indexNodes([row('t', 1, 'Name'), row('t', 1, 'Real')]);
    assert.equal(trees.t.nodes['1'].nodeName, 'Real');
  });

  test('duplicate (treeID, nodeID): first named row wins', () => {
    const { trees } = indexNodes([row('t', 1, 'First'), row('t', 1, 'Second')]);
    assert.equal(trees.t.nodes['1'].nodeName, 'First');
  });

  test('handles empty / missing input', () => {
    assert.deepEqual(indexNodes([]).trees, {});
    assert.deepEqual(indexNodes(undefined).trees, {});
  });
});

describe('makeDb', () => {
  test('passives and skills are the same tree map; classes defaulted', () => {
    const db = makeDb(ROWS);
    assert.equal(db.passives, db.skills);
    assert.deepEqual(db.classes.passiveTreeByClass, {});
  });
});

// ─── groupHistory / findCurrentGroup ──────────────────────────────────────────

describe('groupHistory + findCurrentGroup', () => {
  const groups = groupHistory([6, 6, 6, 4, 4]);

  test('groups consecutive ids', () => {
    assert.deepEqual(groups, [
      { nodeId: 6, count: 3, startIdx: 0 },
      { nodeId: 4, count: 2, startIdx: 3 },
    ]);
  });

  test('currentStep is a flat point count', () => {
    assert.equal(findCurrentGroup(groups, 0).nodeId, 6);
    assert.equal(findCurrentGroup(groups, 2).nodeId, 6);
    assert.equal(findCurrentGroup(groups, 3).nodeId, 4);
    assert.equal(findCurrentGroup(groups, 5), null); // complete
  });
});

// ─── lookupNode / isTrackUnresolved ───────────────────────────────────────────

describe('lookupNode', () => {
  const db = makeDb(ROWS, CLASSES);

  test('passive: classId → passiveTreeByClass → node', () => {
    assert.equal(lookupNode(db, 2, passive([0]), 0).nodeName, 'Juggernaut');
  });

  test('skill: skillKey is the treeID', () => {
    assert.equal(lookupNode(db, 2, skill('fl44', [4]), '14').nodeName, 'Go For The Throat');
  });

  test('returns null for unknown node, tree, class, or missing db', () => {
    assert.equal(lookupNode(db, 2, skill('fl44', [4]), 999), null);
    assert.equal(lookupNode(db, 2, skill('nope', [4]), 4), null);
    assert.equal(lookupNode(db, 99, passive([0]), 0), null);
    assert.equal(lookupNode(null, 3, passive([0]), 0), null);
  });
});

describe('isTrackUnresolved', () => {
  const db = makeDb(ROWS, CLASSES);
  test('false when the tree exists', () => {
    assert.equal(isTrackUnresolved(db, 2, passive([0])), false);
    assert.equal(isTrackUnresolved(db, 2, skill('fl44', [4])), false);
  });
  test('true when the tree is missing', () => {
    assert.equal(isTrackUnresolved(db, 2, skill('nope', [4])), true);
    assert.equal(isTrackUnresolved(db, 99, passive([0])), true);
  });
});

// ─── normalizeBuild ───────────────────────────────────────────────────────────

describe('normalizeBuild', () => {
  test('wraps legacy single-phase build', () => {
    const tracks = [passive([1])];
    const out = normalizeBuild({ name: 'B', classId: 2, masteryId: 1, tracks });
    assert.equal(out.currentPhase, 0);
    assert.equal(out.phases.length, 1);
    assert.equal(out.phases[0].tracks, tracks);
  });
  test('passes loadouts through (with a character state); rejects junk', () => {
    const l = { ...loadout([{ name: 'P', masteryId: 2, tracks: [] }]), held: {}, mastery: 0 };
    assert.equal(normalizeBuild(l), l);
    assert.equal(normalizeBuild(null), null);
    assert.equal(normalizeBuild({}), null);
  });
});

// ─── stepTrack ────────────────────────────────────────────────────────────────

describe('stepTrack', () => {
  const base = loadout([
    { name: 'A', tracks: [passive([1, 1, 2]), skill('fl44', [4, 4])] },
    { name: 'B', tracks: [passive([1, 1, 2])] },
  ]);

  test('advances one point on the active phase only, immutably', () => {
    const out = stepTrack(base, 1, +1);
    assert.equal(out.phases[0].tracks[1].currentStep, 1);
    assert.equal(base.phases[0].tracks[1].currentStep, 0);
    assert.equal(out.phases[1], base.phases[1]);
  });

  test('targets currentPhase', () => {
    const out = stepTrack({ ...base, currentPhase: 1 }, 0, +1);
    assert.equal(out.phases[1].tracks[0].currentStep, 1);
    assert.equal(out.phases[0].tracks[0].currentStep, 0);
  });

  test('clamps at history.length and at 0, returning the same reference', () => {
    let l = base;
    for (let i = 0; i < 10; i++) l = stepTrack(l, 1, +1);
    assert.equal(l.phases[0].tracks[1].currentStep, 2);
    assert.equal(stepTrack(l, 1, +1), l);
    assert.equal(stepTrack(base, 0, -1), base);
  });

  test('undo decrements', () => {
    const out = stepTrack(stepTrack(base, 0, +1), 0, -1);
    assert.equal(out.phases[0].tracks[0].currentStep, 0);
  });

  test('unknown track index is a no-op', () => {
    assert.equal(stepTrack(base, 9, +1), base);
  });
});

// ─── Phase transitions ────────────────────────────────────────────────────────

describe('commonPrefixLength', () => {
  test('counts identical leading entries', () => {
    assert.equal(commonPrefixLength([1, 1, 2, 3], [1, 1, 5]), 2);
    assert.equal(commonPrefixLength([], [1]), 0);
    assert.equal(commonPrefixLength([1, 2], [1, 2]), 2);
  });
});

describe('passiveFit', () => {
  const tree = { nodes: { 1: { maxPoints: 2 }, 2: { maxPoints: 5 }, 3: { maxPoints: 0 } } };
  test('a real build fits its tree exactly', () => {
    assert.deepEqual(passiveFit([1, 1, 2, 2, 2], tree), { missing: 0, over: 0, fits: true });
  });
  test('counts points on unknown nodes and over a node\'s max', () => {
    assert.deepEqual(passiveFit([1, 1, 1, 9, 9], tree), { missing: 2, over: 1, fits: false });
    assert.equal(passiveFit([1], null).fits, false);
  });
});

describe('per-phase mastery', () => {
  test('normalizeBuild backfills phase.masteryId from the loadout', () => {
    const n = normalizeBuild({ ...loadout([{ name: 'A', tracks: [] }, { name: 'B', masteryId: 0, tracks: [] }]), masteryId: 2 });
    assert.deepEqual(n.phases.map(p => p.masteryId), [2, 0]);
    assert.equal(normalizeBuild({ name: 'x', classId: 2, masteryId: 1, tracks: [] }).phases[0].masteryId, 1);
  });
});

// ─── Character state + entering a phase ─────────────────────────────────────

describe('character state', () => {
  test('derived once from the current phase; a fresh build has no mastery yet', () => {
    const l = normalizeBuild(loadout([{ name: 'A', masteryId: 2, tracks: [passive([1, 1, 2], 2), skill('fl44', [4, 4], 1)] }]));
    assert.deepEqual(l.held, { passive: { 1: 2 }, fl44: { 4: 1 } });
    assert.equal(l.mastery, 2, 'already playing the phase = its mastery is chosen');
    const fresh = normalizeBuild(loadout([{ name: 'A', masteryId: 2, tracks: [passive([1, 1, 2])] }]));
    assert.equal(fresh.mastery, 0);
  });

  test('allocate / undo / Start from here keep it in step', () => {
    let l = normalizeBuild(loadout([{ name: 'A', tracks: [passive([1, 1, 2, 3])] }]));
    l = stepTrack(l, 0, +1); l = stepTrack(l, 0, +1); l = stepTrack(l, 0, +1);
    assert.deepEqual(l.held.passive, { 1: 2, 2: 1 });
    l = stepTrack(l, 0, -1);
    assert.deepEqual(l.held.passive, { 1: 2 });
    const { setTrackProgress } = require('../shared/tree-utils');
    assert.deepEqual(setTrackProgress(l, 0, 4).held.passive, { 1: 2, 2: 1, 3: 1 });
    assert.deepEqual(setTrackProgress(l, 0, 0).held.passive, {});
  });
});

describe('rebaseTrack', () => {
  test('held points move to the front, in route order; the rest keeps the guide order', () => {
    const r = rebaseTrack(passive([5, 1, 1, 2, 5]), { 1: 2, 5: 1 });
    assert.deepEqual(r.track.history, [5, 1, 1, 2, 5]);
    assert.equal(r.track.currentStep, 3);
    const r2 = rebaseTrack(passive([2, 1, 1, 3]), { 1: 2 });
    assert.deepEqual(r2.track.history, [1, 1, 2, 3]);
    assert.deepEqual(r2.track.guide, [2, 1, 1, 3], 'the guide order is kept for later');
    assert.equal(r2.track.currentStep, 2);
    assert.deepEqual(r2.surplus, {});
  });
  test('points the route never wants are surplus; rebasing again starts from the guide', () => {
    const r = rebaseTrack(passive([1, 2]), { 1: 3, 9: 1 });
    assert.deepEqual(r.kept, { 1: 1 });
    assert.deepEqual(r.surplus, { 1: 2, 9: 1 });
    const again = rebaseTrack(rebaseTrack(passive([2, 1]), { 1: 1 }).track, {});
    assert.deepEqual(again.track.history, [2, 1]);
    assert.equal('guide' in again.track, false);
  });
});

describe('slotsAt', () => {
  test('skill slots unlock at levels 4, 8, 20, 35, 50', () => {
    assert.deepEqual([1, 4, 7, 8, 20, 34, 35, 50, 70].map(slotsAt), [0, 1, 1, 2, 3, 3, 4, 5, 5]);
    assert.equal(slotsAt(undefined), 5);
  });
});

describe('switchPhase', () => {
  // Allocate every point of the current phase (through setTrackProgress, so the character state follows).
  const { setTrackProgress } = require('../shared/tree-utils');
  const done = (l) => l.phases[l.currentPhase].tracks.reduce((b, t, i) => setTrackProgress(b, i, t.history.length), normalizeBuild(l));

  test('same nodes in another order: nothing to unspec, all progress kept', () => {
    const l = done(loadout([
      { name: 'A', masteryId: 0, tracks: [passive([1, 1, 2, 2])] },
      { name: 'B', masteryId: 0, tracks: [passive([2, 1, 2, 1, 3])] },
    ]));
    const { build, transition } = switchPhase(l, 1);
    assert.equal(transition, null);
    assert.equal(build.phases[1].tracks[0].currentStep, 4);
    assert.deepEqual(build.phases[1].tracks[0].history, [2, 1, 2, 1, 3]);
  });

  test('only points the new route does not want are unspecced', () => {
    const l = done(loadout([
      { name: 'A', masteryId: 1, tracks: [passive([1, 1, 2, 2])] },
      { name: 'B', masteryId: 1, tracks: [passive([1, 2, 5])] },
    ]));
    const { build, transition } = switchPhase(l, 1);
    assert.deepEqual(transition.unspecNeeded, [{
      type: 'passive', skillKey: undefined, label: 'Passives', amount: 2, isRemove: false,
      // Node by node, last taken first: 2 was taken after 1.
      nodes: [{ nodeId: 2, remove: 1, from: 2, to: 1 }, { nodeId: 1, remove: 1, from: 2, to: 1 }],
    }]);
    assert.equal(build.phases[1].tracks[0].currentStep, 2);
    assert.deepEqual(build.held.passive, { 1: 2, 2: 2 }, 'nothing changes until the player confirms');
    assert.deepEqual(build.pending, transition);
    const confirmed = applyPending(build);
    assert.deepEqual(confirmed.held.passive, { 1: 1, 2: 1 });
    assert.equal(confirmed.pending, null);
  });

  test('a skill that skips a phase stays specialized and comes back with its points', () => {
    const l = done(loadout([
      { name: 'A', masteryId: 0, level: 9, tracks: [passive([1]), skill('sh', [3, 3, 4])] },
      { name: 'B', masteryId: 0, level: 15, tracks: [passive([1, 2]), skill('bl', [7])] },
      { name: 'C', masteryId: 0, level: 49, tracks: [passive([1, 2, 6]), skill('bl', [7, 8]), skill('sh', [3, 3, 4, 5])] },
    ]));
    const toB = switchPhase(l, 1);
    assert.deepEqual(toB.transition.keptSkills, [{ skillKey: 'sh', label: 'sh', points: 3, backIn: 'C' }]);
    assert.deepEqual(toB.transition.unspecNeeded, []);
    const toC = switchPhase(done(toB.build), 2);
    assert.equal(toC.build.phases[2].tracks[2].currentStep, 3, 'Shadow Rend resumes at 3/4');
    assert.equal(toC.transition, null);
  });

  test('no free slot (level) or never used again: despecialize, points lost', () => {
    const l = done(loadout([
      { name: 'A', masteryId: 0, level: 9, tracks: [passive([1]), skill('x', [3]), skill('y', [4])] },
      { name: 'B', masteryId: 0, level: 9, tracks: [passive([1]), skill('z', [7])] },
      { name: 'C', masteryId: 0, level: 20, tracks: [passive([1]), skill('x', [3, 5])] },
    ]));
    const { build, transition } = switchPhase(l, 1);
    // level 9 = 2 slots, z takes one: x (back in C) keeps the other, y is never used again.
    assert.deepEqual(transition.keptSkills.map(k => k.skillKey), ['x']);
    assert.deepEqual(transition.unspecNeeded.map(u => [u.skillKey, u.isRemove, u.backIn]), [['y', true, null]]);
    assert.equal('y' in build.held, true);
    assert.equal('y' in applyPending(build).held, false);
    const tight = { ...l, phases: l.phases.map((p, i) => (i === 1 ? { ...p, level: 5 } : p)) }; // 1 slot, z takes it
    const t2 = switchPhase(tight, 1).transition;
    assert.deepEqual(t2.unspecNeeded.map(u => [u.skillKey, u.backIn]), [['x', 'C'], ['y', null]]);
  });

  test('mastery: choose once, change when it differs, never going back', () => {
    const l = normalizeBuild(loadout([
      { name: 'A', masteryId: 0, tracks: [passive([1])] },
      { name: 'B', masteryId: 1, tracks: [passive([1])] },
      { name: 'C', masteryId: 2, tracks: [passive([1])] },
    ]));
    const b = switchPhase(l, 1);
    assert.deepEqual(b.transition.masteryChange, { from: 0, to: 1 });
    assert.equal(b.build.mastery, 0, 'chosen only once the player confirms');
    const c = switchPhase(applyPending(b.build), 2);
    assert.deepEqual(c.transition.masteryChange, { from: 1, to: 2 });
    const back = switchPhase(applyPending(c.build), 0);
    assert.equal(back.transition, null);
    assert.equal(back.build.mastery, 2);
  });

  test('going back asks for nothing and forgets nothing', () => {
    const l = done(loadout([
      { name: 'A', masteryId: 1, tracks: [passive([1, 2])] },
      { name: 'B', masteryId: 1, tracks: [passive([1, 2, 3, 3])] },
    ]));
    const fwd = applyPending(switchPhase(l, 1).build);
    const full = done(fwd);
    const back = switchPhase(full, 0);
    assert.equal(back.transition, null);
    assert.equal(back.build.phases[0].tracks[0].currentStep, 2);
    assert.deepEqual(back.build.held.passive, { 1: 1, 2: 1, 3: 2 });
    assert.equal(switchPhase(back.build, 1).build.phases[1].tracks[0].currentStep, 4);
  });

  test('misclick forward then back: the instructions stay, and nothing is lost', () => {
    const l = done(loadout([
      { name: 'A', masteryId: 0, tracks: [passive([1, 1, 2])] },
      { name: 'B', masteryId: 0, tracks: [passive([1, 3])] },
    ]));
    const fwd = switchPhase(l, 1);
    assert.equal(fwd.transition.unspecNeeded[0].amount, 2);
    const back = switchPhase(fwd.build, 0);
    assert.deepEqual(back.build.pending, fwd.transition, 'still shown after going back');
    assert.equal(back.build.phases[0].tracks[0].currentStep, 3, 'all 3 points still there');
    // Confirming while back in A never takes off points A counts as allocated.
    assert.deepEqual(applyPending(back.build).held.passive, { 1: 2, 2: 1 });
  });
});

describe('clearProgress', () => {
  test('every phase back to 0, first phase, empty character, guide order restored', () => {
    const { setTrackProgress } = require('../shared/tree-utils');
    let l = normalizeBuild(loadout([
      { name: 'A', masteryId: 0, tracks: [passive([1, 1, 2])] },
      { name: 'B', masteryId: 1, tracks: [passive([2, 1, 1, 3])] },
    ]));
    l = setTrackProgress(l, 0, 3);
    l = switchPhase(l, 1).build; // B's route gets reordered ([1,1,2,3]) and a pending mastery choice
    assert.equal(hasProgress(l), true);
    const c = clearProgress(l);
    assert.equal(hasProgress(c), false);
    assert.equal(c.currentPhase, 0);
    assert.deepEqual(c.held, {});
    assert.equal(c.mastery, 0);
    assert.equal(c.pending, null);
    assert.deepEqual(c.phases[1].tracks[0].history, [2, 1, 1, 3]);
    assert.equal('guide' in c.phases[1].tracks[0], false);
    assert.equal(c.name, l.name, 'the build itself is kept');
  });
});

// ─── Guide updates: diffLoadout + mergeProgress ──────────────────────────────

describe('diffLoadout + mergeProgress', () => {
  const played = loadout([
    { name: 'Leveling', masteryId: 0, tracks: [passive([1, 1, 2, 2], 4), skill('fl44', [4, 4, 14], 3), skill('fi9', [3, 3], 2)] },
    { name: 'Endgame', masteryId: 1, tracks: [passive([1, 1, 2, 2, 6], 0), skill('fl44', [4, 4, 14, 14], 0)] },
  ], 0);

  test('identical build: nothing changed, progress kept, no respec', () => {
    const fresh = loadout(played.phases.map(p => ({ ...p, tracks: p.tracks.map(t => ({ ...t, currentStep: 0 })) })));
    assert.equal(diffLoadout(played, fresh).changed, false);
    const { build, transition } = mergeProgress(played, fresh);
    assert.deepEqual(build.phases[0].tracks.map(t => t.currentStep), [4, 3, 2]);
    assert.equal(transition, null);
  });

  test('points appended at the end keep all progress', () => {
    const next = loadout([
      { name: 'Leveling', masteryId: 0, tracks: [passive([1, 1, 2, 2, 8, 8]), skill('fl44', [4, 4, 14]), skill('fi9', [3, 3])] },
      played.phases[1],
    ]);
    const d = diffLoadout(played, next);
    assert.equal(d.changed, true);
    assert.deepEqual(d.phases[0].changed, [{ type: 'passive', skillKey: undefined, label: 'Passives', before: 4, after: 6, common: 4 }]);
    const { build, transition } = mergeProgress(played, next);
    assert.deepEqual(build.phases[0].tracks.map(t => t.currentStep), [4, 3, 2]);
    assert.equal(transition, null);
  });

  test('an early node changed: progress capped at the common prefix, respec listed', () => {
    const next = loadout([
      { name: 'Leveling', masteryId: 0, tracks: [passive([1, 5, 5, 5]), skill('fl44', [4, 4, 14]), skill('fi9', [3, 3])] },
      played.phases[1],
    ]);
    const { build, transition } = mergeProgress(played, next);
    assert.equal(build.phases[0].tracks[0].currentStep, 1);
    assert.deepEqual(transition.unspecNeeded.map(u => [u.label, u.amount, u.isRemove]), [['Passives', 3, false]]);
    assert.deepEqual(transition.unspecNeeded[0].nodes.map(n => [n.nodeId, n.remove]), [[2, 2], [1, 1]]);
    assert.equal(transition.reason, 'update');
    assert.deepEqual(build.pending, transition);
    assert.equal(transition.toName, 'Leveling');
  });

  test('a skill swapped out: listed as removed and as a skill to take off the bar', () => {
    const next = loadout([
      { name: 'Leveling', masteryId: 0, tracks: [passive([1, 1, 2, 2]), skill('fl44', [4, 4, 14]), skill('sm9', [7])] },
      played.phases[1],
    ]);
    const d = diffLoadout(played, next).phases[0];
    assert.deepEqual(d.added.map(t => t.skillKey), ['sm9']);
    assert.deepEqual(d.removed.map(t => t.skillKey), ['fi9']);
    const { build, transition } = mergeProgress(played, next);
    assert.deepEqual(build.phases[0].tracks.map(t => t.currentStep), [4, 3, 0]);
    assert.deepEqual(transition.unspecNeeded.map(u => [u.skillKey, u.amount, u.isRemove]), [['fi9', 2, true]]);
  });

  test('a phase dropped or added counts as a change; the current phase is clamped', () => {
    const onePhase = loadout([played.phases[0]]);
    assert.equal(diffLoadout(played, onePhase).changed, true);
    const later = { ...played, currentPhase: 1 };
    assert.equal(mergeProgress(later, onePhase).build.currentPhase, 0);
    const three = loadout([...played.phases, { name: 'Late', masteryId: 1, tracks: [passive([1])] }]);
    const d = diffLoadout(played, three);
    assert.equal(d.changed, true);
    assert.deepEqual(d.phases[2].added.map(t => t.type), ['passive']);
    assert.equal(mergeProgress(played, three).build.phases[2].tracks[0].currentStep, 0);
  });

  test('a mastery change in the played phase shows in the transition', () => {
    const next = loadout([{ ...played.phases[0], masteryId: 1 }, played.phases[1]]);
    assert.deepEqual(diffLoadout(played, next).phases[0].masteryChange, { from: 0, to: 1 });
    assert.deepEqual(mergeProgress(played, next).transition.masteryChange, { from: 0, to: 1 });
  });
});

// ─── setTrackProgress ─────────────────────────────────────────────────────────

describe('setTrackProgress', () => {
  const { setTrackProgress } = require('../shared/tree-utils');
  const base = loadout([{ name: 'A', tracks: [passive([1, 1, 2]), skill('fl44', [4, 4])] }]);

  test('sets an absolute value, clamped', () => {
    assert.equal(setTrackProgress(base, 0, 2).phases[0].tracks[0].currentStep, 2);
    assert.equal(setTrackProgress(base, 0, 99).phases[0].tracks[0].currentStep, 3);
    assert.equal(setTrackProgress(base, 0, -4), base); // clamps to 0 = unchanged
  });

  test('same value or bad input returns the same reference', () => {
    assert.equal(setTrackProgress(base, 0, 0), base);
    assert.equal(setTrackProgress(base, 0, NaN), base);
    assert.equal(setTrackProgress(base, 7, 1), base);
  });
});
