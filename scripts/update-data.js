/**
 * scripts/update-data.js — `npm run data "Season 4 (1.4)"`   (any shell, PowerShell included)
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * The maintainer's one command after exporting new game data (once per season
 * or big patch). Players never run this: the data ships inside the app and
 * reaches them with the next app update.
 *
 *   Input (from your exporter):  extractor/nodes_flat.json + node images in db/data/icons/
 *   (the exporter overwrites every image; unchanged ones re-encode to identical files)
 *   1. convert_icons.py  — PNG/JPG → WebP (never commit PNGs)
 *   2. extract.py        — clean + validate → db/data/*.json + version.json, then delete the icons
 *                          no node uses any more (--prune-icons). The label (see parseArgs)
 *                          and flags like --strict, --verbose are passed on
 *   3. npm test          — the whole suite against the new data
 *   4. app/changelog.json — the next release's What's new gets its "Game data for <label>"
 *                          line (Changelog.addDataEntry); the release refuses a version without
 *                          an entry, so this step can't be forgotten
 * Then it prints what to commit and how to release.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * The season label and the flags for extract.py, whatever the shell did to them.
 *   npm run data "Season 4"                 → the plain words are the label (works everywhere)
 *   npm run data -- --label "Season 4"      → bash / cmd
 * PowerShell strips the `--`, so npm takes `--label` as its own setting and passes only the
 * words (`Season 4`): they still become the label. `npm run data --label="Season 4"` reaches
 * us as env npm_config_label. Other flags (--strict, --verbose) go to extract.py as given.
 */
function parseArgs(argv, env = {}) {
  const words = [];
  const flags = [];
  let label = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') label = argv[++i] ?? null;
    else if (a.startsWith('--label=')) label = a.slice('--label='.length);
    else if (a.startsWith('-')) flags.push(a);
    else words.push(a);
  }
  if (label == null && words.length) label = words.join(' ');
  const fromNpm = env.npm_config_label;
  if (label == null && fromNpm && fromNpm !== 'true') label = fromNpm;
  label = label?.trim() || null;
  return { label, extractArgs: [...flags, ...(label ? ['--label', label] : [])] };
}

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

function main() {
  const { extractArgs } = parseArgs(process.argv.slice(2), process.env);
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
  step('Extracting and validating game data', ...py('extract.py', ['--prune-icons', ...extractArgs]));
  step('Running the test suite', 'npm', ['test']);

  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'data', 'version.json'), 'utf8'));

  // What's new: the next release says "Game data for <label>" (written once; re-runs change nothing).
  const Changelog = require('../shared/changelog');
  const file = path.join(ROOT, 'app', 'changelog.json');
  const original = fs.readFileSync(file, 'utf8');
  const { raw, version, changed } = Changelog.addDataEntry(JSON.parse(original), {
    current: require('../package.json').version, label: v.label,
  });
  if (changed) fs.writeFileSync(file, Changelog.format(raw, { eol: original.includes('\r\n') ? '\r\n' : '\n' }));
  console.log(`
  ✔ Game data ${v.version}${v.label ? ` (${v.label})` : ''}: ${v.trees} trees, ${v.nodes} nodes — all tests pass.
  ✔ What's new for ${version}: ${changed ? 'game data line added' : 'already mentions the game data'} (app/changelog.json — edit the text if you like).

  Next:
    1. git add extractor/nodes_flat.json db/data app/changelog.json
       git commit -m "feat(data): ${v.label ?? 'new game data'}"
    2. npm version ${version}          # bumps the app version and tags v${version}
       git push --follow-tags     # GitHub builds the installer and publishes the release

  Players get it automatically: the app downloads the update in the background,
  and after the restart shows a one-time "Game data updated" card.
  `);
}

if (require.main === module) main();

module.exports = { parseArgs };
