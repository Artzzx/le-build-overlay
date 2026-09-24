/**
 * tests/extractor.test.js
 * ────────────────────────
 * Runs extractor/extract.py on a small fixture (temp dirs) and checks the
 * cleaned output, icon resolution and the output contract.
 * Skipped when python3 is not installed.
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'extractor', 'extract.py');
const PYTHON = ['python3', 'python'].find(bin => spawnSync(bin, ['--version']).status === 0);

const row = (treeID, nodeID, nodeName, extra = {}) => ({
  sourceType: 'SkillTreeNode', treeID, nodeID, nodeName, description: `${nodeName} does things.`,
  maxPoints: nodeID === 0 ? 0 : 3, treeFile: 'Tree.json', treeRawFields: {}, stats: [{ statName: 'Damage', value: '+1%' }], ...extra,
});

// One node per class passive tree (the contract requires all five).
const PASSIVES = ['ac-1', 'mg-1', 'kn-1', 'rg-1', 'pr-1'].map((t, i) => row(t, 0, `Passive ${i}`, { maxPoints: 8 }));

function run(dir, rows, extraArgs = []) {
  const input = path.join(dir, 'nodes_flat.json');
  fs.writeFileSync(input, JSON.stringify(rows));
  const out = path.join(dir, 'out');
  const res = spawnSync(PYTHON, [SCRIPT, '--input', input, '--out-dir', out, '--icons-dir', path.join(dir, 'icons'), ...extraArgs], { encoding: 'utf8' });
  const read = (f) => (fs.existsSync(path.join(out, f)) ? JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')) : null);
  return { ...res, skills: read('skill_tree_reconciled.json'), passives: read('passives.json') };
}

const touch = (dir, rel) => {
  const f = path.join(dir, 'icons', rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x');
};

describe('extract.py', { skip: !PYTHON && 'python3 not installed' }, () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-extract-'));
    touch(dir, 'es6ai/0.png');          // convention (no icon value)
    touch(dir, 'es6ai/12.png');         // relative path
    touch(dir, 'skills/VoidLens.webp'); // by stem
    touch(dir, 'skills/Rift.png');      // by file name
    touch(dir, 'deep/es6ai/14.png');    // by path tail from an absolute Windows path
    touch(dir, 'unused.png');
    touch(dir, 'a/Same.png');           // ambiguous name…
    touch(dir, 'b/Same.png');           // …in two folders
    touch(dir, 'pref/Pref.png');        // same stem, same folder:
    touch(dir, 'pref/Pref.webp');       // …webp preferred
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ROWS = [
    ...PASSIVES,
    row('es6ai', 0, 'Erasing Strike'),
    row('es6ai', 12, 'Void Lens', { icon: 'es6ai/12.png' }),
    row('es6ai', 13, 'Time Loop', { icon: 'VoidLens' }),
    row('es6ai', 14, 'Chamber of Fate', { icon: 'C:\\Export\\Icons\\deep\\ES6AI\\14.PNG' }),
    row('es6ai', 15, 'Rifts', { icon: 'textures/Rift.png' }),
    row('es6ai', 16, 'Missing Art', { icon: 'nope.png' }),
    row('es6ai', 17, 'Ambiguous', { icon: 'Same.png' }),
    row('es6ai', 18, 'No Icon'),
    row('es6ai', 20, 'Preferred', { icon: 'Pref' }),
    // Same node exported twice: the richer row wins but must keep the icon.
    row('es6ai', 19, 'Dupe', { icon: 'es6ai/12.png', stats: [] }),
    row('es6ai', 19, 'Dupe', { stats: [{ statName: 'Damage', value: '+2%' }, { statName: 'Speed', value: '+1%' }] }),
  ];

  test('resolves icons by path, path tail, name, stem and convention', () => {
    const { status, skills, stdout, stderr } = run(dir, ROWS);
    assert.equal(status, 0, stderr);
    const icon = (id) => skills.find(r => r.nodeID === id).icon;
    assert.equal(icon(0), 'es6ai/0.png');
    assert.equal(icon(12), 'es6ai/12.png');
    assert.equal(icon(13), 'skills/VoidLens.webp');
    assert.equal(icon(14), 'deep/es6ai/14.png');
    assert.equal(icon(15), 'skills/Rift.png');
    assert.equal(icon(16), null);
    assert.equal(icon(17), null, 'ambiguous bare name must not guess');
    assert.equal(icon(18), null);
    assert.equal(icon(20), 'pref/Pref.webp');
    assert.match(stdout, /2 icon values match no file/);
    assert.match(stdout, /not referenced by any node/);
  });

  test('duplicate rows keep the icon and the richer data', () => {
    const { skills } = run(dir, ROWS);
    const dupe = skills.filter(r => r.nodeID === 19);
    assert.equal(dupe.length, 1);
    assert.equal(dupe[0].stats.length, 2);
    assert.equal(dupe[0].icon, 'es6ai/12.png');
  });

  test('output rows have exactly the contract fields; passives split out', () => {
    const { skills, passives } = run(dir, ROWS);
    const FIELDS = ['description', 'icon', 'maxPoints', 'nodeID', 'nodeName', 'stats', 'treeID', 'treeName'];
    for (const r of [...skills, ...passives]) assert.deepEqual(Object.keys(r).sort(), FIELDS);
    assert.deepEqual(passives.map(r => r.treeID).sort(), ['ac-1', 'kn-1', 'mg-1', 'pr-1', 'rg-1']);
    assert.equal(passives.find(r => r.treeID === 'kn-1').treeName, 'Sentinel');
    assert.equal(skills[0].treeName, 'Erasing Strike');
  });

  test('--strict fails on unresolved icon values', () => {
    const { status, stderr } = run(dir, ROWS, ['--strict']);
    assert.notEqual(status, 0);
    assert.match(stderr, /unresolved icon values/);
  });

  test('a contract violation writes nothing', () => {
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'le-extract-bad-'));
    const { status, stderr, skills } = run(bad, [...PASSIVES, row('xx1', 'seven', 'Bad id')]);
    assert.notEqual(status, 0);
    assert.match(stderr, /data contract/);
    assert.equal(skills, null);
    fs.rmSync(bad, { recursive: true, force: true });
  });

  test('works with no icons folder at all', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'le-extract-bare-'));
    const { status, skills, stdout } = run(bare, [...PASSIVES, row('es6ai', 3, 'Plain', { icon: 'x.png' })]);
    assert.equal(status, 0);
    assert.equal(skills[0].icon, null);
    assert.match(stdout, /icons: none/);
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
