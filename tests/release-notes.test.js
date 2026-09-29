/**
 * tests/release-notes.test.js
 * ────────────────────────────
 * scripts/release-notes.js: which commits players see, and the notes' shape.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseCommit, buildNotes } = require('../scripts/release-notes');

describe('parseCommit: what players see', () => {
  test('feat / fix / perf, with a capitalized subject; scopes players see are kept', () => {
    assert.deepEqual(parseCommit('feat: mix guides in one build'), { type: 'feat', text: 'Mix guides in one build' });
    assert.deepEqual(parseCommit('fix(ui): toasts hidden behind dialogs'), { type: 'fix', text: 'Toasts hidden behind dialogs' });
    assert.deepEqual(parseCommit('perf!: faster start'), { type: 'perf', text: 'Faster start' });
  });

  test('internal work, version bumps and free-form subjects stay out', () => {
    for (const s of ['chore: bump deps', 'docs: README', 'test: more cases', 'ci: windows matrix', 'refactor: split main', '0.2.0', 'Merge pull request #24', 'fix(data): prune unused icons', 'fix(ci): release duplicates', 'feat(extractor): --label']) {
      assert.equal(parseCommit(s), null, s);
    }
  });

  test('Release-note: in the body replaces the subject, or hides the commit', () => {
    assert.deepEqual(parseCommit('fix: cp1252 crash in extract.py', 'Details…\nRelease-note: The app no longer crashes on start for some Windows users.\n'),
      { type: 'fix', text: 'The app no longer crashes on start for some Windows users.' });
    assert.equal(parseCommit('feat: something', 'release-note: skip'), null);
  });
});

describe('buildNotes', () => {
  const commits = [ // newest first, like git log
    { subject: 'fix: updates broke on duplicate releases', body: '' },
    { subject: '0.2.0', body: '' },
    { subject: 'fix(data): re-exported icons always replace', body: '' },
    { subject: 'feat: mix guides in one build', body: '' },
    { subject: 'feat: mix guides in one build', body: '' }, // duplicate (cherry-pick) listed once
  ];
  const data = { version: 'bbb', label: 'Season 4 (1.4)', trees: 150, nodes: 4700 };

  test('sections in order, oldest change first, install footer and changelog link', () => {
    const md = buildNotes({ version: '0.2.1', prevTag: 'v0.2.0', commits, data: { ...data, version: 'aaa' }, prevData: { version: 'aaa' } });
    assert.match(md, /### New\n- Mix guides in one build\n\n### Fixes\n- Updates broke on duplicate releases\n/);
    assert.equal(md.match(/Mix guides/g).length, 1);
    assert.doesNotMatch(md, /icons always replace|0\.2\.0\n|Game data/);
    assert.match(md, /LE-Build-Planner-Setup-0\.2\.1\.exe/);
    assert.match(md, /compare\/v0\.2\.0\.\.\.v0\.2\.1/);
  });

  test('new game data gets its own section with the label', () => {
    const md = buildNotes({ version: '0.3.0', prevTag: 'v0.2.1', commits: [], data, prevData: { version: 'aaa' } });
    assert.match(md, /^### Game data updated\n\*\*Season 4 \(1\.4\)\*\* — 150 trees, 4,700 nodes\./);
    assert.match(md, /Small fixes and maintenance|### Install/);
  });

  test('the version’s What’s new entry opens the notes as highlights', () => {
    const md = buildNotes({ version: '0.3.0', prevTag: 'v0.2.1', commits, highlight: { title: 'What’s new, in the app', changes: [{ area: 'view', text: 'See what changed.' }] } });
    assert.match(md, /^## What’s new, in the app\n- \*\*Main view\*\* — See what changed\.\n\n### New/);
  });

  test('nothing player-facing → a plain line, never an empty release; first release has no compare link', () => {
    const md = buildNotes({ version: '0.1.0', prevTag: null, commits: [{ subject: 'chore: x', body: '' }], data, prevData: data });
    assert.match(md, /^Small fixes and maintenance under the hood\./);
    assert.doesNotMatch(md, /Full changelog/);
  });
});
