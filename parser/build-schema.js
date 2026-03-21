/**
 * parser/build-schema.js
 * ───────────────────────
 * Defines and validates the NORMALIZED BUILD format used internally throughout
 * the app. This is the format written to config/build.json and read by the overlay.
 *
 * This is NOT a third-party schema library — it's a lightweight plain-JS
 * validator that throws descriptive errors on bad data.
 *
 * ─── Normalized Build Schema ─────────────────────────────────────────────────
 *
 * {
 *   name:      string   — human-readable build name (user-provided)
 *   classId:   number   — e.g. 3 (maps to classes.json)
 *   masteryId: number   — e.g. 2 (maps to classes.json)
 *   tracks: [
 *     {
 *       type:        "passive" | "skill"
 *       label:       string     — display name (e.g. "Passives", "Erasing Strike")
 *       history:     number[]   — ordered nodeId allocation sequence
 *       totalSteps:  number     — length of history (used for progress display)
 *       currentStep: number     — 0-based index into grouped steps (persisted)
 *       skillKey?:   string     — only present when type === "skill" (e.g. "fl44")
 *     }
 *   ]
 * }
 *
 * ─── Grouped Steps (derived, not stored) ─────────────────────────────────────
 *
 * The flat history[] is collapsed into grouped steps for UI rendering:
 *
 *   groupHistory([6,6,6,6,4,4]) →
 *   [
 *     { nodeId: 6, count: 4, startIdx: 0 },
 *     { nodeId: 4, count: 2, startIdx: 4 },
 *   ]
 *
 * currentStep indexes into this grouped array, NOT into the raw history array.
 */

'use strict';

// ─── Validators ──────────────────────────────────────────────────────────────

/**
 * Validates a single track object.
 * Throws a descriptive Error if invalid.
 * @param {object} track
 * @param {number} index - position in tracks array (for error messages)
 */
function validateTrack(track, index) {
  if (!track || typeof track !== 'object') {
    throw new Error(`Track[${index}] must be an object`);
  }
  if (!['passive', 'skill'].includes(track.type)) {
    throw new Error(`Track[${index}].type must be "passive" or "skill", got: ${track.type}`);
  }
  if (typeof track.label !== 'string' || track.label.trim() === '') {
    throw new Error(`Track[${index}].label must be a non-empty string`);
  }
  if (!Array.isArray(track.history) || track.history.length === 0) {
    throw new Error(`Track[${index}].history must be a non-empty array of nodeIds`);
  }
  if (!track.history.every(id => typeof id === 'number' && Number.isInteger(id) && id >= 0)) {
    throw new Error(`Track[${index}].history must contain only non-negative integers`);
  }
  if (typeof track.totalSteps !== 'number' || track.totalSteps <= 0) {
    throw new Error(`Track[${index}].totalSteps must be a positive number`);
  }
  if (typeof track.currentStep !== 'number' || track.currentStep < 0) {
    throw new Error(`Track[${index}].currentStep must be a non-negative number`);
  }
  if (track.type === 'skill' && typeof track.skillKey !== 'string') {
    throw new Error(`Track[${index}] has type "skill" but missing or invalid skillKey`);
  }
}

/**
 * Validates a full normalized build object.
 * Throws a descriptive Error if invalid.
 * @param {object} build
 * @returns {object} the same build object (pass-through for chaining)
 */
function validateBuild(build) {
  if (!build || typeof build !== 'object') {
    throw new Error('Build must be a non-null object');
  }
  if (typeof build.name !== 'string') {
    throw new Error('build.name must be a string');
  }
  if (typeof build.classId !== 'number') {
    throw new Error('build.classId must be a number');
  }
  if (typeof build.masteryId !== 'number') {
    throw new Error('build.masteryId must be a number');
  }
  if (!Array.isArray(build.tracks) || build.tracks.length === 0) {
    throw new Error('build.tracks must be a non-empty array');
  }

  // Exactly one passive track, rest are skills
  const passiveTracks = build.tracks.filter(t => t.type === 'passive');
  if (passiveTracks.length !== 1) {
    throw new Error(`Expected exactly 1 passive track, found ${passiveTracks.length}`);
  }

  build.tracks.forEach((track, i) => validateTrack(track, i));

  return build;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Collapses a flat history array into grouped allocation steps.
 * Each group represents "allocate N points to nodeId".
 *
 * @param {number[]} history - raw flat history array from Maxroll
 * @returns {{ nodeId: number, count: number, startIdx: number }[]}
 *
 * @example
 * groupHistory([6,6,6,6,4,4,4]) →
 * [
 *   { nodeId: 6, count: 4, startIdx: 0 },
 *   { nodeId: 4, count: 3, startIdx: 4 },
 * ]
 */
function groupHistory(history) {
  const groups = [];
  let i = 0;
  while (i < history.length) {
    const nodeId = history[i];
    let count = 0;
    while (i < history.length && history[i] === nodeId) {
      count++;
      i++;
    }
    groups.push({ nodeId, count, startIdx: i - count });
  }
  return groups;
}

/**
 * Creates a fresh build object with all currentSteps reset to 0.
 * Useful when loading a new build from Maxroll.
 * @param {object} build - partially constructed build (no currentStep required)
 * @returns {object} build with currentStep: 0 on every track
 */
function initializeBuild(build) {
  return {
    ...build,
    tracks: build.tracks.map(track => ({ ...track, currentStep: 0 })),
  };
}

// ─── Empty build template ─────────────────────────────────────────────────────

/**
 * Returns a valid empty build skeleton (useful for testing or as a fallback).
 * @returns {object}
 */
function emptyBuild() {
  return {
    name: 'Unnamed Build',
    classId: 0,
    masteryId: 0,
    tracks: [],
  };
}

module.exports = {
  validateBuild,
  validateTrack,
  groupHistory,
  initializeBuild,
  emptyBuild,
};
