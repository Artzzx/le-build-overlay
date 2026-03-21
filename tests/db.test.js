/**
 * tests/db.test.js
 * ─────────────────
 * Unit tests for db/build-db.js.
 * Uses Node.js built-in test runner (node:test) — no extra dependencies.
 *
 * Run: npm test
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Force reload of the module between tests to reset internal state
function freshDb() {
  // Clear module cache to reset the singleton state (_loaded, _passives, etc.)
  const dbPath = require.resolve('../db/build-db');
  delete require.cache[dbPath];
  return require('../db/build-db');
}

// ─── load + isPopulated ───────────────────────────────────────────────────────

describe('db.load + db.isPopulated', () => {
  test('loads placeholder data files without crashing', () => {
    const db = freshDb();
    assert.doesNotThrow(() => db.load());
  });

  test('isPopulated returns true after loading placeholder data', () => {
    const db = freshDb();
    db.load();
    // Placeholder db/data/passives.json and skills.json have sample entries
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
  test('returns passive node for known nodeId (number)', () => {
    const db = freshDb();
    db.load();
    const node = db.getPassive(1);
    assert.ok(node, 'expected node 1 to exist in placeholder DB');
    assert.equal(node.nodeId, 1);
    assert.equal(node.name, 'Strength');
  });

  test('returns passive node for known nodeId (string)', () => {
    const db = freshDb();
    db.load();
    const node = db.getPassive('6');
    assert.ok(node);
    assert.equal(node.name, 'Juggernaut');
  });

  test('returns null for unknown nodeId', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getPassive(9999), null);
  });

  test('passive node has expected shape', () => {
    const db = freshDb();
    db.load();
    const node = db.getPassive(1);
    assert.ok(typeof node.name === 'string');
    assert.ok(typeof node.description === 'string');
    assert.ok(typeof node.maxPoints === 'number');
    assert.ok(typeof node.treeId === 'string');
  });
});

// ─── getSkillNode ─────────────────────────────────────────────────────────────

describe('db.getSkillNode', () => {
  test('returns skill node for known skillKey + nodeId', () => {
    const db = freshDb();
    db.load();
    const node = db.getSkillNode('fl44', 4);
    assert.ok(node, 'expected fl44 node 4 to exist');
    assert.equal(node.nodeId, 4);
    assert.equal(node.name, 'Crushing Blows');
  });

  test('returns skill node with string nodeId', () => {
    const db = freshDb();
    db.load();
    const node = db.getSkillNode('fl44', '4');
    assert.ok(node);
    assert.equal(node.name, 'Crushing Blows');
  });

  test('returns null for unknown skillKey', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getSkillNode('flXXX', 4), null);
  });

  test('returns null for unknown nodeId in a known skill', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getSkillNode('fl44', 9999), null);
  });

  test('skill node has expected shape', () => {
    const db = freshDb();
    db.load();
    const node = db.getSkillNode('fl44', 14);
    assert.ok(node);
    assert.ok(typeof node.name === 'string');
    assert.ok(typeof node.description === 'string');
    assert.ok(typeof node.maxPoints === 'number');
  });
});

// ─── getSkillName ─────────────────────────────────────────────────────────────

describe('db.getSkillName', () => {
  test('returns skill name for known key', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getSkillName('fl44'), 'Erasing Strike');
    assert.equal(db.getSkillName('fl22'), 'Void Cleave');
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
    const name = db.getClassName(3);
    assert.equal(name, 'Sentinel');
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
  test('returns mastery name for known ID', () => {
    const db = freshDb();
    db.load();
    const name = db.getMasteryName(7); // 7 = Void Knight (Sentinel mastery)
    assert.equal(name, 'Void Knight');
  });

  test('returns null for unknown mastery ID', () => {
    const db = freshDb();
    db.load();
    assert.equal(db.getMasteryName(99), null);
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

  test('passives from all() contains expected nodes', () => {
    const db = freshDb();
    db.load();
    const { passives } = db.all();
    assert.ok(passives['1']);
    assert.ok(passives['6']);
  });
});
