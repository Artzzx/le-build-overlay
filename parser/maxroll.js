/**
 * parser/maxroll.js
 * ──────────────────
 * Parses raw Maxroll planner JSON export into the normalized build format
 * defined in build-schema.js.
 *
 * ─── Input Format (raw Maxroll JSON) ─────────────────────────────────────────
 *
 * {
 *   "passives": {
 *     "history": [1,1,1,1,1,6,6,6,6,6,...],
 *     "position": 113          ← total passive points (= history.length)
 *   },
 *   "class": 3,               ← integer classId (maps to classes.json)
 *   "mastery": 2,             ← integer masteryId (maps to classes.json)
 *   "skillTrees": {
 *     "fl44": {"history": [4,4,14,11,12,...], "position": 26},
 *     "fl22": {"history": [...], "position": 20},
 *     "fl33": {"history": [...], "position": 18},
 *     "fl55": {"history": [...], "position": 16},
 *     "fl11": {"history": [...], "position": 20}
 *   }
 * }
 *
 * Note: `position` = total tree points allocated = history.length.
 * The skillTree keys (fl44, fl22, etc.) encode skill identity — see CLAUDE.md.
 *
 * ─── Output Format ────────────────────────────────────────────────────────────
 * See build-schema.js for full normalized build format.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   const { parseBuild, loadBuildFromFile, saveBuild } = require('./maxroll');
 *
 *   // From string (e.g., user pasted JSON):
 *   const build = parseBuild(rawJsonString, skillsDb, classesDb, 'My Build');
 *
 *   // From file:
 *   const build = loadBuildFromFile('./config/my-build.json', skillsDb, classesDb);
 *
 *   // Persist:
 *   saveBuild(build, './config/build.json');
 *
 * ─── API ─────────────────────────────────────────────────────────────────────
 *
 *   parseBuild(rawJsonOrString, skillsDb, classesDb, buildName?)  → normalizedBuild
 *   loadBuildFromFile(filePath, skillsDb, classesDb)              → normalizedBuild
 *   saveBuild(normalizedBuild, filePath)                          → void
 *   advanceTrack(build, trackIndex)                               → updatedBuild
 *   undoTrack(build, trackIndex)                                  → updatedBuild
 *   getCurrentNode(build, trackIndex, db)                         → nodeInfo | null
 *   getUpcoming(build, trackIndex, db, count)                     → nodeInfo[]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { validateBuild, groupHistory, initializeBuild } = require('./build-schema');

// ─── Multi-line merge ─────────────────────────────────────────────────────────

/**
 * Merge newline-delimited Maxroll JSON blobs into a single complete object.
 *
 * Maxroll only lets you copy one section at a time, so users paste the build
 * as several separate JSON lines:
 *   Line 1: {"passives":{...},"class":4,"mastery":2}
 *   Line 2: {"skillTrees":{"htsk5":{...}}}
 *   Line 3: {"skillTrees":{"smbmb":{...}}}
 *   ...
 *
 * This function parses each non-empty line and merges all skillTrees entries
 * into one canonical Maxroll JSON object that parseBuild() can handle normally.
 *
 * Also accepts a single-object JSON string (legacy / future Maxroll format).
 *
 * @param {string} text - raw pasted text, one JSON object per line
 * @returns {object}    - merged single Maxroll JSON object
 * @throws {Error}      - if any line is invalid JSON or structure is unrecognizable
 */
function mergeRawLines(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    throw new Error('Input is empty');
  }

  // Fast path: single valid JSON blob (standard format)
  if (lines.length === 1) {
    try {
      return JSON.parse(lines[0]);
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }
  }

  // Multi-line path: parse each line and merge
  const merged = { skillTrees: {} };

  lines.forEach((line, idx) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`Line ${idx + 1} is not valid JSON: ${e.message}`);
    }

    // Passives / class / mastery block
    if (obj.passives !== undefined) {
      merged.passives = obj.passives;
    }
    if (obj.class !== undefined) {
      merged.class = obj.class;
    }
    if (obj.mastery !== undefined) {
      merged.mastery = obj.mastery;
    }

    // Skill tree block — merge each key into the shared skillTrees map
    if (obj.skillTrees && typeof obj.skillTrees === 'object') {
      Object.assign(merged.skillTrees, obj.skillTrees);
    }
  });

  return merged;
}

// ─── Core parser ─────────────────────────────────────────────────────────────

