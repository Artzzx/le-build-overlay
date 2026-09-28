/**
 * shared/maxroll-import.js
 * ─────────────────────────
 * Turns a Maxroll Last Epoch planner (the JSON served by
 * https://planners.maxroll.gg/profiles/le/<id>) into Export-shaped builds that
 * parser/maxroll.js already understands — one per planner variant.
 *
 * UMD, pure: used by the main process (electron/maxroll.js) and the tests.
 *
 * Response shape (see tests/fixtures/maxroll-profile-le.json):
 *   { id, name, game: 'le', user: { username }, data: "<JSON string>" }
 *   data → { profiles: [variant…], activeProfile }
 *   variant → { name, class, mastery, level, hidden?,
 *               passives: { history, position },
 *               skillTrees: { <treeID>: { history, position } },   ← EVERY tree ever touched
 *               specializedSkills: ["Bladestorm Throw", "ShadowRend", …] }  ← the build's skills
 *
 * Two traps this module handles:
 *   - skillTrees keeps stale trees (a Bladedancer planner still lists Falconry,
 *     Dive Bomb, …). Only the trees named in specializedSkills are the build.
 *   - specializedSkills holds ability names ("Umbral Blades 1", "ShadowRend"),
 *     not treeIDs — they are matched to the variant's trees by normalized name.
 *   - position is the planner cursor: only history[0, position) is allocated.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MaxrollImport = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API_BASE = 'https://planners.maxroll.gg/profiles/le/';
  const ID_RE = /^[a-z0-9]{6,12}$/i;

  /**
   * A pasted Maxroll link (or bare id) → { id, variant } where variant is the
   * 1-based VISIBLE variant from a "#N" fragment, or null. Null for anything else.
   */
  function parseMaxrollLink(text) {
    const s = String(text ?? '').trim();
    if (!s) return null;
    if (ID_RE.test(s)) return { id: s, variant: null };
    const m = /(?:maxroll\.gg\/last-epoch\/planner|planners\.maxroll\.gg\/profiles\/le)\/([a-z0-9]+)(?:[/?][^#\s]*)?(?:#(\d+))?/i.exec(s);
    if (!m || !ID_RE.test(m[1])) return null;
    const n = m[2] ? Number(m[2]) : null;
    return { id: m[1], variant: n && n > 0 ? n : null };
  }

  /** "Umbral Blades 1" / "ShadowRend" / "Bladestorm Throw" → comparable key. */
  function normalizeName(name) {
    return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/\d+$/, '');
  }

  /**
   * Match a specialized ability name to one of the variant's trees.
   * Exact normalized match first, then prefix either way ("bladestormthrow" ↔
   * "bladestorm"); the longest tree name wins a prefix tie.
   * @param {string} abilityName
   * @param {string[]} treeIds   — candidates (the variant's skillTrees keys)
   * @param {object} trees       — db.skills: { [treeID]: { name } }
   */
  function matchSkillTree(abilityName, treeIds, trees) {
    const want = normalizeName(abilityName);
    if (!want) return null;
    const cands = treeIds
      .map(id => ({ id, key: normalizeName(trees?.[id]?.name ?? id) }))
      .filter(c => c.key);
    const exact = cands.find(c => c.key === want);
    if (exact) return exact.id;
    const prefix = cands
      .filter(c => want.startsWith(c.key) || c.key.startsWith(want))
      .sort((a, b) => b.key.length - a.key.length);
    return prefix[0]?.id ?? null;
  }

  const allocated = (t) => {
    const h = Array.isArray(t?.history) ? t.history : [];
    return Number.isInteger(t?.position) && t.position >= 0 && t.position < h.length ? h.slice(0, t.position) : h.slice();
  };

  /** One planner variant → Export-shaped build + what was matched. */
  function decodeVariant(p, index, trees) {
    const treeIds = Object.keys(p.skillTrees ?? {});
    const specialized = Array.isArray(p.specializedSkills) ? p.specializedSkills.filter(Boolean) : null;
    const picked = [];
    const unmatched = [];
    const warnings = [];
    if (specialized) {
      for (const ability of specialized) {
        const id = matchSkillTree(ability, treeIds, trees);
        if (id && !picked.includes(id)) picked.push(id);
        else if (!id) unmatched.push(ability);
      }
    } else {
      picked.push(...treeIds);
      warnings.push('This variant does not list its specialized skills — every tree in the planner is included.');
    }
    const skillTrees = {};
    for (const id of picked) {
      const history = allocated(p.skillTrees[id]);
      skillTrees[id] = { history, position: history.length };
    }
    const passives = allocated(p.passives);
    return {
      index,
      name: String(p.name ?? '').trim() || `Variant ${index + 1}`,
      level: Number.isFinite(p.level) ? p.level : null,
      hidden: !!p.hidden,
      classId: p.class,
      masteryId: Number.isInteger(p.mastery) ? p.mastery : 0,
      unmatched,
      warnings,
      build: {
        class: p.class,
        mastery: Number.isInteger(p.mastery) ? p.mastery : 0,
        ...(Number.isInteger(p.level) && p.level > 0 ? { level: p.level } : {}), // → how many skill slots are open
        passives: { history: passives, position: passives.length },
        skillTrees,
      },
    };
  }

  /**
   * @param {object|string} response — the /profiles/le/<id> JSON
   * @param {object} trees           — db.skills (tree names for skill matching)
   * @returns {{ id, name, author, activeProfile, variants: object[] }}
   * @throws {Error} with a message fit for the player
   */
  function decodePlanner(response, trees) {
    const r = typeof response === 'string' ? JSON.parse(response) : response;
    if (!r || typeof r !== 'object') throw new Error('Maxroll sent an empty answer.');
    if (r.game && r.game !== 'le') throw new Error(`That planner is for another game (“${r.game}”), not Last Epoch.`);
    let data = r.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { throw new Error('Maxroll sent planner data this app cannot read.'); }
    }
    const profiles = Array.isArray(data?.profiles) ? data.profiles : null;
    if (!profiles?.length) throw new Error('This planner has no variants.');
    const variants = profiles
      .map((p, i) => (p && typeof p === 'object' && p.passives ? decodeVariant(p, i, trees) : null))
      .filter(Boolean);
    if (!variants.length) throw new Error('None of this planner’s variants has a passive tree.');
    return {
      id: r.id ?? null,
      date: typeof r.date === 'string' ? r.date : null, // last save — a changed date = the guide was edited
      name: String(r.name ?? '').trim() || 'Maxroll build',
      author: r.user?.username ?? null,
      activeProfile: Number.isInteger(data.activeProfile) ? data.activeProfile : 0,
      variants,
    };
  }

  /** "#N" (1-based, hidden variants skipped, like Maxroll's own tabs) → variant index, or null. */
  function visibleVariantIndex(variants, n) {
    if (!n) return null;
    const visible = variants.filter(v => !v.hidden);
    return visible[n - 1]?.index ?? null;
  }

  const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

  /**
   * Guide update: which of the planner's variants is each of the build's phases now?
   * `sourcePhases` = what was stored at import ([{ variant, name }], the variant's
   * index and name then). Match by the stored name first (the author may have
   * reordered variants), else the stored index (they may have renamed it). Builds
   * imported before that was stored fall back to the phase's own name.
   * @returns {(number|null)[]} a variant index per phase, null = not found
   */
  function mapPhasesToVariants(sourcePhases, phases, variants) {
    return phases.map((phase, i) => {
      const stored = Array.isArray(sourcePhases) ? sourcePhases[i] : null;
      if (stored) {
        const byName = variants.filter(v => sameName(v.name, stored.name));
        const hit = byName.find(v => v.index === stored.variant) ?? byName[0] ?? variants.find(v => v.index === stored.variant);
        return hit ? hit.index : null;
      }
      return variants.find(v => sameName(v.name, phase.name))?.index ?? null;
    });
  }

  // ─── Where each phase came from (build.source) ────────────────────────────
  //
  // A build can mix guides: e.g. the leveling phases from one planner and the endgame
  // from another, plus phases pasted as export codes. `source` records, per phase:
  //   { maxroll: id, variant, name }  a planner variant (index + name at import)
  //   { maxroll: id }                 a planner, variant unknown (matched by the phase's name)
  //   null                            pasted codes: never checked for updates
  // Stored shape: { maxroll, date?, dates: { [id]: date }, phases: [entry…] }. `maxroll` and
  // `date` are the first planner's, so "was this loaded from Maxroll?" stays source.maxroll.
  // Builds from before mixing ({ maxroll, date, phases?: [{ variant, name }] }) read the same.

  const DATE_MAX = 40;
  const NAME_MAX = 80;
  const validId = (id) => typeof id === 'string' && ID_RE.test(id);

  /**
   * A stored source → { phases: entry[] (one per phase), dates: { id: date }, planners: [id] }.
   * Anything invalid reads as null (codes), so a bad file never breaks the app.
   */
  function guideSources(source, phaseCount) {
    const n = Math.max(0, phaseCount | 0);
    const empty = { phases: Array(n).fill(null), dates: {}, planners: [] };
    if (!source || typeof source !== 'object') return empty;
    const main = validId(source.maxroll) ? source.maxroll : null;
    const stored = Array.isArray(source.phases) && source.phases.length === n ? source.phases : null;
    if (!stored && !main) return empty;
    const entry = (e) => {
      if (!e || typeof e !== 'object') return null;
      const id = e.maxroll === undefined ? main : e.maxroll; // pre-mixing entries have no id of their own
      if (!validId(id)) return null;
      return Number.isInteger(e.variant) && e.variant >= 0 && typeof e.name === 'string'
        ? { maxroll: id, variant: e.variant, name: e.name.slice(0, NAME_MAX) }
        : { maxroll: id };
    };
    const phases = stored ? stored.map(entry) : Array(n).fill(null).map(() => ({ maxroll: main }));
    const planners = [...new Set(phases.filter(Boolean).map(e => e.maxroll))];
    const dates = {};
    const known = source.dates && typeof source.dates === 'object' ? source.dates : {};
    for (const id of planners) {
      const d = known[id] ?? (id === main ? source.date : undefined);
      if (typeof d === 'string' && d.length < DATE_MAX) dates[id] = d;
    }
    return { phases, dates, planners };
  }

  /** Per-phase entries (+ each planner's date) → the stored source, or null when no phase is from Maxroll. */
  function makeSource(entries, dates = {}) {
    const phases = (entries ?? []).map(e => (e && validId(e.maxroll)
      ? (Number.isInteger(e.variant) && e.variant >= 0 && typeof e.name === 'string'
        ? { maxroll: e.maxroll, variant: e.variant, name: e.name.slice(0, NAME_MAX) }
        : { maxroll: e.maxroll })
      : null));
    const planners = [...new Set(phases.filter(Boolean).map(e => e.maxroll))];
    if (!planners.length) return null;
    const kept = {};
    for (const id of planners) if (typeof dates[id] === 'string' && dates[id].length < DATE_MAX) kept[id] = dates[id];
    return { maxroll: planners[0], ...(kept[planners[0]] ? { date: kept[planners[0]] } : {}), dates: kept, phases };
  }

  /**
   * Guide update across planners: per phase, the variant index in its planner now,
   * or null (pasted codes, or its variant is gone). `planners` = { [id]: decoded planner }.
   */
  function mapGuidePhases(entries, phases, planners) {
    return phases.map((phase, i) => {
      const e = entries[i];
      const variants = e && planners[e.maxroll]?.variants;
      if (!variants) return null;
      return mapPhasesToVariants(e.name != null ? [e] : undefined, [phase], variants)[0];
    });
  }

  /** One string per set of planner versions: "Keep my version" remembers it (one planner = its date). */
  function guideSignature(ids, dates) {
    return ids.length === 1 ? String(dates[ids[0]] ?? '') : ids.map(id => `${id}@${dates[id] ?? ''}`).join(' ');
  }

  return {
    API_BASE, parseMaxrollLink, matchSkillTree, decodePlanner, visibleVariantIndex, mapPhasesToVariants,
    guideSources, makeSource, mapGuidePhases, guideSignature,
  };
}));
