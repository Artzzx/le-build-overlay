/**
 * shared/changelog.js
 * ────────────────────
 * The player-facing change history ("What's new"), from app/changelog.json:
 *
 *   { "releases": [ { "version": "0.2.0", "date": "2026-09-28", "title": "Two guides in one build",
 *                     "changes": [ { "area": "loading", "text": "…" } ] } ] }
 *
 * Hand-written on purpose: a few lines per version, about what a player notices, each
 * tagged with the feature it touches (AREAS). Release notes on GitHub are the detailed,
 * commit-level list; this is the short story. The update type (minor / patch) is not
 * written: it follows from the version numbers.
 *
 * UMD, pure: the main process (validation), the renderer (the What's new dialog),
 * scripts/changelog.js (the release check) and the tests.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Changelog = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The features a change can touch, in the order the "By feature" view lists them. */
  const AREAS = {
    view: 'Main view',
    loading: 'Loading builds',
    phases: 'Phases & respec',
    guides: 'Guide updates',
    characters: 'Characters',
    hotkeys: 'Hotkeys & sounds',
    mini: 'Mini mode',
    data: 'Game data',
    updates: 'App updates',
  };

  const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const parts = (v) => VERSION_RE.exec(v).slice(1).map(Number);
  function compare(a, b) {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  }

  /** 'first' | 'major' | 'minor' | 'patch' — from the version before it. */
  function updateType(version, previous) {
    if (!previous) return 'first';
    const [a, b] = [parts(previous), parts(version)];
    return b[0] > a[0] ? 'major' : b[1] > a[1] ? 'minor' : 'patch';
  }

  /** Problems with the file, as sentences ([] = fine). The release check and a test use it. */
  function validate(raw) {
    const out = [];
    const list = raw?.releases;
    if (!Array.isArray(list)) return ['changelog.json must be { "releases": [ … ] }'];
    const seen = new Set();
    list.forEach((r, i) => {
      const at = `releases[${i}]${r?.version ? ` (${r.version})` : ''}`;
      if (!VERSION_RE.test(r?.version ?? '')) out.push(`${at}: "version" must look like 1.2.3`);
      else if (seen.has(r.version)) out.push(`${at}: version listed twice`);
      else seen.add(r.version);
      if (r?.date != null && !DATE_RE.test(r.date)) out.push(`${at}: "date" must be YYYY-MM-DD`);
      if (r?.title != null && (typeof r.title !== 'string' || !r.title.trim())) out.push(`${at}: "title" must be text`);
      if (!Array.isArray(r?.changes)) { out.push(`${at}: "changes" must be a list`); return; }
      r.changes.forEach((c, j) => {
        if (!AREAS[c?.area]) out.push(`${at} change ${j + 1}: "area" must be one of ${Object.keys(AREAS).join(', ')}`);
        if (typeof c?.text !== 'string' || !c.text.trim()) out.push(`${at} change ${j + 1}: "text" is empty`);
      });
    });
    return out;
  }

  /**
   * Newest first, each with its update type and the areas it touches. Releases newer than
   * `upTo` (written ahead of the release) are left out; invalid entries are skipped.
   * @returns {{ version, date, title, type, areas: string[], changes: {area, text}[], current: boolean }[]}
   */
  function releases(raw, { upTo = null } = {}) {
    const list = (Array.isArray(raw?.releases) ? raw.releases : [])
      .filter(r => VERSION_RE.test(r?.version ?? '') && Array.isArray(r.changes))
      .map(r => ({ ...r, changes: r.changes.filter(c => AREAS[c?.area] && typeof c.text === 'string' && c.text.trim()) }))
      .sort((a, b) => compare(a.version, b.version));
    const out = list.map((r, i) => ({
      version: r.version,
      date: DATE_RE.test(r.date ?? '') ? r.date : null,
      title: typeof r.title === 'string' ? r.title.trim() : null,
      type: updateType(r.version, list[i - 1]?.version),
      areas: Object.keys(AREAS).filter(a => r.changes.some(c => c.area === a)),
      changes: r.changes,
      current: upTo != null && r.version === upTo,
    }));
    return out.filter(r => upTo == null || !VERSION_RE.test(upTo) || compare(r.version, upTo) <= 0).reverse();
  }

  /** The same changes grouped by feature (AREAS order), newest first within each. */
  function byArea(list) {
    return Object.entries(AREAS)
      .map(([area, label]) => ({
        area, label,
        changes: list.flatMap(r => r.changes.filter(c => c.area === area).map(c => ({ text: c.text, version: r.version, date: r.date, type: r.type }))),
      }))
      .filter(g => g.changes.length);
  }

  return { AREAS, updateType, validate, releases, byArea, compare };
}));
