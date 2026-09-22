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
  normalizeBuild, stepTrack, commonPrefixLength, computeTransition, applyCarryOver,
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

const CLASSES = { classes: { 3: 'Sentinel' }, masteriesByClass: {}, passiveTreeByClass: { 3: 'kn-1' } };

const passive = (history, currentStep = 0) =>
  ({ type: 'passive', label: 'Passives', history, totalSteps: history.length, currentStep });
const skill = (skillKey, history, currentStep = 0) =>
  ({ type: 'skill', skillKey, label: skillKey, history, totalSteps: history.length, currentStep });

const loadout = (phases, currentPhase = 0) =>
  ({ name: 'L', classId: 3, masteryId: 2, currentPhase, phases });

// ─── indexNodes / makeDb ──────────────────────────────────────────────────────

describe('indexNodes', () => {
  test('groups rows by treeID and keys nodes by string nodeID', () => {
    const { trees, duplicates } = indexNodes(ROWS);
    assert.equal(duplicates, 0);
    assert.equal(trees['kn-1'].name, 'KN-1');
    assert.equal(trees['fl44'].nodes['4'].nodeName, 'Scent of Death');
    assert.deepEqual(Object.keys(trees['fl44'].nodes['4']).sort(),
      ['description', 'id', 'maxPoints', 'nodeName', 'stats']);
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
    assert.equal(lookupNode(db, 3, passive([0]), 0).nodeName, 'Juggernaut');
  });

  test('skill: skillKey is the treeID', () => {
    assert.equal(lookupNode(db, 3, skill('fl44', [4]), '14').nodeName, 'Go For The Throat');
  });

  test('returns null for unknown node, tree, class, or missing db', () => {
    assert.equal(lookupNode(db, 3, skill('fl44', [4]), 999), null);
    assert.equal(lookupNode(db, 3, skill('nope', [4]), 4), null);
    assert.equal(lookupNode(db, 99, passive([0]), 0), null);
    assert.equal(lookupNode(null, 3, passive([0]), 0), null);
  });
});

describe('isTrackUnresolved', () => {
  const db = makeDb(ROWS, CLASSES);
  test('false when the tree exists', () => {
    assert.equal(isTrackUnresolved(db, 3, passive([0])), false);
    assert.equal(isTrackUnresolved(db, 3, skill('fl44', [4])), false);
  });
  test('true when the tree is missing', () => {
    assert.equal(isTrackUnresolved(db, 3, skill('nope', [4])), true);
    assert.equal(isTrackUnresolved(db, 99, passive([0])), true);
  });
});

// ─── normalizeBuild ───────────────────────────────────────────────────────────

describe('normalizeBuild', () => {
  test('wraps legacy single-phase build', () => {
    const tracks = [passive([1])];
    const out = normalizeBuild({ name: 'B', classId: 3, masteryId: 2, tracks });
    assert.equal(out.currentPhase, 0);
    assert.equal(out.phases.length, 1);
    assert.equal(out.phases[0].tracks, tracks);
  });
  test('passes loadouts through; rejects junk', () => {
    const l = loadout([{ name: 'P', tracks: [] }]);
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

describe('computeTransition + applyCarryOver', () => {
  // Phase A: passives [1,1,2,2], skill fl44 [4,4,14], skill fi9 [3]
  // Phase B: passives [1,1,5,5], skill fl44 [4,4,14,14], skill new [7]
  const phases = [
    { name: 'A', tracks: [passive([1, 1, 2, 2], 4), skill('fl44', [4, 4, 14], 3), skill('fi9', [3], 1)] },
    { name: 'B', tracks: [passive([1, 1, 5, 5]), skill('fl44', [4, 4, 14, 14]), skill('new', [7])] },
  ];

  test('flags points beyond the shared prefix and dropped skills', () => {
    const t = computeTransition(phases, 0, 1);
    assert.equal(t.fromName, 'A');
    assert.equal(t.toName, 'B');
    assert.deepEqual(t.unspecNeeded, [
      { label: 'Passives', amount: 2, isRemove: false }, // 4 allocated, only 2 shared
      { label: 'fi9', amount: 1, isRemove: true },       // not in phase B
    ]);
  });

  test('carries progress up to the common prefix; new trees start at 0', () => {
    const out = applyCarryOver(phases, 0, 1);
    assert.equal(out[1].tracks[0].currentStep, 2); // min(4, prefix 2)
    assert.equal(out[1].tracks[1].currentStep, 3); // min(3, prefix 3)
    assert.equal(out[1].tracks[2].currentStep, 0); // not in phase A
    assert.equal(out[0], phases[0]);               // source phase untouched
  });

  test('no unspec needed when nothing allocated', () => {
    const fresh = phases.map(p => ({ ...p, tracks: p.tracks.map(t => ({ ...t, currentStep: 0 })) }));
    assert.deepEqual(computeTransition(fresh, 0, 1).unspecNeeded, []);
  });
});
