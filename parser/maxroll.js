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
 *   "class": 2,               ← integer classId, the game's enum (0 Primalist, 1 Mage, 2 Sentinel, 3 Acolyte, 4 Rogue)
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
 * The skillTree keys are treeIDs from the game data (e.g. "fl44" = Flay,
 * "es6ai" = Erasing Strike) — no mapping table needed.
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
 *   parseLoadout(phaseInputs, skillsDb, classesDb, loadoutName?)  → loadout
 *   saveBuild(normalizedBuild, filePath)                          → void
 *
 * Advancing, undoing and node lookup operate on the loadout at runtime and live
 * in shared/tree-utils.js (used by the overlay renderer).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { validateBuild, validateLoadout, initializeBuild } = require('./build-schema');

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
 * @param {object} skillsDb       - Indexed tree map from db/build-db.js all().skills (resolves skill names)
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
  // Mastery 0 = no mastery chosen yet (leveling as the plain class).
  if (!masteryId) return className;
  // Maxroll uses per-class relative mastery IDs (1–3), not global sequential IDs.
  // masteriesByClass[classId][masteryId] is the correct lookup.
  const masteryName =
    classesDb.masteriesByClass?.[classId]?.[masteryId] ?? `Mastery ${masteryId}`;
  return `${className} — ${masteryName}`;
}

/**
 * Resolve a skillKey (e.g. "fl44") to a human-readable skill name.
 * Falls back to the key itself if skills.json is not loaded or key is unknown.
 *
 * Uses the indexed tree map from db/build-db.js; unknown keys fall back to the key.
 *
 * @param {string} skillKey - e.g. "fl44"
 * @param {object|null} skillsDb - indexed tree map (treeID → { name, nodes }), or null
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

// ─── Multi-phase loadout parser ───────────────────────────────────────────────

/**
 * Parse an array of phase inputs (each with a name + raw Maxroll JSON) into a
 * multi-phase loadout object suitable for saving to config/build.json.
 *
 * All phases must be the same class — throws otherwise. The mastery may differ
 * per phase (e.g. leveling at mastery 0, the plain class, then Bladedancer):
 * each phase keeps its own masteryId; loadout.masteryId is the highest one.
 *
 * @param {Array<{ name: string, json: string }>} phaseInputs
 * @param {object} skillsDb  - Indexed tree map (treeID → { name, nodes })
 * @param {object} classesDb - Contents of db/data/classes.json
 * @param {string} [loadoutName] - Human-readable loadout name
 * @returns {object} Validated loadout ({ name, classId, masteryId, currentPhase, phases })
 * @throws {Error} If any phase is invalid or the classes don't match
 */
function parseLoadout(phaseInputs, skillsDb, classesDb, loadoutName = 'Imported Loadout') {
  if (!Array.isArray(phaseInputs) || phaseInputs.length === 0) {
    throw new Error('phaseInputs must be a non-empty array of { name, json } objects');
  }

  let baseClassId = null;
  const className = (id) => classesDb?.classes?.[id] ?? `class ${id}`;

  const phases = phaseInputs.map(({ name: phaseName, json }, idx) => {
    const build = parseBuild(json, skillsDb, classesDb, phaseName || `Phase ${idx + 1}`);

    if (baseClassId === null) {
      baseClassId = build.classId;
    } else if (build.classId !== baseClassId) {
      throw new Error(
        `Phase ${idx + 1} is a ${className(build.classId)}, phase 1 is a ${className(baseClassId)} — ` +
        `every phase must be the same class.`
      );
    }

    return { name: phaseName || `Phase ${idx + 1}`, masteryId: build.masteryId, tracks: build.tracks };
  });

  const loadout = {
    name: loadoutName,
    classId:   baseClassId,
    masteryId: Math.max(0, ...phases.map(p => p.masteryId)),
    currentPhase: 0,
    phases,
  };

  return validateLoadout(loadout);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  parseBuild,
  parseLoadout,
  mergeRawLines,
  loadBuildFromFile,
  saveBuild,
  resolveClassName,
  resolveSkillName,
};
