/**
 * tests/view-model.test.js
 * ─────────────────────────
 * Unit tests for shared/view-model.js — what the UI renders per lane.
 * Runs against the committed game data (which contains the
 * trees used here).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const buildDb = require('../db/build-db');
const { buildLane, buildView, colorSlots, stepStartProgress } = require('../shared/view-model');
const { makeDb } = require('../shared/tree-utils');

buildDb.load();
const DB = buildDb.all();

const passive = (history, currentStep = 0) =>
  ({ type: 'passive', label: 'Old label', history, totalSteps: history.length, currentStep });
const skill = (skillKey, history, currentStep = 0) =>
  ({ type: 'skill', skillKey, label: skillKey, history, totalSteps: history.length, currentStep });

const CTX = { db: DB, classId: 3, masteryId: 2 };

describe('buildLane — step states', () => {
  // fl44 (Flay): node 14 x2, node 4 x1, node 14 x1
  const track = skill('fl44', [14, 14, 4, 14]);

  test('fresh track: first step is current, rest upcoming', () => {
    const lane = buildLane(track, 1, CTX);
    assert.equal(lane.hotkey, 2);
    assert.equal(lane.title, 'Flay');
    assert.deepEqual(lane.steps.map(s => s.state), ['current', 'upcoming', 'upcoming']);
    assert.equal(lane.nowIdx, 0);
    assert.equal(lane.now.name, 'Go For The Throat');
    assert.equal(lane.next.nodeId, 4);
    assert.equal(lane.upcoming.length, 1);
  });

  test('mid-step progress counts points inside the current step', () => {
    const lane = buildLane({ ...track, currentStep: 1 }, 1, CTX);
    assert.equal(lane.now.idx, 0);
    assert.equal(lane.now.pointsDone, 1);
    assert.equal(lane.done, 1);
    assert.equal(lane.pct, 0.25);
  });

  test('step boundary moves NOW to the next step', () => {
    const lane = buildLane({ ...track, currentStep: 2 }, 1, CTX);
    assert.deepEqual(lane.steps.map(s => s.state), ['done', 'current', 'upcoming']);
    assert.equal(lane.steps[0].pointsDone, 2);
    assert.equal(lane.now.nodeId, 4);
  });

  test('complete track has no now/next', () => {
    const lane = buildLane({ ...track, currentStep: 4 }, 1, CTX);
    assert.equal(lane.complete, true);
    assert.equal(lane.nowIdx, -1);
    assert.equal(lane.now, null);
    assert.equal(lane.next, null);
    assert.ok(lane.steps.every(s => s.state === 'done'));
  });

  test('nodeTotalAfter accumulates repeat visits to the same node', () => {
    const lane = buildLane(track, 1, CTX);
    assert.deepEqual(lane.steps.map(s => s.nodeTotalAfter), [2, 1, 3]);
  });

  test('iconKey is "<treeId>/<nodeId>" (placeholder seed)', () => {
    assert.equal(buildLane(track, 1, CTX).steps[1].iconKey, 'fl44/4');
  });
});

describe('buildLane — titles and resolution', () => {
  test('passive lane uses mastery + class from classes.json, not the baked label', () => {
    const lane = buildLane(passive([0, 0, 1]), 0, CTX);
    assert.equal(lane.title, 'Void Knight');
    assert.equal(lane.subtitle, 'Sentinel passives');
    assert.equal(lane.treeId, 'kn-1');
    assert.equal(lane.unresolved, false);
    assert.equal(lane.now.name, 'Juggernaut');
  });

  test('unknown skill tree is unresolved and falls back to label + "Node N"', () => {
    const lane = buildLane({ ...skill('zz99', [3, 3]), label: 'Mystery' }, 2, CTX);
    assert.equal(lane.unresolved, true);
    assert.equal(lane.title, 'Mystery');
    assert.equal(lane.now.name, 'Node 3');
    assert.equal(lane.now.known, false);
  });

  test('works with an empty DB', () => {
    const lane = buildLane(passive([1]), 0, { db: makeDb([]), classId: 3, masteryId: 2 });
    assert.equal(lane.unresolved, true);
    assert.equal(lane.title, 'Old label');
  });
});

describe('buildView', () => {
  const loadout = {
    name: 'VK', classId: 3, masteryId: 2, currentPhase: 1,
    phases: [
      { name: 'Leveling', tracks: [passive([0, 0])] },
      { name: 'Endgame', tracks: [passive([0, 0, 1], 3), skill('fl44', [14, 14, 4], 1)] },
    ],
  };

  test('summarises the active phase', () => {
    const v = buildView(loadout, DB);
    assert.equal(v.classLabel, 'Sentinel · Void Knight');
    assert.equal(v.currentPhase, 1);
    assert.deepEqual(v.phases.map(p => p.name), ['Leveling', 'Endgame']);
    assert.equal(v.lanes.length, 2);
    assert.equal(v.done, 4);
    assert.equal(v.total, 6);
  });

  test('clamps an out-of-range currentPhase and rejects empty loadouts', () => {
    assert.equal(buildView({ ...loadout, currentPhase: 9 }, DB).currentPhase, 1);
    assert.equal(buildView(null, DB), null);
    assert.equal(buildView({ phases: [] }, DB), null);
  });
});

describe('stepStartProgress', () => {
  test('returns the flat index where a step starts', () => {
    const t = skill('fl44', [14, 14, 4, 14]);
    assert.equal(stepStartProgress(t, 0), 0);
    assert.equal(stepStartProgress(t, 1), 2);
    assert.equal(stepStartProgress(t, 2), 3);
    assert.equal(stepStartProgress({ ...t, currentStep: 1 }, 9), 1);
  });
});

describe('colorSlots', () => {
  test('passive is 0; skills keep their slot across phases even when order changes', () => {
    const loadout = {
      name: 'L', classId: 3, masteryId: 2, currentPhase: 1,
      phases: [
        { name: 'A', tracks: [passive([0]), skill('fl44', [14]), skill('fi9', [3]), skill('es6ai', [1])] },
        { name: 'B', tracks: [passive([0]), skill('es6ai', [1]), skill('v01cv', [2])] },
      ],
    };
    const slots = colorSlots(loadout);
    assert.deepEqual([...slots], [['fl44', 1], ['fi9', 2], ['es6ai', 3], ['v01cv', 4]]);
    const v = buildView(loadout, DB);
    assert.deepEqual(v.lanes.map(l => l.colorSlot), [0, 3, 4]);
  });
});

describe('icons', () => {
  const rows = [
    { treeID: 'es6ai', treeName: 'Erasing Strike', nodeID: 0, nodeName: 'Erasing Strike', description: '', maxPoints: 0, stats: [], icon: 'es6ai/0.png' },
    { treeID: 'es6ai', treeName: 'Erasing Strike', nodeID: 12, nodeName: 'Void Lens', description: '', maxPoints: 2, stats: [], icon: 'es6ai/12.png' },
    { treeID: 'es6ai', treeName: 'Erasing Strike', nodeID: 13, nodeName: 'Time Loop', description: '', maxPoints: 3, stats: [], icon: null },
    { treeID: 'kn-1', treeName: 'Sentinel', nodeID: 0, nodeName: 'Juggernaut', description: '', maxPoints: 8, stats: [], icon: 'kn-1/0.png' },
  ];
  const db = makeDb(rows, DB.classes);
  const ctx = { db, classId: 3, masteryId: 2 };

  test('steps carry the node icon path; missing icon is null', () => {
    const lane = buildLane(skill('es6ai', [12, 13]), 1, ctx);
    assert.deepEqual(lane.steps.map(s => s.icon), ['es6ai/12.png', null]);
  });

  test('skill lanes use the root node icon as tree icon; passive lanes have none', () => {
    assert.equal(buildLane(skill('es6ai', [12]), 1, ctx).treeIcon, 'es6ai/0.png');
    // kn-1 node 0 is a real passive node (8 pts), not a tree root → no emblem.
    assert.equal(buildLane(passive([0]), 0, ctx).treeIcon, null);
    assert.equal(buildLane(passive([0]), 0, ctx).steps[0].icon, 'kn-1/0.png');
  });

  test('unknown nodes and legacy rows without an icon field give null', () => {
    const legacy = makeDb([{ ...rows[1], icon: undefined }], DB.classes);
    assert.equal(buildLane(skill('es6ai', [12, 99]), 1, { ...ctx, db: legacy }).steps[0].icon, null);
    assert.equal(buildLane(skill('es6ai', [12, 99]), 1, ctx).steps[1].icon, null);
  });
});
