/**
 * scripts/release-notes.js — player-facing release notes from the commits since the last release.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *   npm run notes              preview: what the next release would say (HEAD vs the latest tag)
 *   node scripts/release-notes.js v0.3.0 > notes.md     (what release.yml runs for a tag)
 *
 * Written for players, not developers:
 *   feat: → "New" · fix: → "Fixes" · perf: → "Improvements". Everything else stays out
 *   (chore/docs/test/ci/build/refactor/style, version bumps, merge commits), and so do the
 *   scopes players never see: fix(ci), feat(data), fix(release)… The game data gets its own
 *   line instead, from db/data/version.json (it changed since the last release → "Game data
 *   updated" + its label).
 *   A line `Release-note: <text>` in a commit body replaces the subject in the notes;
 *   `Release-note: skip` leaves the commit out.
 *
 * The pure part (parseCommit, buildNotes) is tested in tests/release-notes.test.js; the git
 * calls only run when this file is executed.
 */

'use strict';

const REPO_URL = 'https://github.com/Artzzx/le-build-overlay';
const SECTIONS = [['feat', 'New'], ['fix', 'Fixes'], ['perf', 'Improvements']];
// Scopes about the repo, CI or the maintainer's data pipeline: nothing a player sees.
const INTERNAL_SCOPES = new Set(['ci', 'build', 'release', 'data', 'dev', 'test', 'tests', 'docs', 'deps', 'extractor', 'scripts']);
const MAX_PER_SECTION = 25;

/** A commit → { type, text } for the notes, or null when players shouldn't see it. */
function parseCommit(subject, body = '') {
  const override = /^release-note:\s*(.+)$/im.exec(body)?.[1].trim();
  if (override && /^skip$/i.test(override)) return null;
  const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(String(subject).trim());
  if (!m) return null; // version bumps ("0.2.0"), free-form subjects
  const [, type, scope] = m;
  if (!SECTIONS.some(([t]) => t === type)) return null;
  if (scope && INTERNAL_SCOPES.has(scope.toLowerCase())) return null;
  const text = override ?? m[4];
  return { type, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/**
 * @param {object} o
 * @param {string} o.version          — "0.3.0"
 * @param {string|null} o.prevTag     — "v0.2.0", null for the first release
 * @param {string} [o.toRef]           — what the changelog link compares to (default v<version>)
 * @param {{ subject: string, body: string }[]} o.commits  — newest first (git log order)
 * @param {object|null} o.data        — db/data/version.json now
 * @param {object|null} o.prevData    — …at the previous release
 * @returns {string} markdown
 */
function buildNotes({ version, prevTag = null, toRef = `v${version}`, commits = [], data = null, prevData = null }) {
  const entries = commits.map(c => parseCommit(c.subject, c.body)).filter(Boolean).reverse(); // oldest first reads like a story
  const out = [];

  if (data?.version && data.version !== prevData?.version) {
    out.push('### Game data updated');
    out.push(`${data.label ? `**${data.label}** — ` : ''}${data.trees} trees, ${data.nodes.toLocaleString('en-US')} nodes.`);
    out.push('The first time you start this version, a short card explains what to check: your guide may have been updated for the patch too (characters menu › *Check the guide for updates*).');
    out.push('');
  }

  for (const [type, title] of SECTIONS) {
    const items = [...new Set(entries.filter(e => e.type === type).map(e => e.text))];
    if (!items.length) continue;
    out.push(`### ${title}`);
    for (const t of items.slice(0, MAX_PER_SECTION)) out.push(`- ${t}`);
    if (items.length > MAX_PER_SECTION) out.push(`- …and ${items.length - MAX_PER_SECTION} more`);
    out.push('');
  }

  if (!out.length) out.push('Small fixes and maintenance under the hood.', '');

  out.push('### Install');
  out.push(`- **LE-Build-Planner-Setup-${version}.exe** (recommended) installs the app and keeps it up to date by itself.`);
  out.push(`- **LE-Build-Planner-Portable-${version}.exe** runs without installing; it tells you when a new version is out.`);
  out.push('');
  out.push('Already installed? Nothing to do: the app downloads this version in the background and installs it when you close it.');
  out.push('Windows may warn the first time, because the app isn’t code-signed: click **More info → Run anyway**.');
  if (prevTag) out.push('', `**Full changelog**: ${REPO_URL}/compare/${prevTag}...${toRef}`);
  return out.join('\n') + '\n';
}

// ─── git glue (only when run) ─────────────────────────────────────────────────

function main() {
  const { execFileSync } = require('child_process');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const tryGit = (...args) => { try { return git(...args); } catch { return null; } };

  const tag = process.argv[2] ?? null;               // null = preview HEAD
  const ref = tag ?? 'HEAD';
  const version = tag ? tag.replace(/^v/, '') : require('../package.json').version;
  // The previous release: the newest v* tag reachable from before this one.
  const prevTag = (tryGit('tag', '--merged', tag ? `${ref}^` : ref, '--list', 'v[0-9]*', '--sort=-v:refname') ?? '')
    .split('\n').map(s => s.trim()).find(t => t && t !== tag) ?? null;

  const range = prevTag ? `${prevTag}..${ref}` : ref;
  const raw = git('log', '--no-merges', '--format=%s%x1f%b%x1e', range);
  const commits = raw.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => {
    const [subject, body = ''] = s.split('\x1f');
    return { subject: subject.trim(), body };
  });
  const readData = (r) => { const s = tryGit('show', `${r}:db/data/version.json`); try { return s ? JSON.parse(s) : null; } catch { return null; } };

  if (!tag) process.stderr.write(`Preview: the notes for the next release (commits since ${prevTag ?? 'the start'}). Nothing is published.\n\n`);
  process.stdout.write(buildNotes({ version, prevTag, toRef: tag ?? 'main', commits, data: readData(ref), prevData: prevTag ? readData(prevTag) : null }));
}

if (require.main === module) main();

module.exports = { parseCommit, buildNotes, INTERNAL_SCOPES };