/**
 * Parse a raw Maxroll JSON export into normalized build format.
 *
 * Accepts either:
 *   • A single JSON string/object (standard Maxroll format)
 *   • A multi-line string where each line is a separate Maxroll JSON blob
 *     (one line for passives/class/mastery, one line per skill — the format
 *      produced when copying from Maxroll one section at a time)
 *
 * @param {string|object} rawInput - Maxroll JSON as string or already-parsed object
 * @param {object} skillsDb       - Contents of db/data/skills.json (used to resolve skill names)
 * @param {object} classesDb      - Contents of db/data/classes.json (used to resolve class names)
 * @param {string} [buildName]    - Optional human name for the build
 * @returns {object}              - Normalized build (see build-schema.js)
 * @throws {Error}                - If input is invalid or missing required fields
 */
function parseBuild(rawInput, skillsDb, classesDb, buildName = 'Imported Build') {
  // 1. Parse / merge input
  let raw;
  if (typeof rawInput === 'string') {
    raw = mergeRawLines(rawInput);
  } else if (rawInput && typeof rawInput === 'object') {
    raw = rawInput;
  } else {
    throw new Error('Input must be a JSON string or parsed object');
  }

  // 2. Validate required fields
  if (!raw.passives || !Array.isArray(raw.passives.history)) {
    throw new Error('Missing passives.history in Maxroll JSON');
  }
  if (typeof raw.class !== 'number') {
    throw new Error('Missing or invalid "class" field in Maxroll JSON');
  }
  if (typeof raw.mastery !== 'number') {
    throw new Error('Missing or invalid "mastery" field in Maxroll JSON');
  }
  if (!raw.skillTrees || typeof raw.skillTrees !== 'object') {
    throw new Error('Missing skillTrees in Maxroll JSON');
  }

  // 3. Build passive track
  const passiveTrack = {
    type: 'passive',
    label: resolveClassName(raw.class, raw.mastery, classesDb) + ' Passives',
    history: raw.passives.history,
    totalSteps: raw.passives.history.length,
    currentStep: 0,
  };

  // 4. Build skill tracks (in the order they appear in Maxroll JSON)
  const skillTracks = Object.entries(raw.skillTrees).map(([skillKey, treeData]) => {
    if (!Array.isArray(treeData.history)) {
      throw new Error(`skillTrees.${skillKey}.history is missing or not an array`);
    }
    const skillName = resolveSkillName(skillKey, skillsDb);
    return {
      type: 'skill',
      skillKey,
      label: skillName,
      history: treeData.history,
      totalSteps: treeData.history.length,
      currentStep: 0,
    };
  });

  // 5. Assemble and validate build
  const build = {
    name: buildName,
    classId: raw.class,
    masteryId: raw.mastery,
    tracks: [passiveTrack, ...skillTracks],
  };

  return validateBuild(initializeBuild(build));
}

// ─── Name resolution helpers ──────────────────────────────────────────────────

/**
 * Resolve a classId + masteryId to a display string like "Sentinel — Void Knight".
 * Falls back gracefully if classes.json is not loaded yet.
 *
 * @param {number} classId
 * @param {number} masteryId
 * @param {object|null} classesDb - contents of db/data/classes.json, or null
 * @returns {string}
 */
function resolveClassName(classId, masteryId, classesDb) {
  if (!classesDb) return `Class ${classId}`;
  const className = classesDb.classes?.[classId] ?? `Class ${classId}`;
  const masteryName = classesDb.masteries?.[masteryId]?.name ?? `Mastery ${masteryId}`;
  return `${className} — ${masteryName}`;
}

/**
 * Resolve a skillKey (e.g. "fl44") to a human-readable skill name.
 * Falls back to the key itself if skills.json is not loaded or key is unknown.
 *
 * IMPORTANT: This mapping depends on db/data/skills.json being populated
 * by the extractor scripts. During development before extraction is done,
 * this will always return the fallback.
 *
 * @param {string} skillKey - e.g. "fl44"
 * @param {object|null} skillsDb - contents of db/data/skills.json, or null
 * @returns {string}
 */
function resolveSkillName(skillKey, skillsDb) {
  if (!skillsDb) return skillKey;
  return skillsDb[skillKey]?.name ?? skillKey;
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

/**
 * Load and parse a Maxroll JSON file from disk.
 *
 * @param {string} filePath - path to the raw Maxroll JSON file
 * @param {object} skillsDb
 * @param {object} classesDb
 * @returns {object} normalized build
 */
function loadBuildFromFile(filePath, skillsDb, classesDb) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath, '.json');
  return parseBuild(raw, skillsDb, classesDb, fileName);
}

/**
 * Write a normalized build object to disk as JSON.
 * Used both for saving new builds (from config window) and
 * for persisting currentStep changes (from hotkey advance/undo).
 *
 * @param {object} build - normalized build
 * @param {string} filePath - output path (typically config/build.json)
 */
function saveBuild(build, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(build, null, 2), 'utf-8');
}

// ─── Track advancement ────────────────────────────────────────────────────────

