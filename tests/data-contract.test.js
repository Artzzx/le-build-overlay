/**
 * tests/data-contract.test.js
 * ────────────────────────────
 * The game-data files the app actually loads must match what it needs:
 * row shape and types, unique (treeID, nodeID), every class passive tree
 * present, every classes.json mapping resolvable, and every `icon` pointing at
 * a real file in db/data/icons/.
 *
 * Checks the committed extractor outputs (skill_tree_reconciled.json + passives.json).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'db', 'data');
const ICONS = path.join(DATA, 'icons');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const skillFile = 'skill_tree_reconciled.json';
const files = [skillFile, 'passives.json'];
const rows = files.flatMap(f => read(f).map(r => ({ ...r, _file: f })));
const classes = read('classes.json');

describe(`data contract (${files.join(' + ')})`, () => {
  test('every row has the fields and types the app reads', () => {
    const bad = [];
    for (const r of rows) {
      const ok = typeof r.treeID === 'string' && r.treeID
        && typeof r.treeName === 'string'
        && Number.isInteger(r.nodeID) && r.nodeID >= 0
        && typeof r.nodeName === 'string'
        && typeof r.description === 'string'
        && Number.isInteger(r.maxPoints) && r.maxPoints >= 0
        && Array.isArray(r.stats) && r.stats.every(s => typeof s?.statName === 'string')
        && (r.icon === null || (typeof r.icon === 'string' && r.icon.length > 0));
      if (!ok) bad.push(`${r._file} ${r.treeID}:${r.nodeID}`);
    }
    assert.deepEqual(bad.slice(0, 10), []);
  });

  test('(treeID, nodeID) is unique within each file', () => {
    for (const f of files) {
      const seen = new Set();
      const dupes = [];
      for (const r of rows.filter(x => x._file === f)) {
        const k = `${r.treeID}:${r.nodeID}`;
        if (seen.has(k)) dupes.push(k);
        seen.add(k);
      }
      assert.deepEqual(dupes.slice(0, 10), [], f);
    }
  });

  test('every class maps to a passive tree that has nodes, and every mastery has a name', () => {
    for (const [classId, treeId] of Object.entries(classes.passiveTreeByClass)) {
      assert.ok(classes.classes[classId], `class ${classId} has a name`);
      assert.ok(rows.some(r => r.treeID === treeId), `passive tree ${treeId} (class ${classId}) has nodes`);
      assert.equal(Object.keys(classes.masteriesByClass[classId] ?? {}).length, 3, `class ${classId} has 3 masteries`);
    }
  });

  test('passives.json holds only class passive trees, and the skill file none of them', () => {
    const passiveIds = new Set(Object.values(classes.passiveTreeByClass));
    assert.ok(read('passives.json').every(r => passiveIds.has(r.treeID)));
    assert.ok(read(skillFile).every(r => !passiveIds.has(r.treeID)));
  });

  test('every row carries the icon field (null or a path)', () => {
    assert.deepEqual(rows.filter(r => !('icon' in r)).slice(0, 5).map(r => `${r.treeID}:${r.nodeID}`), []);
  });

  test('every icon points at an existing file inside db/data/icons', () => {
    const missing = [];
    for (const r of rows) {
      if (!r.icon) continue;
      const abs = path.resolve(ICONS, r.icon);
      if (!abs.startsWith(ICONS + path.sep) || !fs.existsSync(abs)) missing.push(`${r.treeID}:${r.nodeID} → ${r.icon}`);
    }
    assert.deepEqual(missing.slice(0, 10), []);
  });
});
