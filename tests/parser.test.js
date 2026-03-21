/**
 * tests/parser.test.js
 * ─────────────────────
 * Unit tests for parser/maxroll.js and parser/build-schema.js.
 * Uses Node.js built-in test runner (node:test) — no extra dependencies.
 *
 * Run: npm test
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { groupHistory, validateBuild, validateTrack, initializeBuild } = require('../parser/build-schema');
const { parseBuild, advanceTrack, undoTrack, getCurrentNode, resolveClassName, resolveSkillName } = require('../parser/maxroll');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_MAXROLL = {
  passives: { history: [1, 1, 1, 6, 6, 6, 6, 6, 4, 4], position: 10 },
  class: 3,
  mastery: 7,   // 7 = Void Knight in real classes.json
  skillTrees: {
    fl44: { history: [4, 4, 14, 11, 12], position: 5 },
    fi9:  { history: [3, 3, 7], position: 3 },
  },
};

// Skill DB fixture: uses "id" (not "nodeId") to match real extract.py output.
// fl44 (Flay) and fi9 (Fireball) are real treeIDs from the actual data.
const SAMPLE_SKILLS_DB = {
  fl44: { name: 'Flay', nodes: {
    4:  { id: 4,  name: 'Flay Marked For Death And Cull', maxPoints: 4 },
    14: { id: 14, name: 'Flay Crit Chance And Leech',    maxPoints: 3 },
    11: { id: 11, name: 'Flay Bleed On Hit',              maxPoints: 4 },
    12: { id: 12, name: 'Flay Bleed Damage And Armour Shred', maxPoints: 4 },
  }},
  fi9: { name: 'Fireball', nodes: {
    3: { id: 3, name: 'Fireball Chance To Ignite', maxPoints: 3 },
    7: { id: 7, name: 'Fireball Area Of Effect',   maxPoints: 4 },
  }},
};

// Classes DB fixture: includes passiveTreeByClass so lookupNode can resolve passives.
const SAMPLE_CLASSES_DB = {
  classes: { 3: 'Sentinel' },
  masteries: { 7: { name: 'Void Knight', classId: 3 } },
  passiveTreeByClass: { 3: 'kn-1' },
};

// ─── groupHistory ─────────────────────────────────────────────────────────────

describe('groupHistory', () => {
  test('single run', () => {
    const result = groupHistory([6, 6, 6]);
    assert.deepEqual(result, [{ nodeId: 6, count: 3, startIdx: 0 }]);
  });

  test('multiple runs', () => {
    const result = groupHistory([6, 6, 4, 4, 4]);
    assert.deepEqual(result, [
      { nodeId: 6, count: 2, startIdx: 0 },
      { nodeId: 4, count: 3, startIdx: 2 },
    ]);
  });

  test('alternating single IDs', () => {
    const result = groupHistory([1, 2, 3]);
    assert.equal(result.length, 3);
    assert.equal(result[0].count, 1);
    assert.equal(result[1].startIdx, 1);
  });

  test('empty history returns empty array', () => {
    assert.deepEqual(groupHistory([]), []);
  });

  test('same nodeId appearing twice non-consecutively creates two groups', () => {
    const result = groupHistory([6, 4, 6]);
    assert.equal(result.length, 3);
    assert.equal(result[0].nodeId, 6);
    assert.equal(result[1].nodeId, 4);
    assert.equal(result[2].nodeId, 6);
  });
});

// ─── validateBuild ────────────────────────────────────────────────────────────

describe('validateBuild', () => {
  test('valid build passes without throwing', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB, 'Test Build');
    assert.doesNotThrow(() => validateBuild(build));
  });

  test('throws if build is null', () => {
    assert.throws(() => validateBuild(null), /non-null object/);
  });

  test('throws if name is missing', () => {
    const bad = { classId: 1, masteryId: 1, tracks: [] };
    assert.throws(() => validateBuild(bad), /name/);
  });

  test('throws if tracks is empty array', () => {
    const bad = { name: 'Test', classId: 1, masteryId: 1, tracks: [] };
    assert.throws(() => validateBuild(bad), /tracks/);
  });

  test('throws if no passive track', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB, 'Test');
    const noPassive = { ...build, tracks: build.tracks.filter(t => t.type === 'skill') };
    assert.throws(() => validateBuild(noPassive), /passive track/);
  });
});

// ─── validateTrack ────────────────────────────────────────────────────────────

describe('validateTrack', () => {
  test('throws if history is empty', () => {
    const bad = { type: 'passive', label: 'Passives', history: [], totalSteps: 0, currentStep: 0 };
    assert.throws(() => validateTrack(bad, 0), /history/);
  });

  test('throws if skill track missing skillKey', () => {
    const bad = { type: 'skill', label: 'Test', history: [1], totalSteps: 1, currentStep: 0 };
    assert.throws(() => validateTrack(bad, 0), /skillKey/);
  });

  test('throws if history contains non-integer', () => {
    const bad = { type: 'passive', label: 'P', history: [1, 'x', 3], totalSteps: 3, currentStep: 0 };
    assert.throws(() => validateTrack(bad, 0), /non-negative integers/);
  });

  test('valid passive track passes', () => {
    const good = { type: 'passive', label: 'Passives', history: [1, 2, 3], totalSteps: 3, currentStep: 0 };
    assert.doesNotThrow(() => validateTrack(good, 0));
  });
});

// ─── parseBuild ───────────────────────────────────────────────────────────────

describe('parseBuild', () => {
  test('parses valid Maxroll object', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB, 'My Build');
    assert.equal(build.name, 'My Build');
    assert.equal(build.classId, 3);
    assert.equal(build.masteryId, 7);
    assert.equal(build.tracks.length, 3); // 1 passive + 2 skills
  });

  test('parses valid Maxroll JSON string', () => {
    const build = parseBuild(JSON.stringify(SAMPLE_MAXROLL), SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    assert.equal(build.classId, 3);
  });

  test('passive track has correct history', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const passive = build.tracks.find(t => t.type === 'passive');
    assert.deepEqual(passive.history, SAMPLE_MAXROLL.passives.history);
    assert.equal(passive.currentStep, 0);
  });

  test('skill tracks have correct skillKey and label', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const skill44 = build.tracks.find(t => t.skillKey === 'fl44');
    assert.ok(skill44);
    assert.equal(skill44.label, 'Flay');
    assert.deepEqual(skill44.history, SAMPLE_MAXROLL.skillTrees.fl44.history);
  });

  test('falls back to skillKey as label when DB empty', () => {
    const build = parseBuild(SAMPLE_MAXROLL, {}, {});
    const skill44 = build.tracks.find(t => t.skillKey === 'fl44');
    assert.equal(skill44.label, 'fl44');
  });

  test('throws on invalid JSON string', () => {
    assert.throws(() => parseBuild('not json', {}, {}), /Invalid JSON/);
  });

  test('throws if passives.history missing', () => {
    const bad = { ...SAMPLE_MAXROLL, passives: {} };
    assert.throws(() => parseBuild(bad, {}, {}), /passives.history/);
  });

  test('throws if class field missing', () => {
    const bad = { ...SAMPLE_MAXROLL, class: 'not-a-number' };
    assert.throws(() => parseBuild(bad, {}, {}), /class/);
  });

  test('uses default build name when not provided', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    assert.equal(build.name, 'Imported Build');
  });
});

// ─── advanceTrack / undoTrack ─────────────────────────────────────────────────

describe('advanceTrack', () => {
  test('increments currentStep', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const updated = advanceTrack(build, 0);
    assert.equal(updated.tracks[0].currentStep, 1);
    // original is unchanged (immutable)
    assert.equal(build.tracks[0].currentStep, 0);
  });

  test('does not exceed last group', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const groups = groupHistory(build.tracks[0].history);
    let b = build;
    for (let i = 0; i < groups.length + 5; i++) b = advanceTrack(b, 0);
    assert.equal(b.tracks[0].currentStep, groups.length - 1);
  });

  test('returns same build if trackIndex out of range', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const result = advanceTrack(build, 99);
    assert.equal(result, build);
  });
});

describe('undoTrack', () => {
  test('decrements currentStep', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const advanced = advanceTrack(build, 0);
    const undone = undoTrack(advanced, 0);
    assert.equal(undone.tracks[0].currentStep, 0);
  });

  test('does not go below 0', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const result = undoTrack(build, 0);
    assert.equal(result.tracks[0].currentStep, 0);
  });
});

// ─── getCurrentNode ───────────────────────────────────────────────────────────

describe('getCurrentNode', () => {
  // Build a db object matching the shape that lookupNode() expects
  const TEST_DB = {
    passives: { 'kn-1': { name: 'Knight', nodes: {} } }, // empty nodes — passive lookups not tested here
    skills: SAMPLE_SKILLS_DB,
    classes: SAMPLE_CLASSES_DB,
  };

  test('returns node info at step 0 for skill track', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const node = getCurrentNode(build, 1, TEST_DB); // track 1 = fl44 (Flay)
    assert.ok(node);
    assert.equal(node.name, 'Flay Marked For Death And Cull'); // fl44 node 4
  });

  test('returns null for completed track', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const groups = groupHistory(build.tracks[1].history);
    // Directly set currentStep to groups.length (past end) — simulates a completed track
    // loaded from disk. advanceTrack() stops at groups.length-1 by design.
    const completedBuild = {
      ...build,
      tracks: build.tracks.map((t, i) =>
        i === 1 ? { ...t, currentStep: groups.length } : t
      ),
    };
    const node = getCurrentNode(completedBuild, 1, TEST_DB);
    assert.equal(node, null);
  });
});

// ─── resolveClassName / resolveSkillName ──────────────────────────────────────

describe('resolveClassName', () => {
  test('resolves class and mastery names', () => {
    const result = resolveClassName(3, 7, SAMPLE_CLASSES_DB); // masteryId 7 = Void Knight
    assert.equal(result, 'Sentinel — Void Knight');
  });

  test('falls back gracefully when DB is null', () => {
    const result = resolveClassName(3, 7, null);
    assert.equal(result, 'Class 3');
  });

  test('falls back to ID when class not in DB', () => {
    const result = resolveClassName(99, 1, SAMPLE_CLASSES_DB);
    assert.ok(result.includes('99'));
  });
});

describe('resolveSkillName', () => {
  test('resolves skill name from DB', () => {
    assert.equal(resolveSkillName('fl44', SAMPLE_SKILLS_DB), 'Flay');
  });

  test('falls back to skillKey when not in DB', () => {
    assert.equal(resolveSkillName('fl99', SAMPLE_SKILLS_DB), 'fl99');
  });

  test('falls back to skillKey when DB is null', () => {
    assert.equal(resolveSkillName('fl44', null), 'fl44');
  });
});

// ─── initializeBuild ──────────────────────────────────────────────────────────

describe('initializeBuild', () => {
  test('resets all currentSteps to 0', () => {
    const build = parseBuild(SAMPLE_MAXROLL, SAMPLE_SKILLS_DB, SAMPLE_CLASSES_DB);
    const advanced = advanceTrack(advanceTrack(build, 0), 1);
    const reset = initializeBuild(advanced);
    for (const track of reset.tracks) {
      assert.equal(track.currentStep, 0);
    }
  });
});
