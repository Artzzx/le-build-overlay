/**
 * scripts/changelog.js — the release check for app/changelog.json (the in-app "What's new").
 * ──────────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/changelog.js check              validate the file (also a test)
 *   node scripts/changelog.js release v0.3.0     CI, before the build: the file is valid AND has
 *                                                an entry for 0.3.0; then fills in missing dates
 *                                                (a tagged version's tag date, today for this one)
 *                                                in the copy that gets packaged. Nothing is committed.
 * Write the entry BEFORE `npm version`: the tag's build needs it, and fails with a clear
 * message without it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validate } = require('../shared/changelog');

const FILE = path.join(__dirname, '..', 'app', 'changelog.json');

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const [cmd, tag] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const problems = validate(raw);
if (problems.length) fail(`app/changelog.json:\n  ${problems.join('\n  ')}`);

if (cmd === 'check') {
  console.log(`✔ app/changelog.json: ${raw.releases.length} versions`);
} else if (cmd === 'release' && /^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  const version = tag.slice(1);
  const entry = raw.releases.find(r => r.version === version);
  if (!entry) {
    fail(`app/changelog.json has no entry for ${version}. Add what players will notice (a few lines, each with an "area"), commit it, then tag again:\n` +
      `  git tag -d ${tag} && git push origin :refs/tags/${tag}\n  (add the entry, commit)\n  git tag ${tag} && git push origin ${tag}`);
  }
  const tagDate = (v) => { try { return execFileSync('git', ['log', '-1', '--format=%cs', `v${v}`], { encoding: 'utf8' }).trim() || null; } catch { return null; } };
  let stamped = 0;
  for (const r of raw.releases) {
    if (r.date) continue;
    r.date = r.version === version ? new Date().toISOString().slice(0, 10) : tagDate(r.version);
    if (r.date) stamped++; else delete r.date;
  }
  fs.writeFileSync(FILE, JSON.stringify(raw, null, 2) + '\n');
  console.log(`✔ ${version}: "${entry.title ?? ''}" (${entry.changes.length} change${entry.changes.length !== 1 ? 's' : ''}); ${stamped} date${stamped !== 1 ? 's' : ''} filled in`);
} else {
  fail('usage: node scripts/changelog.js check | release vX.Y.Z');
}
