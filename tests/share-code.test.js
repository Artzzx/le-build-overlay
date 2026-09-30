/**
 * tests/share-code.test.js
 * ─────────────────────────
 * electron/share-code.js: a build plan ↔ one short text code.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const S = require('../electron/share-code');
const M = require('../shared/maxroll-import');
const { parseLoadout } = require('../parser/maxroll');
const DB = require('../db/build-db').all();

function realBuild(file, { withSource = true } = {}) {
  const planner = M.decodePlanner(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'), DB.skills);
  const vs = planner.variants.filter(v => !v.hidden && !v.error);
  const build = parseLoadout(vs.map(v => ({ name: v.name, json: JSON.stringify(v.build) })), DB.skills, DB.classes, planner.name);
  if (withSource) build.source = M.makeSource(vs.map(v => ({ maxroll: planner.id, variant: v.index, name: v.name })), { [planner.id]: planner.date });
  return { build, planner, vs };
}

describe('run-length routes', () => {
  test('round trip; bad input is refused', () => {
    assert.deepEqual(S.toRuns([6, 6, 6, 4, 4, 6]), [6, 3, 4, 2, 6, 1]);
    assert.deepEqual(S.fromRuns([6, 3, 4, 2, 6, 1]), [6, 6, 6, 4, 4, 6]);
    assert.throws(() => S.fromRuns([6]));
    assert.throws(() => S.fromRuns([6, 0]));
    assert.throws(() => S.fromRuns([6, 100000]), /too long/);
  });
});

describe('share codes on the real planners', () => {
  for (const file of ['maxroll-profile-le.json', 'mage_leveling.json', 'sentinel_leveling.json']) {
    test(`${file}: short, and decodes to the same routes + guide references`, () => {
      const { build, planner, vs } = realBuild(file);
      const code = S.encodeShareCode(build);
      assert.match(code, /^LEBP1\.[A-Za-z0-9_-]+$/);
      assert.ok(code.length < 1000, `${code.length} chars — must fit a Discord message comfortably`);
      const back = S.decodeShareCode(code);
      assert.equal(back.name, build.name);
      assert.equal(back.classId, build.classId);
      back.phases.forEach((p, i) => {
        assert.equal(p.name, build.phases[i].name);
        assert.deepEqual(p.ref, { maxroll: planner.id, variant: vs[i].index, name: vs[i].name });
        assert.deepEqual(p.build.passives.history, build.phases[i].tracks[0].history);
        const skills = build.phases[i].tracks.slice(1);
        assert.deepEqual(Object.keys(p.build.skillTrees), skills.map(t => t.skillKey));
        // What the parser rebuilds from the shared route is the same phase.
        const again = parseLoadout([{ name: p.name, json: JSON.stringify(p.build) }], DB.skills, DB.classes, 'x').phases[0];
        assert.deepEqual(again.tracks.map(t => t.history), build.phases[i].tracks.map(t => t.history));
        assert.equal(again.masteryId, build.phases[i].masteryId);
      });
    });
  }

  test('progress is never shared; the guide order is (track.guide), not the rebased one', () => {
    const { build } = realBuild('maxroll-profile-le.json');
    const t = build.phases[0].tracks[0];
    const played = structuredClone(build);
    played.phases[0].tracks[0] = { ...t, currentStep: 5, guide: t.history, history: [...t.history].reverse() };
    const back = S.decodeShareCode(S.encodeShareCode(played));
    assert.deepEqual(back.phases[0].build.passives.history, t.history);
    assert.doesNotMatch(JSON.stringify(back), /currentStep|held/);
  });

  test('phases without a guide carry only their route', () => {
    const { build } = realBuild('maxroll-profile-le.json', { withSource: false });
    const back = S.decodeShareCode(S.encodeShareCode(build));
    assert.ok(back.phases.every(p => !p.ref && p.build.passives.history.length));
  });
});

describe('reading pasted codes', () => {
  const { build } = realBuild('maxroll-profile-le.json');
  const code = S.encodeShareCode(build);

  test('found inside a message', () => {
    assert.equal(S.findShareCode(`my build: ${code} — have fun`), code);
    assert.equal(S.decodeShareCode(`\n${code}\n`).phases.length, build.phases.length);
  });

  test('anything else gets a readable error', () => {
    assert.throws(() => S.decodeShareCode('hello'), /isn’t a share code/);
    assert.throws(() => S.decodeShareCode(code.slice(0, 40)), /damaged/);
    assert.throws(() => S.decodeShareCode('LEBP1.' + Buffer.from('not zipped at all').toString('base64url')), /damaged/);
    assert.throws(() => S.encodeShareCode(null), /No build/);
  });

  test('a code built to break things is refused (bad guide id, too many phases)', () => {
    const zlib = require('zlib');
    const make = (payload) => 'LEBP1.' + zlib.deflateRawSync(Buffer.from(JSON.stringify(payload))).toString('base64url');
    const phase = { n: 'x', m: 0, t: [['', 1, 3]] };
    assert.throws(() => S.decodeShareCode(make({ n: 'x', c: 4, g: ['../../etc'], p: [{ ...phase, r: [0, 0, 'x'] }] })), /damaged \(guide\)/);
    assert.throws(() => S.decodeShareCode(make({ n: 'x', c: 4, g: [], p: Array(7).fill(phase) })), /damaged \(phases\)/);
    assert.throws(() => S.decodeShareCode(make({ n: 'x', c: 4, g: [], p: [{ n: 'x', t: [['bad key!', 1, 1], ['', 1, 1]] }] })), /damaged/);
    assert.equal(S.decodeShareCode(make({ n: 'ok', c: 4, g: [], p: [phase] })).phases[0].build.passives.history.length, 3);
  });
});
