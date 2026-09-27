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
      build: { class: p.class, mastery: Number.isInteger(p.mastery) ? p.mastery : 0, passives: { history: passives, position: passives.length }, skillTrees },
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

  return { API_BASE, parseMaxrollLink, matchSkillTree, decodePlanner, visibleVariantIndex, mapPhasesToVariants };
}));
