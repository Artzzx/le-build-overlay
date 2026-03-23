/**
 * tests/db.test.js
 * ─────────────────
 * Unit tests for db/build-db.js.
 * Uses Node.js built-in test runner (node:test) — no extra dependencies.
 *
 * Run: npm test
 *
 * NOTE: Tests use real db/data/*.json values from extract.py output.
 * Key facts about the real data schema:
 *  - Passive nodes use field "id" (not "nodeId") and have NO description field
 *  - Skill nodes use field "id" (not "nodeId") and have NO description field
 *  - passives.json is keyed by treeID (e.g. "kn-1"), not flat nodeId
 *  - "fl44" = Flay, "fi9" = Fireball in real data (fl22 does not exist)
 *  - getPassive() now requires (classId, nodeId) — classId 3 = Sentinel (kn-1)
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Force reload of the module between tests to reset internal singleton state
function freshDb() {
  const dbPath = require.resolve('../db/build-db');
  delete require.cache[dbPath];
  return require('../db/build-db');
}

// ─── load + isPopulated ───────────────────────────────────────────────────────

describe('db.load + db.isPopulated', () => {
  test('loads data files without crashing', () => {
    const db = freshDb();
    assert.doesNotThrow(() => db.load());
  });

  test('isPopulated returns true after loading real data', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.isPopulated(), true);
  });

  test('calling load() twice is safe (idempotent)', () => {
    const db = freshDb();
    assert.doesNotThrow(() => {
      db.load();
      db.load();
    });
  });

  test('force reload works', () => {
    const db = freshDb();
    db.load();
    assert.doesNotThrow(() => db.load(true));
    assert.equal(db.isPopulated(), true);
  });
});

// ─── getPassive ───────────────────────────────────────────────────────────────

describe('db.getPassive', () => {
  // classId 3 = Sentinel → tree "kn-1"; nodeId 0 = "Knight Strength And Protections"
  test('returns passive node for known classId + nodeId (numbers)', () => {
    const db = freshDb();
    db.load();
    const node = db.getPassive(3, 0);
    assert.ok(node, 'expected Sentinel nodeId 0 to exist');
    assert.equal(node.id, 0);
    assert.equal(node.name, 'Knight Strength And Protections');
  });

  test('returns passive node with string arguments', () => {
    const db = freshDb();
    db.load();
    const node = db.getPassive('3', '0');
    assert.ok(node);
    assert.equal(node.id, 0);
  });

  test('returns null for unknown nodeId', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getPassive(3, 999999), null);
  });

  test('returns null for unknown classId', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getPassive(99, 0), null);
  });

  test('passive node has expected shape', () => {
    const db = freshDb();
    db.load();
    const node = db.getPassive(3, 0);
    assert.ok(node);
    assert.ok(typeof node.id === 'number');
    assert.ok(typeof node.name === 'string');
    assert.ok(typeof node.maxPoints === 'number');
  });
});

// ─── getPassiveTreeId ─────────────────────────────────────────────────────────

describe('db.getPassiveTreeId', () => {
  test('maps classId 3 (Sentinel) to kn-1', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getPassiveTreeId(3), 'kn-1');
  });

  test('maps all 5 base classes', () => {
    const db = freshDb();
    db.load();
    const expected = { 1: 'ac-1', 2: 'mg-1', 3: 'kn-1', 4: 'rg-1', 5: 'pr-1' };
    for (const [classId, treeId] of Object.entries(expected)) {
      assert.equal(db.getPassiveTreeId(classId), treeId,
        `classId ${classId} should map to ${treeId}`);
    }
  });

  test('returns null for unknown classId', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getPassiveTreeId(99), null);
  });
});

// ─── getSkillNode ─────────────────────────────────────────────────────────────

describe('db.getSkillNode', () => {
  // fl44 = "Flay" in real data; node 4 = "Flay Marked For Death And Cull"
  test('returns skill node for known skillKey + nodeId (numbers)', () => {
    const db = freshDb();
    db.load();
    const node = db.getSkillNode('fl44', 4);
    assert.ok(node, 'expected fl44 node 4 to exist');
    assert.equal(node.id, 4);
    assert.equal(node.name, 'Flay Marked For Death And Cull');
  });

  test('returns skill node with string arguments', () => {
    const db = freshDb();
    db.load();
    const node = db.getSkillNode('fl44', '4');
    assert.ok(node);
    assert.equal(node.name, 'Flay Marked For Death And Cull');
  });

  test('returns null for unknown skillKey', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getSkillNode('flXXX', 4), null);
  });

  test('returns null for unknown nodeId in a known skill', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getSkillNode('fl44', 999999), null);
  });

  test('skill node has expected shape', () => {
    const db = freshDb();
    db.load();
    // fl44 node 14 = "Flay Crit Chance And Leech"
    const node = db.getSkillNode('fl44', 14);
    assert.ok(node);
    assert.ok(typeof node.id === 'number');
    assert.ok(typeof node.name === 'string');
    assert.ok(typeof node.maxPoints === 'number');
  });
});

// ─── getSkillName ─────────────────────────────────────────────────────────────

describe('db.getSkillName', () => {
  test('returns skill name for known treeID keys', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getSkillName('fl44'), 'Flay');
    assert.equal(db.getSkillName('fi9'), 'Fireball');
  });

  test('returns null for unknown key', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getSkillName('flXXX'), null);
  });
});

// ─── getClassName / getMasteryName ────────────────────────────────────────────

describe('db.getClassName', () => {
  test('returns class name for known ID (number)', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getClassName(3), 'Sentinel');
  });

  test('returns class name for known ID (string)', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getClassName('3'), 'Sentinel');
  });

  test('returns null for unknown class ID', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getClassName(99), null);
  });
});

describe('db.getMasteryName', () => {
  // Maxroll uses per-class relative mastery IDs (1–3), NOT global IDs.
  // Sentinel (classId 3), mastery 2 = Void Knight.
  test('returns mastery name for known classId + per-class masteryId', () => {
    const db = freshDb();
    db.load();
    const name = db.getMasteryName(3, 2); // Sentinel mastery 2 = Void Knight
    assert.equal(name, 'Void Knight');
  });

  test('returns null for unknown mastery ID', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getMasteryName(3, 99), null);
  });
});

// ─── all() ────────────────────────────────────────────────────────────────────

describe('db.all', () => {
  test('returns object with passives, skills, classes', () => {
    const db = freshDb();
    db.load();
    const result = db.all();
    assert.ok(result.passives && typeof result.passives === 'object');
    assert.ok(result.skills && typeof result.skills === 'object');
    assert.ok(result.classes && typeof result.classes === 'object');
  });

  test('passives from all() is keyed by treeID', () => {
    const db = freshDb();
    db.load();
    const { passives } = db.all();
    // passives.json is keyed by treeID (e.g. "kn-1"), not flat nodeId
    assert.ok(passives['kn-1'], 'expected kn-1 (Sentinel) tree');
    assert.ok(passives['ac-1'], 'expected ac-1 (Acolyte) tree');
    assert.ok(passives['kn-1'].nodes && typeof passives['kn-1'].nodes === 'object');
  });

  test('skills from all() contains real skill trees', () => {
    const db = freshDb();
    db.load();
    const { skills } = db.all();
    assert.ok(skills['fl44'], 'expected fl44 (Flay) skill tree');
    assert.ok(skills['fi9'], 'expected fi9 (Fireball) skill tree');
  });

  test('classes from all() contains passiveTreeByClass mapping', () => {
    const db = freshDb();
    db.load();
    const { classes } = db.all();
    assert.ok(classes.passiveTreeByClass, 'expected passiveTreeByClass in classes');
    assert.equal(classes.passiveTreeByClass['3'], 'kn-1');
  });
});
