/**
 * scripts/update-data.js — `npm run data [-- --label "Season 4 (1.4)"]`
 * ───────────────────────────────────────────────────────────────────────
 * The maintainer's one command after exporting new game data (once per season
 * or big patch). Players never run this: the data ships inside the app and
 * reaches them with the next app update.
 *
 *   Input (from your exporter):  extractor/nodes_flat.json + node images in db/data/icons/
 *   (the exporter overwrites every image; unchanged ones re-encode to identical files)
 *   1. convert_icons.py  — PNG/JPG → WebP (never commit PNGs)
 *   2. extract.py        — clean + validate → db/data/*.json + version.json, then delete the icons
 *                          no node uses any more (--prune-icons). Extra args are passed on,
 *                          e.g. --label "Season 4", --strict, --verbose
 *   3. npm test          — the whole suite against the new data
 * Then it prints what to commit and how to release.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const extraArgs = process.argv.slice(2);

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function step(title, cmd, args) {
  console.log(`\n▶ ${title}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
  if (res.error) fail(`${title}: ${res.error.message}`);
  if (res.status !== 0) fail(`${title} failed (exit ${res.status}) — nothing to release. Fix the problem above and run it again.`);
}

// Python 3 as `python3`, `python`, or the Windows launcher `py -3`.
const PYTHON = [['python3'], ['python'], ['py', '-3']].find(([cmd, ...pre]) => {
  const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' });
  return r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`);
});
if (!PYTHON) fail('Python 3 not found. Install it from python.org, then: pip install -r extractor/requirements.txt');
const pillow = spawnSync(PYTHON[0], [...PYTHON.slice(1), '-c', 'import PIL'], { encoding: 'utf8' });
if (pillow.status !== 0) fail('Pillow is missing. Run: pip install -r extractor/requirements.txt');

if (!fs.existsSync(path.join(ROOT, 'extractor', 'nodes_flat.json'))) fail('extractor/nodes_flat.json not found — run your game-data exporter first.');
if (!fs.existsSync(path.join(ROOT, 'db', 'data', 'icons'))) fail('db/data/icons/ not found — your exporter should put the node images there.');

const py = (script, args = []) => [PYTHON[0], [...PYTHON.slice(1), path.join('extractor', script), ...args]];
step('Converting icons to WebP', ...py('convert_icons.py'));
step('Extracting and validating game data', ...py('extract.py', ['--prune-icons', ...extraArgs]));
step('Running the test suite', 'npm', ['test']);

const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'data', 'version.json'), 'utf8'));
console.log(`
✔ Game data ${v.version}${v.label ? ` (${v.label})` : ''}: ${v.trees} trees, ${v.nodes} nodes — all tests pass.

Next:
  git add extractor/nodes_flat.json db/data
  git commit -m "data: ${v.label ?? 'new game data'}"
  npm version minor          # bumps the app version and tags it (vX.Y.0)
  git push --follow-tags     # GitHub builds the installer and publishes the release

Players get it automatically: the app downloads the update in the background,
and after the restart shows a one-time "Game data updated" card.
`);