/**
 * Advance one point on the given track (advances one flat history entry).
 * Returns a NEW build object (immutable update — don't mutate in place).
 *
 * currentStep is a flat count of history entries applied (0 = not started,
 * history.length = fully completed). Each press allocates exactly one point.
 *
 * Does nothing if track is already completed.
 *
 * @param {object} build
 * @param {number} trackIndex - 0-based index into build.tracks
 * @returns {object} updated build (new reference)
 */
function advanceTrack(build, trackIndex) {
  const track = build.tracks[trackIndex];
  if (!track) return build;

  if (track.currentStep >= track.history.length) {
    // Already completed — no-op
    return build;
  }

  return {
    ...build,
    tracks: build.tracks.map((t, i) =>
      i === trackIndex ? { ...t, currentStep: t.currentStep + 1 } : t
    ),
  };
}

/**
 * Undo one step on the given track (go back).
 * Does nothing if track is at step 0.
 *
 * @param {object} build
 * @param {number} trackIndex - 0-based index into build.tracks
 * @returns {object} updated build (new reference)
 */
function undoTrack(build, trackIndex) {
  const track = build.tracks[trackIndex];
  if (!track) return build;
  if (track.currentStep <= 0) return build;

  return {
    ...build,
    tracks: build.tracks.map((t, i) =>
      i === trackIndex ? { ...t, currentStep: t.currentStep - 1 } : t
    ),
  };
}

// ─── DB lookups ───────────────────────────────────────────────────────────────

/**
 * Returns node info for the CURRENT step of the given track.
 *
 * currentStep is a flat history-entry count. This function finds which group
 * contains the current position and how many points within it are allocated.
 *
 * @param {object} build
 * @param {number} trackIndex
 * @param {object} db - { passives, skills } from build-db.js
 * @returns {{ nodeId, name, maxPoints, count, pointsSoFar } | null}
 *   null if track is completed or db is unavailable
 */
function getCurrentNode(build, trackIndex, db) {
  const track = build.tracks[trackIndex];
  if (!track) return null;

  const groups = groupHistory(track.history);
  const group = groups.find(
    g => track.currentStep >= g.startIdx && track.currentStep < g.startIdx + g.count
  );
  if (!group) return null; // track completed (currentStep >= history.length)

  const pointsSoFar = track.currentStep - group.startIdx;
  const node = lookupNode(group.nodeId, track, db, build);
  return node ? { ...node, count: group.count, pointsSoFar } : null;
}

/**
 * Returns the next N upcoming group nodes after the current position.
 *
 * @param {object} build
 * @param {number} trackIndex
 * @param {object} db
 * @param {number} count - how many upcoming groups to return
 * @returns {object[]} array of node info objects (may be shorter than count at end of track)
 */
function getUpcoming(build, trackIndex, db, count = 3) {
  const track = build.tracks[trackIndex];
  if (!track) return [];

  const groups = groupHistory(track.history);
  const currentGroupIdx = groups.findIndex(
    g => track.currentStep >= g.startIdx && track.currentStep < g.startIdx + g.count
  );
  const startFrom = currentGroupIdx === -1 ? 0 : currentGroupIdx + 1;

  const results = [];
  for (let i = startFrom; i < groups.length && results.length < count; i++) {
    const group = groups[i];
    const node = lookupNode(group.nodeId, track, db, build);
    if (node) results.push({ ...node, count: group.count });
  }

  return results;
}

/**
 * Resolve a nodeId to its full info from the appropriate DB table.
 *
 * Passive lookup: uses build.classId → passiveTreeByClass → treeID → nodes[nodeId]
 * Skill lookup:   uses track.skillKey (= treeID) → nodes[nodeId]
 *
 * @param {number} nodeId
 * @param {object} track - the track object
 * @param {object} db    - { passives, skills, classes } from build-db.js
 * @param {object} build - full build (needed for classId when looking up passives)
 * @returns {object|null}
 */
function lookupNode(nodeId, track, db, build) {
  if (!db) return null;
  const key = String(nodeId);
  if (track.type === 'passive') {
    // passives.json is keyed by treeID, not flat nodeId
    // resolve: classId → treeID via classes.passiveTreeByClass
    const classId = String(build?.classId ?? 0);
    const treeId  = db.classes?.passiveTreeByClass?.[classId];
    return treeId ? (db.passives?.[treeId]?.nodes?.[key] ?? null) : null;
  } else {
    // skills.json key = treeID = Maxroll skillKey directly
    return db.skills?.[track.skillKey]?.nodes?.[key] ?? null;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  parseBuild,
  mergeRawLines,
  loadBuildFromFile,
  saveBuild,
  advanceTrack,
  undoTrack,
  getCurrentNode,
  getUpcoming,
  resolveClassName,
  resolveSkillName,
};
