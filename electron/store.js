/**
 * electron/store.js
 * ──────────────────
 * Persistent runtime state for the main process:
 *
 *   <userData>/profiles/<id>.json ← one per character: loadout + progress
 *   <userData>/settings.json      ← window bounds, display, hotkeys, active profile
 *   <userData>/saves/*.json       ← saved loadout templates (raw pasted inputs)
 *
 * Before profiles there was a single <userData>/build.json: migrateProfiles()
 * turns it into the first profile and renames it build.json.migrated.
 *
 * <userData> is Electron's per-user app data dir (e.g. %APPDATA%/le-build-overlay)
 * so a packaged app never writes into its install folder.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't corrupt
 * the user's progress. Unreadable JSON is moved aside as *.corrupt-<ts> and the
 * caller gets its fallback instead of a crash.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = Object.freeze({
  window: { x: null, y: null, width: 1280, height: 860, maximized: false },
  // Mini mode keeps its own bounds; x/y null = top-right of the display on first use.
  compactWindow: { x: null, y: null, width: 340, height: 460 },
  display: {
    uiScale: 1,
    alwaysOnTop: false,       // full mode only — mini mode is always on top
    mode: 'full',             // 'full' | 'compact' (mini mode)
    opacity: 0.92,            // mini mode only
    sound: true,              // audio cue when a global hotkey lands
    volume: 0.6,
  },
  hotkeys: {
    enabled: true,
    hotkeyMode: 'direct',     // 'direct' | 'latch'
    laneKeys: 'fkeys',        // 'fkeys' | 'digits' | 'numpad' — see shared/hotkey-scheme.js
    latchKey: '`',
    advanceModifier: '',      // '' | 'Alt' | 'Ctrl' | 'Shift'
    undoModifier: 'Shift',
    toggle: 'F8',             // show / hide the window
    phaseNextKey: 'F9',       // F7 left free: a slip off lane 6 must not switch phase
    phasePrevKey: 'Shift+F9',
  },
  updates: {
    checkMaxroll: true,       // on start (max once a day): has the build's Maxroll guide changed?
    checkApp: true,           // new app versions (GitHub Releases): downloaded in the background, installed on quit
  },
  lastDataVersion: null,      // owned by main: the game-data version the player last saw (db/data/version.json)
  activeProfile: null,        // owned by main (profiles:switch) — see createStore().profiles
});

const UI_SCALE_MIN = 0.8;
const UI_SCALE_MAX = 1.6;
const MODIFIERS = ['', 'Alt', 'Ctrl', 'Shift'];
const LANE_KEYS = ['fkeys', 'digits', 'numpad'];
const OPACITY_MIN = 0.35;
const FULL_MIN = { width: 420, height: 480 };    // smallest full window
const COMPACT_MIN = { width: 260, height: 180 }; // smallest mini window

/**
 * The per-user data folder, pinned to the name the app has always used. Electron
 * derives its default from productName ("LE Build Planner" since packaging); letting
 * it change would silently hide every existing character, setting and template.
 */
const USER_DATA_DIRNAME = 'le-build-overlay';
const userDataDir = (appDataPath) => path.join(appDataPath, USER_DATA_DIRNAME);

const PROFILE_ID_RE = /^p-[a-z0-9]{4,32}$/;

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const str = (v, fallback) => (typeof v === 'string' ? v : fallback);
const clamp = (v, lo, hi, fallback) => Math.min(hi, Math.max(lo, num(v, fallback)));

/**
 * Merge a possibly partial / outdated / hand-edited settings object over the
 * defaults, dropping unknown keys and fixing out-of-range values.
 */
