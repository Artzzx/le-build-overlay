/**
 * electron/store.js
 * ──────────────────
 * Persistent runtime state for the main process:
 *
 *   <userData>/build.json     ← live loadout + progress
 *   <userData>/settings.json  ← window bounds, display, hotkeys
 *   <userData>/saves/*.json   ← saved loadout templates (raw pasted inputs)
 *
 * <userData> is Electron's per-user app data dir (e.g. %APPDATA%/le-build-overlay)
 * so a packaged app never writes into its install folder. Older versions kept
 * these files in <repo>/config/ — migrateLegacy() copies them over once.
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
});

const UI_SCALE_MIN = 0.8;
const UI_SCALE_MAX = 1.6;
const MODIFIERS = ['', 'Alt', 'Ctrl', 'Shift'];
const LANE_KEYS = ['fkeys', 'digits', 'numpad'];
const OPACITY_MIN = 0.35;
const FULL_MIN = { width: 420, height: 480 };    // smallest full window
const COMPACT_MIN = { width: 260, height: 180 }; // smallest mini window

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
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * @param {{ dir: string, legacyDir?: string, log?: Console }} opts
 *   dir       — where state lives (app.getPath('userData'))
 *   legacyDir — old <repo>/config dir to migrate from
 */
function createStore({ dir, legacyDir = null, log = console }) {
  const paths = {
    dir,
    build: path.join(dir, 'build.json'),
    settings: path.join(dir, 'settings.json'),
    saves: path.join(dir, 'saves'),
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

  /** Copy build.json / hotkeys / saves from the old in-repo config dir, once. */
  function migrateLegacy() {
    if (!legacyDir || !fs.existsSync(legacyDir)) return [];
    const migrated = [];
    fs.mkdirSync(dir, { recursive: true });

    const legacyBuild = path.join(legacyDir, 'build.json');
    if (!fs.existsSync(paths.build) && fs.existsSync(legacyBuild)) {
      fs.copyFileSync(legacyBuild, paths.build);
      migrated.push('build.json');
    }

    // Only hotkeys carry over — old window bounds were for the tiny overlay.
    const legacySettings = path.join(legacyDir, 'settings.json');
    if (!fs.existsSync(paths.settings) && fs.existsSync(legacySettings)) {
      const old = readJson(legacySettings, null);
      if (old?.hotkeys) {
        writeJson(paths.settings, mergeSettings({ hotkeys: old.hotkeys }));
        migrated.push('settings.json (hotkeys)');
      }
    }

    const legacySaves = path.join(legacyDir, 'saves');
    if (fs.existsSync(legacySaves)) {
      fs.mkdirSync(paths.saves, { recursive: true });
      for (const f of fs.readdirSync(legacySaves).filter(n => n.endsWith('.json'))) {
        const dest = path.join(paths.saves, f);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(legacySaves, f), dest);
          migrated.push(`saves/${f}`);
        }
      }
    }
    return migrated;
  }

  // ─── Build ──────────────────────────────────────────────────────────────────
  const loadBuild = () => readJson(paths.build, null);
  const saveBuild = (build) => writeJson(paths.build, build);

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
    paths, readJson, writeJson, migrateLegacy,
    loadBuild, saveBuild, loadSettings, saveSettings,
    saveTemplate, listTemplates, loadTemplate, deleteTemplate,
  };
}

module.exports = { createStore, mergeSettings, DEFAULT_SETTINGS, FULL_MIN, COMPACT_MIN };
