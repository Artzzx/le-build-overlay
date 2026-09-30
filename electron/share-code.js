/**
 * electron/share-code.js
 * ───────────────────────
 * A build plan as one short text code, to paste in Discord or Reddit:
 *
 *   LEBP1.<base64url(deflate-raw(JSON))>
 *
 * It carries the PLAN, never progress: the build name, class, and per phase
 *   - the route as the sharer has it (tracks as run-length node lists), always; and
 *   - a reference to its guide (Maxroll planner + variant index + variant name) when it
 *     has one. The importer fetches the guide fresh, so they get its current version and
 *     guide updates keep working for them. The route is the fallback when Maxroll can't
 *     be reached or the author deleted that variant.
 * A real 4-phase build is ~300–600 characters: fine for a Discord message.
 *
 * Payload v1 (short keys keep codes small; see SHARE_LIMITS):
 *   { n: name, c: classId, g: [plannerId…],
 *     p: [ { n: phaseName, m: masteryId, l?: level, t: [[skillKey|'', runs…]…], r?: [plannerIndex, variant, variantName] } ] }
 * runs = [node, count, node, count, …] (a history like 6,6,6,4,4 → 6,3,4,2).
 *
 * Pure apart from zlib; tested in tests/share-code.test.js.
 */

'use strict';

const zlib = require('zlib');
const MaxrollImport = require('../shared/maxroll-import');

const PREFIX = 'LEBP1.';
const SHARE_LIMITS = { phases: 6, tracks: 6, points: 600, name: 80, code: 20000 };
const CODE_RE = /LEBP1\.[A-Za-z0-9_-]{8,}/;
const SKILL_KEY_RE = /^[a-z0-9]{2,12}$/i;

// ─── Run-length node lists ────────────────────────────────────────────────────

function toRuns(history) {
  const out = [];
  for (const node of history) {
    if (out.length && out[out.length - 2] === node) out[out.length - 1]++;
    else out.push(node, 1);
  }
  return out;
}

function fromRuns(runs) {
  if (!Array.isArray(runs) || runs.length % 2) throw new Error('bad route');
  const out = [];
  for (let i = 0; i < runs.length; i += 2) {
    const [node, count] = [runs[i], runs[i + 1]];
    if (!Number.isInteger(node) || node < 0 || !Number.isInteger(count) || count < 1) throw new Error('bad route');
    if (out.length + count > SHARE_LIMITS.points) throw new Error('route too long');
    for (let k = 0; k < count; k++) out.push(node);
  }
  return out;
}

// ─── Encode ───────────────────────────────────────────────────────────────────

/** A build (a profile's `build`) → its share code. */
function encodeShareCode(build) {
  if (!build || !Array.isArray(build.phases) || !build.phases.length) throw new Error('No build to share yet.');
  const guide = MaxrollImport.guideSources(build.source, build.phases.length);
  const planners = [];
  const phases = build.phases.map((phase, i) => {
    const e = guide.phases[i];
    const tracks = phase.tracks.map(t => [t.type === 'passive' ? '' : t.skillKey, ...toRuns(t.guide ?? t.history)]);
    const out = { n: String(phase.name ?? '').slice(0, SHARE_LIMITS.name), m: phase.masteryId ?? 0, ...(Number.isInteger(phase.level) ? { l: phase.level } : {}), t: tracks };
    if (e && Number.isInteger(e.variant)) {
      let g = planners.indexOf(e.maxroll);
      if (g < 0) g = planners.push(e.maxroll) - 1;
      out.r = [g, e.variant, e.name];
    }
    return out;
  });
  const payload = { n: String(build.name ?? '').slice(0, SHARE_LIMITS.name), c: build.classId, g: planners, p: phases };
  return PREFIX + zlib.deflateRawSync(Buffer.from(JSON.stringify(payload)), { level: 9 }).toString('base64url');
}

// ─── Decode ───────────────────────────────────────────────────────────────────

/** Find a share code in pasted text (it may come with a message around it). */
function findShareCode(text) {
  return CODE_RE.exec(String(text ?? ''))?.[0] ?? null;
}

/**
 * A share code → { name, classId, phases: [{ name, build, ref? }] }. `build` is the route as shared,
 * Export-shaped ({ class, mastery, level?, passives, skillTrees }, what parser/maxroll.js reads);
 * `ref` = { maxroll, variant, name }, the guide to fetch it fresh from.
 * Throws a readable error for anything that isn't a valid code.
 */
function decodeShareCode(text) {
  const code = findShareCode(text);
  if (!code) throw new Error('That isn’t a share code (they start with LEBP1.).');
  if (code.length > SHARE_LIMITS.code) throw new Error('That share code is too long.');
  let payload;
  try {
    payload = JSON.parse(zlib.inflateRawSync(Buffer.from(code.slice(PREFIX.length), 'base64url'), { maxOutputLength: 1 << 20 }).toString('utf8'));
  } catch {
    throw new Error('That share code is damaged — copy it again, the whole line.');
  }
  const bad = (why) => { throw new Error(`That share code is damaged (${why}).`); };
  if (!payload || typeof payload !== 'object') bad('empty');
  if (!Number.isInteger(payload.c) || payload.c < 0 || payload.c > 20) bad('class');
  const planners = Array.isArray(payload.g) ? payload.g : [];
  if (!planners.every(id => MaxrollImport.parseMaxrollLink(id)?.id === id)) bad('guide');
  if (!Array.isArray(payload.p) || !payload.p.length || payload.p.length > SHARE_LIMITS.phases) bad('phases');

  const phases = payload.p.map((p) => {
    const name = String(p?.n ?? '').slice(0, SHARE_LIMITS.name);
    let ref = null;
    if (p?.r != null) {
      const [g, variant, variantName] = Array.isArray(p.r) ? p.r : [];
      if (!Number.isInteger(g) || !planners[g] || !Number.isInteger(variant) || variant < 0 || typeof variantName !== 'string') bad('guide phase');
      ref = { maxroll: planners[g], variant, name: variantName.slice(0, SHARE_LIMITS.name) };
    }
    if (!Array.isArray(p?.t) || !p.t.length || p.t.length > SHARE_LIMITS.tracks) bad('route');
    const build = { class: payload.c, mastery: Number.isInteger(p.m) ? p.m : 0, passives: null, skillTrees: {} };
    if (Number.isInteger(p.l) && p.l > 0) build.level = p.l;
    try {
      for (const [key, ...runs] of p.t) {
        const history = fromRuns(runs);
        if (key === '') build.passives = { history, position: history.length };
        else if (SKILL_KEY_RE.test(key)) build.skillTrees[key] = { history, position: history.length };
        else bad('skill');
      }
    } catch (err) {
      if (/damaged/.test(err.message)) throw err;
      bad('route');
    }
    if (!build.passives) bad('passives');
    return ref ? { name, build, ref } : { name, build };
  });
  return { name: String(payload.n ?? '').slice(0, SHARE_LIMITS.name), classId: payload.c, phases };
}

module.exports = { encodeShareCode, decodeShareCode, findShareCode, toRuns, fromRuns, PREFIX, SHARE_LIMITS };