function mergeSettings(raw) {
  const d = DEFAULT_SETTINGS;
  const w = raw?.window ?? {};
  const disp = raw?.display ?? {};
  const hk = raw?.hotkeys ?? {};
  const cw = raw?.compactWindow ?? {};
  return {
    window: {
      x: Number.isFinite(w.x) ? w.x : null,
      y: Number.isFinite(w.y) ? w.y : null,
      width: Math.max(FULL_MIN.width, num(w.width, d.window.width)),
      height: Math.max(FULL_MIN.height, num(w.height, d.window.height)),
      maximized: w.maximized === true,
    },
    compactWindow: {
      x: Number.isFinite(cw.x) ? cw.x : null,
      y: Number.isFinite(cw.y) ? cw.y : null,
      width: Math.max(COMPACT_MIN.width, num(cw.width, d.compactWindow.width)),
      height: Math.max(COMPACT_MIN.height, num(cw.height, d.compactWindow.height)),
    },
    display: {
      uiScale: clamp(disp.uiScale, UI_SCALE_MIN, UI_SCALE_MAX, d.display.uiScale),
      alwaysOnTop: disp.alwaysOnTop === true,
      mode: disp.mode === 'compact' ? 'compact' : 'full',
      opacity: clamp(disp.opacity, OPACITY_MIN, 1, d.display.opacity),
      sound: disp.sound !== false,
      volume: clamp(disp.volume, 0, 1, d.display.volume),
    },
    hotkeys: {
      enabled: hk.enabled !== false,
      hotkeyMode: hk.hotkeyMode === 'latch' ? 'latch' : 'direct',
      // Settings saved before lane keys existed used bare digits (and F1 for show/hide,
      // which would now collide with lane 1) — keep them on digits. Fresh installs get F-keys.
      laneKeys: LANE_KEYS.includes(hk.laneKeys) ? hk.laneKeys : (raw?.hotkeys ? 'digits' : d.hotkeys.laneKeys),
      latchKey: str(hk.latchKey, d.hotkeys.latchKey),
      advanceModifier: MODIFIERS.includes(hk.advanceModifier) ? hk.advanceModifier : d.hotkeys.advanceModifier,
      undoModifier: MODIFIERS.includes(hk.undoModifier) ? hk.undoModifier : d.hotkeys.undoModifier,
      toggle: str(hk.toggle, d.hotkeys.toggle),
      phaseNextKey: str(hk.phaseNextKey, d.hotkeys.phaseNextKey),
      phasePrevKey: str(hk.phasePrevKey, d.hotkeys.phasePrevKey),
    },
    updates: {
      checkMaxroll: raw?.updates?.checkMaxroll !== false,
      checkApp: raw?.updates?.checkApp !== false,
    },
    lastDataVersion: typeof raw?.lastDataVersion === 'string' && raw.lastDataVersion.length < 100 ? raw.lastDataVersion : null,
    activeProfile: PROFILE_ID_RE.test(raw?.activeProfile ?? '') ? raw.activeProfile : null,
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * @param {{ dir: string, log?: Console }} opts
 *   dir — where state lives (app.getPath('userData'))
 */
function createStore({ dir, log = console }) {
  const paths = {
    dir,
    build: path.join(dir, 'build.json'), // pre-profiles; migrated by migrateProfiles()
    settings: path.join(dir, 'settings.json'),
    saves: path.join(dir, 'saves'),
    profiles: path.join(dir, 'profiles'),
  };

  function readJson(file, fallback) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return fallback; // missing is normal
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      const aside = `${file}.corrupt-${Date.now()}`;
      log.error(`[store] ${path.basename(file)} is not valid JSON (${err.message}); moved to ${aside}`);
      try { fs.renameSync(file, aside); } catch { /* best effort */ }
      return fallback;
    }
  }

  function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }

  // ─── Profiles (one per character: its loadout + progress) ───────────────────

  const profileName = (name, fallback = 'Character') => String(name ?? '').trim().slice(0, 40) || fallback;
  // Time-ordered ids (strictly increasing, even within one millisecond) so ties sort by creation.
  let lastIdTime = 0;
  const newProfileId = () => {
    lastIdTime = Math.max(Date.now(), lastIdTime + 1);
    return `p-${lastIdTime.toString(36).padStart(9, '0')}${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
  };

  function profilePath(id) {
    if (!PROFILE_ID_RE.test(String(id))) throw new Error('Invalid profile id');
    return path.join(paths.profiles, `${id}.json`);
  }

  function readProfile(id) {
    const p = readJson(profilePath(id), null);
    return p && typeof p === 'object' && p.id === id ? p : null;
  }

  /** Every profile's summary (no build bodies beyond name/class), oldest first. */
  function listProfiles() {
    if (!fs.existsSync(paths.profiles)) return [];
    const out = [];
    for (const f of fs.readdirSync(paths.profiles)) {
      const m = /^(p-[a-z0-9]+)\.json$/.exec(f);
      const p = m && PROFILE_ID_RE.test(m[1]) ? readProfile(m[1]) : null;
      if (!p) continue;
      out.push({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt ?? null,
        updatedAt: p.updatedAt ?? null,
        buildName: p.build?.name ?? null,
        classId: Number.isInteger(p.build?.classId) ? p.build.classId : null,
        masteryId: Number.isInteger(p.build?.masteryId) ? p.build.masteryId : null,
      });
    }
    return out.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id));
  }

  /** "Rogue" → "Rogue 2" when a character already has that name. */
  function uniqueName(base) {
    const taken = new Set(listProfiles().map(p => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`.slice(0, 40);
  }

  function createProfile({ name, build = null } = {}) {
    const now = new Date().toISOString();
    const profile = { version: 1, id: newProfileId(), name: uniqueName(profileName(name)), createdAt: now, updatedAt: now, build };
    writeJson(profilePath(profile.id), profile);
    return profile;
  }

  /** Merge fields into a profile (name, build, updateCheck …) and persist it. */
  function updateProfile(id, patch) {
    const p = readProfile(id);
    if (!p) throw new Error('Profile not found');
    const next = { ...p, ...patch, id: p.id, version: 1, updatedAt: new Date().toISOString() };
    if ('name' in patch) next.name = profileName(patch.name, p.name);
    writeJson(profilePath(id), next);
    return next;
  }

  const saveProfileBuild = (id, build) => updateProfile(id, { build });

  function deleteProfile(id) {
    if (listProfiles().length <= 1) throw new Error('Can’t delete the only character.');
    const file = profilePath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  /**
   * The pre-profiles build.json becomes the first profile (once). Returns its id or null.
   * @param {(build) => string} [nameFor] — the character's name (e.g. its class)
   */
  function migrateProfiles(nameFor = () => 'Character 1') {
    if (listProfiles().length || !fs.existsSync(paths.build)) return null;
    const build = readJson(paths.build, null); // unreadable → moved aside by readJson
    if (!fs.existsSync(paths.build)) return null;
    const profile = createProfile({ name: nameFor(build), build });
    fs.renameSync(paths.build, `${paths.build}.migrated`);
    return profile.id;
  }

  /**
   * The profile to open: `preferred` if it exists, else the oldest, else a new
   * empty "Character 1". Always returns a profile.
   */
  function resolveProfile(preferred) {
    const byId = preferred && PROFILE_ID_RE.test(preferred) ? readProfile(preferred) : null;
    if (byId) return byId;
    const first = listProfiles()[0];
    return (first && readProfile(first.id)) ?? createProfile({ name: 'Character 1' });
  }

  // ─── Settings ───────────────────────────────────────────────────────────────
  const loadSettings = () => mergeSettings(readJson(paths.settings, {}));
  const saveSettings = (s) => { const merged = mergeSettings(s); writeJson(paths.settings, merged); return merged; };

  // ─── Templates ──────────────────────────────────────────────────────────────
  function templatePath(filename) {
    return path.join(paths.saves, path.basename(String(filename))); // no traversal
  }

  function saveTemplate({ loadoutName, phases }) {
    const name = String(loadoutName || 'Unnamed loadout').slice(0, 60);
    const safe = name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    const filename = `${safe}_${Date.now()}.json`;
    writeJson(templatePath(filename), {
      version: 1,
      savedAt: new Date().toISOString(),
      loadoutName: name,
      phases: Array.isArray(phases) ? phases.map(p => ({ name: String(p?.name ?? ''), json: String(p?.json ?? '') })) : [],
    });
    return filename;
  }

  function listTemplates() {
    if (!fs.existsSync(paths.saves)) return [];
    const list = [];
    for (const filename of fs.readdirSync(paths.saves).filter(f => f.endsWith('.json'))) {
      const t = readJson(templatePath(filename), null);
      if (!t) continue;
      list.push({
        filename,
        loadoutName: t.loadoutName ?? filename,
        savedAt: t.savedAt ?? null,
        phaseCount: Array.isArray(t.phases) ? t.phases.length : 0,
      });
    }
    return list.sort((a, b) => String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')));
  }

  function loadTemplate(filename) {
    const t = readJson(templatePath(filename), null);
    if (!t) throw new Error('Template not found or unreadable');
    return t;
  }

  function deleteTemplate(filename) {
    const file = templatePath(filename);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  return {
    paths, readJson, writeJson,
    listProfiles, readProfile, createProfile, updateProfile, saveProfileBuild, deleteProfile, migrateProfiles, resolveProfile,
    loadSettings, saveSettings,
    saveTemplate, listTemplates, loadTemplate, deleteTemplate,
  };
}

module.exports = { createStore, mergeSettings, userDataDir, DEFAULT_SETTINGS, FULL_MIN, COMPACT_MIN };
