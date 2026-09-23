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
  display: { uiScale: 1, alwaysOnTop: false },
  hotkeys: {
    enabled: true,
    hotkeyMode: 'direct',     // 'direct' | 'latch'
    latchKey: '`',
    advanceModifier: '',      // '' | 'Alt' | 'Ctrl' | 'Shift'
    undoModifier: 'Shift',
    toggle: 'F1',             // show / hide the window
    phaseNextKey: 'F6',
    phasePrevKey: 'Shift+F6',
  },
});

const UI_SCALE_MIN = 0.8;
const UI_SCALE_MAX = 1.6;
const MODIFIERS = ['', 'Alt', 'Ctrl', 'Shift'];

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const str = (v, fallback) => (typeof v === 'string' ? v : fallback);

/**
 * Merge a possibly partial / outdated / hand-edited settings object over the
 * defaults, dropping unknown keys and fixing out-of-range values.
 */
function mergeSettings(raw) {
  const d = DEFAULT_SETTINGS;
  const w = raw?.window ?? {};
  const disp = raw?.display ?? {};
  const hk = raw?.hotkeys ?? {};
  return {
    window: {
      x: Number.isFinite(w.x) ? w.x : null,
      y: Number.isFinite(w.y) ? w.y : null,
      width: Math.max(420, num(w.width, d.window.width)),
      height: Math.max(480, num(w.height, d.window.height)),
      maximized: w.maximized === true,
    },
    display: {
      uiScale: Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, num(disp.uiScale, d.display.uiScale))),
      alwaysOnTop: disp.alwaysOnTop === true,
    },
    hotkeys: {
      enabled: hk.enabled !== false,
      hotkeyMode: hk.hotkeyMode === 'latch' ? 'latch' : 'direct',
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

module.exports = { createStore, mergeSettings, DEFAULT_SETTINGS, UI_SCALE_MIN, UI_SCALE_MAX };
