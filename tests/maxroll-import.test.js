/**
 * tests/maxroll-import.test.js
 * ─────────────────────────────
 * shared/maxroll-import.js against a real planner response
 * (tests/fixtures/maxroll-profile-le.json = planner sb62zd0e, "1.4 Bladedancer Leveling").
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const M = require('../shared/maxroll-import');
const buildDb = require('../db/build-db');
const { parseLoadout } = require('../parser/maxroll');
const { buildView } = require('../shared/view-model');

buildDb.load();
const DB = buildDb.all();
const RAW = fs.readFileSync(path.join(__dirname, 'fixtures', 'maxroll-profile-le.json'), 'utf8');

describe('parseMaxrollLink', () => {
  test('planner links, #N variants, API links and bare ids', () => {
    assert.deepEqual(M.parseMaxrollLink('https://maxroll.gg/last-epoch/planner/sb62zd0e'), { id: 'sb62zd0e', variant: null });
    assert.deepEqual(M.parseMaxrollLink('  https://maxroll.gg/last-epoch/planner/sb62zd0e#3 '), { id: 'sb62zd0e', variant: 3 });
    assert.deepEqual(M.parseMaxrollLink('maxroll.gg/last-epoch/planner/sb62zd0e?x=1#2'), { id: 'sb62zd0e', variant: 2 });
    assert.deepEqual(M.parseMaxrollLink('https://planners.maxroll.gg/profiles/le/sb62zd0e'), { id: 'sb62zd0e', variant: null });
    assert.deepEqual(M.parseMaxrollLink('sb62zd0e'), { id: 'sb62zd0e', variant: null });
  });

  test('rejects other games and junk', () => {
    for (const s of ['', 'hello world', 'https://maxroll.gg/d4/planner/abc12345', 'https://example.com/last-epoch/planner/x', '{"class":4}']) {
      assert.equal(M.parseMaxrollLink(s), null, s);
    }
  });
});

describe('matchSkillTree', () => {
  const ids = ['sh4re', 'shiif', 'bl5st', 'ub5d9', 'smbmb', 'dagg3', 'falc0', 'aa989'];
  test('maps Maxroll ability names to treeIDs', () => {
    const cases = { ShadowRend: 'sh4re', Shift: 'shiif', 'Bladestorm Throw': 'bl5st', 'Umbral Blades 1': 'ub5d9', 'Smoke Bomb': 'smbmb', ShadowCascade: 'dagg3' };
    for (const [name, id] of Object.entries(cases)) assert.equal(M.matchSkillTree(name, ids, DB.skills), id, name);
  });
  test('only considers the given trees', () => {
    assert.equal(M.matchSkillTree('ShadowRend', ['falc0', 'aa989'], DB.skills), null);
    assert.equal(M.matchSkillTree('', ids, DB.skills), null);
  });
});

describe('decodePlanner (real planner)', () => {
  const planner = M.decodePlanner(RAW, DB.skills);
  const names = (v) => Object.keys(v.build.skillTrees).map(id => DB.skills[id].name);

  test('planner metadata and every variant', () => {
    assert.equal(planner.id, 'sb62zd0e');
    assert.equal(planner.name, '1.4 Bladedancer Leveling');
    assert.equal(planner.author, 'Terek');
    assert.deepEqual(planner.variants.map(v => v.name), ['Starting Setup (lvl 1 - 9)', 'Early Setup (lvl 10 - 15)', 'Intermediate Setup (lvl 16 - 49)', 'Final Setup (lvl 50 - 70)']);
    assert.deepEqual(planner.variants.map(v => v.masteryId), [0, 1, 1, 1]);
    assert.deepEqual(planner.variants.map(v => v.build.passives.history.length), [15, 20, 62, 83]);
  });

  test('only the specialized skills, in slot order — never the stale trees skillTrees still holds', () => {
    assert.deepEqual(planner.variants.map(names), [
      ['Shadow Rend', 'Shift'],
      ['Bladestorm', 'Shift'],
      ['Bladestorm', 'Umbral Blades', 'Smoke Bomb', 'Shadow Rend'],
      ['Bladestorm', 'Umbral Blades', 'Smoke Bomb', 'Shadow Rend', 'Shadow Cascade'],
    ]);
    for (const v of planner.variants) {
      assert.deepEqual(v.unmatched, []);
      for (const stale of ['aa989', 'db992', 'falc0']) assert.ok(!(stale in v.build.skillTrees), `${v.name}: ${stale}`);
    }
  });

  test('all four variants load as one mixed-mastery loadout', () => {
    const loadout = parseLoadout(planner.variants.map(v => ({ name: v.name, json: JSON.stringify(v.build) })), DB.skills, DB.classes, planner.name);
    assert.deepEqual(loadout.phases.map(p => p.masteryId), [0, 1, 1, 1]);
    assert.equal(buildView(loadout, DB).classLabel, 'Rogue');
    const final = buildView({ ...loadout, currentPhase: 3 }, DB);
    assert.equal(final.classLabel, 'Rogue · Bladedancer');
    assert.deepEqual(final.lanes.map(l => l.title), ['Bladedancer', 'Bladestorm', 'Umbral Blades', 'Smoke Bomb', 'Shadow Rend', 'Shadow Cascade']);
    assert.ok(final.lanes.every(l => !l.unresolved));
  });
});

describe('decodePlanner (edge cases)', () => {
  const variant = (over = {}) => ({ name: 'V', class: 4, mastery: 1, passives: { history: [1, 2, 3, 4], position: 4 }, skillTrees: { sh4re: { history: [2, 3, 4], position: 3 } }, specializedSkills: ['ShadowRend'], ...over });
  const planner = (profiles, over = {}) => ({ id: 'abc12345', name: 'P', game: 'le', data: JSON.stringify({ profiles, activeProfile: 0 }), ...over });

  test('position is the planner cursor: later points are not allocated yet', () => {
    const [v] = M.decodePlanner(planner([variant({ passives: { history: [1, 2, 3, 4], position: 2 }, skillTrees: { sh4re: { history: [2, 3, 4], position: 1 } } })]), DB.skills).variants;
    assert.deepEqual(v.build.passives.history, [1, 2]);
    assert.deepEqual(v.build.skillTrees.sh4re.history, [2]);
  });

  test('hidden variants are kept but skipped by #N; unknown ability names are reported', () => {
    const p = M.decodePlanner(planner([variant({ name: 'A', hidden: true }), variant({ name: 'B', specializedSkills: ['ShadowRend', 'Mystery Skill'] })]), DB.skills);
    assert.equal(p.variants[0].hidden, true);
    assert.equal(M.visibleVariantIndex(p.variants, 1), 1);
    assert.equal(M.visibleVariantIndex(p.variants, 2), null);
    assert.deepEqual(p.variants[1].unmatched, ['Mystery Skill']);
  });

  test('no specializedSkills: every tree, with a warning', () => {
    const [v] = M.decodePlanner(planner([variant({ specializedSkills: undefined })]), DB.skills).variants;
    assert.deepEqual(Object.keys(v.build.skillTrees), ['sh4re']);
    assert.equal(v.warnings.length, 1);
  });

  test('clear errors for other games, empty and unreadable planners', () => {
    assert.throws(() => M.decodePlanner(planner([variant()], { game: 'd4' }), DB.skills), /another game/);
    assert.throws(() => M.decodePlanner(planner([]), DB.skills), /no variants/);
    assert.throws(() => M.decodePlanner({ data: '{oops' }, DB.skills), /cannot read/);
  });
});

describe('decodePlanner (more real planners — class ids are the game enum)', () => {
  const load = (f) => {
    const planner = M.decodePlanner(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'), DB.skills);
    const loadout = parseLoadout(planner.variants.map(v => ({ name: v.name, json: JSON.stringify(v.build) })), DB.skills, DB.classes, planner.name);
    const view = (phase) => buildView({ ...loadout, currentPhase: phase }, DB);
    return { planner, loadout, view };
  };

  test('Sentinel (class 2) leveling: plain Sentinel, then Paladin (mastery 3) on the kn-1 tree', () => {
    const { planner, loadout, view } = load('sentinel_leveling.json');
    assert.deepEqual(loadout.phases.map(p => p.masteryId), [0, 3, 3, 3]);
    assert.equal(view(0).classLabel, 'Sentinel');
    const final = view(3);
    assert.equal(final.classLabel, 'Sentinel · Paladin');
    assert.equal(final.lanes[0].treeId, 'kn-1');
    assert.deepEqual(final.lanes.slice(1).map(l => l.title), ['Multistrike', 'Healing Hands', 'Judgement', 'Sigils Of Hope', 'Holy Aura']);
    assert.deepEqual(Object.keys(planner.variants[1].build.skillTrees).map(id => DB.skills[id].name), ['Rive', 'Healing Hands', 'Javelin']);
    assert.ok(final.lanes.every(l => !l.unresolved));
  });

  test('Mage (class 1) leveling: Spellblade (mastery 2) on the mg-1 tree; null skill slots ignored', () => {
    const { planner, view } = load('mage_leveling.json');
    assert.deepEqual(planner.variants.map(v => v.masteryId), [2, 2, 2]);
    assert.deepEqual(planner.variants[0].unmatched, [], 'Maxroll pads specializedSkills with nulls');
    const final = view(2);
    assert.equal(final.classLabel, 'Mage · Spellblade');
    assert.equal(final.lanes[0].treeId, 'mg-1');
    assert.deepEqual(final.lanes.slice(1).map(l => l.title), ['Enchant Weapon', 'Mana Strike', 'Shatter Strike', 'Flame Ward', 'Surge']);
  });
});
