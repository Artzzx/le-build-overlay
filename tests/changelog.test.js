/**
 * tests/changelog.test.js
 * ────────────────────────
 * shared/changelog.js (the in-app "What's new") and the real app/changelog.json.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../shared/changelog');
const REAL = require('../app/changelog.json');
const { mergeSettings } = require('../electron/store');

const raw = {
  releases: [
    { version: '0.2.0', date: '2026-09-28', title: 'Two guides', changes: [{ area: 'loading', text: 'Combine guides' }, { area: 'guides', text: 'Every guide checked' }] },
    { version: '0.1.1', date: '2026-09-27', title: 'First', changes: [{ area: 'view', text: 'All trees' }, { area: 'loading', text: 'Maxroll links' }] },
    { version: '0.2.1', changes: [{ area: 'updates', text: 'Updates fixed' }] },
    { version: '1.0.0', changes: [{ area: 'view', text: 'Big one' }] },
    { version: '0.3.0', changes: [{ area: 'view', text: 'Not out yet' }] },
  ],
};

describe('releases(): the history the app shows', () => {
  test('newest first; the update type comes from the version numbers', () => {
    const list = C.releases(raw);
    assert.deepEqual(list.map(r => [r.version, r.type]), [['1.0.0', 'major'], ['0.3.0', 'minor'], ['0.2.1', 'patch'], ['0.2.0', 'minor'], ['0.1.1', 'first']]);
    assert.deepEqual(list.find(r => r.version === '0.2.0').areas, ['loading', 'guides']);
  });

  test('versions newer than the running app (written ahead of a release) never show', () => {
    const list = C.releases(raw, { upTo: '0.2.1' });
    assert.deepEqual(list.map(r => r.version), ['0.2.1', '0.2.0', '0.1.1']);
    assert.equal(list[0].current, true);
    assert.equal(list[1].current, false);
  });

  test('byArea(): each feature’s history, newest first, in AREAS order', () => {
    const groups = C.byArea(C.releases(raw, { upTo: '0.2.1' }));
    assert.deepEqual(groups.map(g => g.area), ['view', 'loading', 'guides', 'updates']);
    assert.deepEqual(groups.find(g => g.area === 'loading').changes.map(c => c.version), ['0.2.0', '0.1.1']);
  });
});

describe('validate()', () => {
  test('catches what would break the dialog or the release', () => {
    assert.deepEqual(C.validate(raw), []);
    const bad = C.validate({ releases: [
      { version: '1.0', changes: [] },
      { version: '0.2.0', date: '28/09/2026', changes: [{ area: 'nope', text: 'x' }, { area: 'view', text: ' ' }] },
      { version: '0.2.0', changes: [] },
    ] });
    assert.equal(bad.length, 5, bad.join('\n'));
    assert.deepEqual(C.validate({}), ['changelog.json must be { "releases": [ … ] }']);
  });
});

describe('the real app/changelog.json', () => {
  test('is valid, and the current version has an entry', () => {
    assert.deepEqual(C.validate(REAL), []);
    const version = require('../package.json').version;
    assert.ok(REAL.releases.some(r => r.version === version), `app/changelog.json has no entry for ${version} (package.json)`);
  });
});

test('settings: lastAppVersion is kept only when it is a version', () => {
  assert.equal(mergeSettings({ lastAppVersion: '0.2.1' }).lastAppVersion, '0.2.1');
  assert.equal(mergeSettings({ lastAppVersion: '../x' }).lastAppVersion, null);
  assert.equal(mergeSettings({}).lastAppVersion, null);
});

describe('addDataEntry (npm run data) and format', () => {
  const base = { releases: [{ version: '0.4.1', date: '2026-09-30', title: 'Fixes', changes: [{ area: 'view', text: 'x' }] }] };

  test('no release written ahead → a new minor version with the game-data line', () => {
    const r = C.addDataEntry(base, { current: '0.4.1', label: 'Season 4' });
    assert.equal(r.version, '0.5.0');
    assert.equal(r.changed, true);
    assert.deepEqual(r.raw.releases.at(-1), { version: '0.5.0', title: 'Season 4', changes: [{ area: 'data', text: 'Game data for Season 4: the latest skills, passives and node icons.' }] });
    assert.deepEqual(C.validate(r.raw), []);
    assert.equal(base.releases.length, 1, 'input untouched');
  });

  test('a release written ahead gets the line; re-running changes nothing', () => {
    const ahead = { releases: [...base.releases, { version: '0.6.0', title: 'Big one', changes: [{ area: 'view', text: 'New view' }] }] };
    const r = C.addDataEntry(ahead, { current: '0.4.1', label: null });
    assert.equal(r.version, '0.6.0');
    assert.deepEqual(r.raw.releases.at(-1).changes.map(c => c.area), ['view', 'data']);
    const again = C.addDataEntry(r.raw, { current: '0.4.1', label: 'Season 5' });
    assert.equal(again.changed, false);
    assert.equal(again.raw, r.raw);
  });

  test('format() writes the real file back byte for byte, in its own line endings (clean diffs)', () => {
    const text = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'changelog.json'), 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n'; // Git for Windows checks out with \r\n
    assert.equal(C.format(JSON.parse(text), { eol }), text);
    const lf = text.replace(/\r\n/g, '\n');
    assert.equal(C.format(JSON.parse(lf)), lf);
    assert.equal(C.format(JSON.parse(lf), { eol: '\r\n' }), lf.replace(/\n/g, '\r\n'));
  });
});
