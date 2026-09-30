/**
 * electron/main.js
 * ─────────────────
 * Electron MAIN PROCESS for the standalone desktop app.
 *
 *  - One normal, resizable app window (app/index.html). Bounds, maximized
 *    state, always-on-top and UI scale persist in <userData>/settings.json.
 *  - Two window modes: 'full' and 'compact' (mini mode: small, always on top,
 *    translucent). Each mode keeps its own bounds (settings.window /
 *    settings.compactWindow); switching swaps them.
 *  - Game data (db/data) is read-only and ships with the app; runtime state
 *    (build, settings, templates) lives in <userData> — see store.js.
 *  - Global hotkeys (hotkeys.js) let the player advance while the game has
 *    focus; track keys are released whenever this window is focused.
 *  - All renderer access goes through electron/preload.js (window.api).
 *
 * IPC (renderer → main, invoke):
 *   app:init                 → { db, build, profiles, activeProfile, settings, defaultSettings, failedHotkeys, missingData, version }
 *   build:save    (build)    → { ok }                       (into the active profile)
 *   build:preview ({ json }) → { ok, summary } | { ok:false, error }
 *   build:load    ({ phases, loadoutName, source, target }) → { ok, build, profiles, activeProfile }
 *                              target 'new' = a new character profile; otherwise the active one
 *   build:example            → { ok, build } | { ok:false, error }
 *   profiles:create ({ name }) | profiles:switch ({ id }) | profiles:rename ({ id, name }) | profiles:delete ({ id })
 *                            → { ok, build, profiles, activeProfile }
 *   settings:save (settings) → { ok, settings, failedHotkeys }
 *   hotkeys:pause ({ paused }) → { ok }   (while recording a shortcut)
 *   window:setMode ({ mode }) → { ok, settings }   ('full' | 'compact')
 *   maxroll:fetch ({ link }) → { ok, planner: { id, name, author, pick, variants: [{ …, summary, json }] } }
 *                              | { ok:false, error, canOpen }
 *   maxroll:clipboardLink    → { ok, link|null, code|null }  (a planner link / share code on the clipboard; never auto-fetches)
 *   share:copy               → { ok, code }        (the active build's share code, copied to the clipboard)
 *   share:preview ({ code }) → { ok, name, classId, phases: [{ name, json, summary, origin, from, note? }], dates }
 *                              (guides fetched fresh; the shared route when Maxroll or the variant is gone)
 *   maxroll:open ({ link })  → { ok }              (opens the planner in the browser)
 *   maxroll:checkUpdate ({ manual }) → { ok, status: 'none'|'skipped'|'upToDate'|'dismissed'|'unmapped'|'update',
 *                              update?: { planner, planners, signature, newBuild, diff, missing } }
 *                              (every guide the active build's phases came from)
 *   maxroll:dismissUpdate ({ date }) → { ok }       ("Keep mine": date = update.signature; not offered again)
 *   templates:list | templates:load | templates:delete   (templates saved before 0.4; no new ones since share codes)
 *
 * main → renderer:
 *   hotkey  { action: 'advance'|'undo'|'phase'|'latch', trackIndex?, direction?, active? }
 */

'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, shell, net, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const { createStore, userDataDir, DEFAULT_SETTINGS, FULL_MIN, COMPACT_MIN } = require('./store');
const { createHotkeys } = require('./hotkeys');
const { createMaxrollClient, hiddenWindowLoader } = require('./maxroll');
const { createUpdater } = require('./updater');
const MaxrollImport = require('../shared/maxroll-import');
const ShareCode = require('./share-code');
const TreeUtils = require('../shared/tree-utils');

const ROOT = path.join(__dirname, '..');
const EXAMPLE_BUILD = path.join(ROOT, 'config', 'build.example.json');
const IS_DEV = process.argv.includes('--dev');

// Per-user data: always %APPDATA%/le-build-overlay, whatever productName says (see
// store.js userDataDir). LE_USER_DATA gives an isolated profile (tests, screenshots).
app.setPath('userData', process.env.LE_USER_DATA ? path.resolve(process.env.LE_USER_DATA) : userDataDir(app.getPath('appData')));

// Single instance: a second launch focuses the existing window.
const IS_PRIMARY = app.requestSingleInstanceLock();
if (!IS_PRIMARY) app.quit();

let win = null;
let store = null;
let hotkeys = null;
let settings = null;
let profileId = null; // the active character profile (store.js profiles)
let updater = null;   // app updates (updater.js)

// ─── Game data ────────────────────────────────────────────────────────────────

let gameData = null;
let gameDataStamp = null;

/**
 * Game data is read-only while the app runs: load once, reuse for every
 * preview/load. `fresh` (window (re)load) re-checks the files and re-reads
 * them only if they changed on disk — re-running the extractor still just
 * needs a reload, without re-parsing ~2 MB on every window load.
 */
function loadGameData({ fresh = false } = {}) {
  const buildDb = require('../db/build-db');
  const stamp = gameData && !fresh ? gameDataStamp : buildDb.dataStamp();
  if (!gameData || stamp !== gameDataStamp) {
    buildDb.load(true);
    gameData = { db: buildDb.all(), missing: buildDb.missingFiles() };
    gameDataStamp = stamp;
  }
  return gameData;
}

// ─── Window ───────────────────────────────────────────────────────────────────

/** Keep saved bounds only if at least a usable strip of the window is on a display. */
function visibleBounds(w) {
  if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) return { width: w.width, height: w.height };
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    w.x + 120 < a.x + a.width && w.x + w.width - 120 > a.x &&
    w.y >= a.y - 10 && w.y + 60 < a.y + a.height);
  return onScreen ? { x: w.x, y: w.y, width: w.width, height: w.height } : { width: w.width, height: w.height };
}

const isCompact = () => settings.display.mode === 'compact';

/** Saved bounds for a mode. Mini mode's first use goes to the top-right of the display. */
function boundsFor(mode) {
  if (mode !== 'compact') return visibleBounds(settings.window);
  const c = settings.compactWindow;
  if (Number.isFinite(c.x) && Number.isFinite(c.y)) {
    const b = visibleBounds(c);
    if (Number.isFinite(b.x)) return b;
  }
  const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const a = display.workArea;
  return { x: a.x + a.width - c.width - 24, y: a.y + 24, width: c.width, height: c.height };
}

/** Min size, stay-on-top and opacity for the current mode. */
function applyWindowMode() {
  if (!win || win.isDestroyed()) return;
  const compact = isCompact();
  const min = compact ? COMPACT_MIN : FULL_MIN;
  win.setMinimumSize(min.width, min.height);
  // Mini mode is always on top ('screen-saver' also floats over macOS fullscreen spaces).
  if (compact) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(settings.display.alwaysOnTop);
  win.setOpacity(compact ? settings.display.opacity : 1); // no-op on Linux
}

let boundsTimer = null;
function persistBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistBounds, 400);
}

/** Save the window's bounds into the slot of the mode it is in. */
function persistBounds() {
  clearTimeout(boundsTimer);
  if (!win || win.isDestroyed()) return;
  if (isCompact()) {
    if (win.isMinimized()) return;
    const b = win.getBounds();
    settings = store.saveSettings({ ...settings, compactWindow: { x: b.x, y: b.y, width: b.width, height: b.height } });
    return;
  }
  const maximized = win.isMaximized();
  const b = win.getNormalBounds(); // restore-size bounds, even while maximized
  settings = store.saveSettings({
    ...settings,
    window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized },
  });
}

function setWindowMode(mode) {
  const next = mode === 'compact' ? 'compact' : 'full';
  if (!win || next === settings.display.mode) return;
  persistBounds(); // outgoing mode's slot
  if (win.isMaximized()) win.unmaximize();
  if (win.isFullScreen()) win.setFullScreen(false);
  settings = store.saveSettings({ ...settings, display: { ...settings.display, mode: next } });
  applyWindowMode();
  const b = boundsFor(next);
  if (Number.isFinite(b.x)) win.setBounds(b);
  else { win.setSize(b.width, b.height); win.center(); }
  if (next === 'full' && settings.window.maximized) win.maximize();
}

function createWindow() {
  const compact = isCompact();
  win = new BrowserWindow({
    ...boundsFor(settings.display.mode),
    minWidth: (compact ? COMPACT_MIN : FULL_MIN).width,
    minHeight: (compact ? COMPACT_MIN : FULL_MIN).height,
    show: false,
    title: 'LE Build Planner',
    backgroundColor: '#0b0d12',
    alwaysOnTop: compact || settings.display.alwaysOnTop,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', // hotkey sound cues play before any click
    },
  });

  win.loadFile(path.join(ROOT, 'app', 'index.html'));

  win.once('ready-to-show', () => {
    win.webContents.setZoomFactor(settings.display.uiScale);
    applyWindowMode();
    if (!isCompact() && settings.window.maximized) win.maximize();
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  // Zoom resets on navigation/reload — reapply.
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(settings.display.uiScale));

  // External links open in the browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('focus', () => hotkeys.setSuspended(true));
  win.on('blur', () => hotkeys.setSuspended(false));
  win.on('move', persistBoundsSoon);
  win.on('resize', persistBoundsSoon);
  win.on('close', persistBounds);
  win.on('closed', () => { win = null; });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    win.showInactive(); // never steal focus from the game
    if (win.isMinimized()) win.restore();
  }
}

function emitHotkey(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('hotkey', payload);
}

// ─── Maxroll import ───────────────────────────────────────────────────────────

let maxrollClient = null;
function maxroll() {
  if (!maxrollClient) {
    maxrollClient = createMaxrollClient({
      fetch: (url, init) => net.fetch(url, init),
      loadInWindow: hiddenWindowLoader(BrowserWindow),
      fixturesDir: process.env.LE_MAXROLL_FIXTURES ? path.resolve(process.env.LE_MAXROLL_FIXTURES) : null,
    });
  }
  return maxrollClient;
}

/** What the Load build dialog shows for one phase: class, points, skills (known or not). */
function summarizeBuild(json) {
  const { parseBuild } = require('../parser/maxroll');
  const { db } = loadGameData();
  const build = parseBuild(json, db.skills, db.classes, 'Preview');
  const [passive, ...skills] = build.tracks;
  const className = db.classes.classes?.[build.classId] ?? `Class ${build.classId}`;
  const passiveTreeId = db.classes.passiveTreeByClass?.[String(build.classId)];
  const fit = TreeUtils.passiveFit(passive.history, db.skills[passiveTreeId]);
  return {
    // Points that don't fit the class's tree = a wrong class id mapping, never a real build.
    passiveMismatch: passive.history.length && !fit.fits
      ? `These passive points don’t fit the ${className} tree (${fit.missing} on unknown nodes, ${fit.over} over a node’s max) — the class may be mapped wrong.`
      : null,
    classId: build.classId,
    className,
    masteryId: build.masteryId,
    classLabel: passive.label.replace(/ Passives$/, ''),
    passivePoints: passive.history.length,
    skills: skills.map(t => ({
      key: t.skillKey,
      name: db.skills[t.skillKey]?.name ?? t.skillKey,
      points: t.history.length,
      known: !!db.skills[t.skillKey],
    })),
  };
}

// ─── Game data version ────────────────────────────────────────────────────────

/**
 * The first start with new game data (an app update after a game patch) returns
 * its version.json so the renderer can show the one-time "Game data updated"
 * card. A brand-new install just records the version: nothing to compare with.
 */
function seenDataVersion() {
  const { dataVersion } = require('../db/build-db');
  const v = dataVersion();
  if (!v || v.version === settings.lastDataVersion) return null;
  const isUpdate = settings.lastDataVersion != null;
  settings = store.saveSettings({ ...settings, lastDataVersion: v.version });
  return isUpdate ? v : null;
}

/**
 * First start of a new app version? Returns the version it replaced ('earlier' when that
 * install predates this setting), or null (same version, or a fresh install). Always
 * records the running version, like seenDataVersion.
 */
function seenAppVersion() {
  const v = app.getVersion();
  if (settings.lastAppVersion === v) return null;
  // No record but the app has run before (it recorded a data version): an update from ≤ 0.2.x.
  const from = settings.lastAppVersion ?? (settings.lastDataVersion != null ? 'earlier' : null);
  settings = store.saveSettings({ ...settings, lastAppVersion: v });
  return from;
}

// ─── App updates ──────────────────────────────────────────────────────────────

/**
 * installer = the NSIS install (electron-updater replaces it); portable = the portable
 * exe (can't replace itself: offer the release page); off = not a packaged build, or a
 * test profile (LE_USER_DATA), so dev runs and CI never touch GitHub.
 */
function updateMode() {
  if (!app.isPackaged || process.env.LE_USER_DATA) return 'off';
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.platform !== 'win32') return 'portable';
  return 'installer';
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

/** Default name for a character: its class ("Rogue"); the player renames it to their character's name. */
function characterName(build) {
  const cls = Number.isInteger(build?.classId) ? loadGameData().db.classes.classes?.[build.classId] : null;
  return cls || 'Character 1';
}

/** Make `id` the active profile and remember it for the next start. */
function setActiveProfile(id) {
  profileId = id;
  if (settings.activeProfile !== id) settings = store.saveSettings({ ...settings, activeProfile: id });
}

/** What the renderer needs after any profile change: the active build + the list. */
function profileState() {
  return { build: store.readProfile(profileId)?.build ?? null, profiles: store.listProfiles(), activeProfile: profileId };
}

/**
 * Keep only what we know about a build's origin:
 * { maxroll: id, date?, phases?: [{ variant: index, name }] } — the phase map lets
 * the guide-update check line the planner's variants up with this build's phases.
 */
/** Validate a build's source (per-phase: which planner variant, or codes). null = not from Maxroll. */
function cleanSource(source, phaseCount) {
  const g = MaxrollImport.guideSources(source, phaseCount);
  return MaxrollImport.makeSource(g.phases, g.dates);
}

// ─── Share codes ──────────────────────────────────────────────────────────────

/**
 * A share code → the phases to load, like a Maxroll import: each guide phase is fetched
 * fresh from its planner (the importer gets the guide's current version, and guide updates
 * keep working); the route in the code is the fallback when Maxroll can't be reached
 * (origin kept: later guide checks sync it) or the author deleted the variant (origin dropped).
 */
async function previewShareCode(code) {
  const shared = ShareCode.decodeShareCode(code);
  const { db } = loadGameData();
  const planners = {};
  for (const id of new Set(shared.phases.map(p => p.ref?.maxroll).filter(Boolean))) {
    try {
      planners[id] = MaxrollImport.decodePlanner(await maxroll().fetchPlanner(id), db.skills);
    } catch (err) {
      planners[id] = { error: err.message };
    }
  }
  const phases = shared.phases.map((p) => {
    const planner = p.ref && planners[p.ref.maxroll];
    let json = JSON.stringify(p.build);
    let origin = null;
    let from = 'shared';
    let note = null;
    if (planner && !planner.error) {
      const idx = MaxrollImport.mapPhasesToVariants([p.ref], [{ name: p.name }], planner.variants)[0];
      if (idx != null) {
        const v = planner.variants[idx];
        json = JSON.stringify(v.build);
        origin = { maxroll: p.ref.maxroll, variant: idx, name: v.name, guide: planner.name };
        from = 'guide';
      } else {
        note = `“${p.ref.name}” is no longer in the guide — using the route as it was shared.`;
      }
    } else if (planner?.error) {
      origin = { ...p.ref, guide: null };
      note = 'Maxroll couldn’t be reached — using the route as it was shared. It syncs with the guide at the next update check.';
    }
    let summary = null;
    let error = null;
    try { summary = summarizeBuild(json); } catch (err) { error = err.message; }
    return { name: p.name, json, summary, error, origin, from, note };
  });
  const classes = new Set(phases.map(p => p.summary?.classId).filter(c => c != null));
  if (classes.size > 1) throw new Error('This share code mixes classes — it can’t be loaded as one build.');
  const dates = Object.fromEntries(Object.entries(planners).filter(([, p]) => p.date).map(([id, p]) => [id, p.date]));
  return { name: shared.name, classId: shared.classId, phases, dates };
}

// ─── Guide updates ────────────────────────────────────────────────────────────

const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000; // automatic checks: once a day per character

/**
 * Has the active build's Maxroll guide changed since it was loaded? Never applies
 * anything: returns the new version + a diff for the renderer to offer.
 * Automatic checks (manual=false) respect the setting, the daily limit and a
 * dismissed version; a manual check always fetches fresh.
 */
async function checkGuideUpdate({ manual = false } = {}) {
  const profile = store.readProfile(profileId);
  const build = profile?.build;
  if (!Array.isArray(build?.phases)) return { status: 'none' };
  // A build can mix guides (leveling from one planner, endgame from another) and pasted codes.
  const guide = MaxrollImport.guideSources(build.source, build.phases.length);
  if (!guide.planners.length) return { status: 'none' };
  const check = profile.updateCheck ?? {};
  if (!manual && (!settings.updates.checkMaxroll || Date.now() - (check.at ?? 0) < UPDATE_CHECK_EVERY_MS)) return { status: 'skipped' };

  const { db } = loadGameData();
  const planners = {};
  for (const id of guide.planners) {
    planners[id] = MaxrollImport.decodePlanner(await maxroll().fetchPlanner(id, { fresh: manual }), db.skills);
  }
  store.updateProfile(profileId, { updateCheck: { ...check, at: Date.now() } });
  const dates = Object.fromEntries(guide.planners.map(id => [id, planners[id].date]));
  if (guide.planners.every(id => dates[id] && dates[id] === guide.dates[id])) return { status: 'upToDate' };
  const signature = MaxrollImport.guideSignature(guide.planners, dates);
  if (!manual && signature === check.dismissed) return { status: 'dismissed' };

  const picks = MaxrollImport.mapGuidePhases(guide.phases, build.phases, planners);
  const variantOf = (i) => planners[guide.phases[i].maxroll].variants[picks[i]];
  if (picks.every(v => v == null)) return { status: 'unmapped' };
  const { parseLoadout } = require('../parser/maxroll');
  const matched = build.phases
    .map((p, i) => (picks[i] == null ? null : { i, name: p.name, json: JSON.stringify(variantOf(i).build) }))
    .filter(Boolean);
  const parsed = parseLoadout(matched.map(({ name, json }) => ({ name, json })), db.skills, db.classes, build.name);
  if (parsed.classId !== build.classId) throw new Error('The guide is now for another class — load it as a new character instead.');
  // Phases pasted as codes, or whose variant is gone, stay as they are.
  const phases = build.phases.map((p, i) => {
    const k = matched.findIndex(m => m.i === i);
    return k >= 0 ? parsed.phases[k] : p;
  });
  const newBuild = {
    ...build,
    masteryId: Math.max(0, ...phases.map(p => p.masteryId ?? 0)),
    phases,
    source: MaxrollImport.makeSource(guide.phases.map((e, i) => (picks[i] == null
      ? e
      : { maxroll: e.maxroll, variant: picks[i], name: variantOf(i).name })), { ...guide.dates, ...dates }),
  };
  const diff = TreeUtils.diffLoadout(build, newBuild);
  if (!diff.changed) {
    // Saved again on Maxroll without changing the route: remember the new dates quietly.
    store.saveProfileBuild(profileId, { ...build, source: newBuild.source });
    return { status: 'upToDate' };
  }
  const about = (p) => ({ name: p.name, author: p.author, date: p.date });
  const edited = guide.planners.filter(id => dates[id] !== guide.dates[id]); // the guides saved since
  const shown = edited.length ? edited : guide.planners;
  return {
    status: 'update',
    update: {
      planner: about(planners[shown[0]]),
      planners: shown.map(id => about(planners[id])),
      signature,
      newBuild,
      diff,
      missing: build.phases.filter((_, i) => guide.phases[i] && picks[i] == null).map(p => p.name),
    },
  };
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

/** Wrap a handler so thrown errors become { ok:false, error } instead of rejections. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, arg) => {
    try {
      return { ok: true, ...(await fn(arg)) };
    } catch (err) {
      console.error(`[main] ${channel}:`, err.message);
      return { ok: false, error: err.message, ...(err.canOpen ? { canOpen: true } : {}) };
    }
  });
}

function registerIpc() {
  handle('app:init', () => {
    const { db, missing } = loadGameData({ fresh: true });
    const updatedFrom = seenAppVersion(); // before seenDataVersion, which records the data version
    const dataUpdate = seenDataVersion();
    return {
      db: { trees: db.skills, classes: db.classes },
      missingData: missing,
      ...profileState(),
      settings,
      defaultSettings: DEFAULT_SETTINGS,
      failedHotkeys: hotkeys.getFailures(),
      version: app.getVersion(),
      appUpdate: updater.getState(),
      dataUpdate,
      updatedFrom,
    };
  });

  // The in-app "What's new" (app/changelog.json, hand-written; see shared/changelog.js).
  handle('app:changelog', () => ({ changelog: JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'changelog.json'), 'utf8')) }));

  handle('build:save', (build) => {
    if (!build || !Array.isArray(build.phases)) throw new Error('Refusing to save an invalid loadout');
    store.saveProfileBuild(profileId, build);
    return {};
  });

  handle('build:preview', ({ json }) => ({ summary: summarizeBuild(json) }));

  handle('maxroll:fetch', async ({ link }) => {
    const parsed = MaxrollImport.parseMaxrollLink(link);
    if (!parsed) throw new Error('That is not a Maxroll Last Epoch planner link (maxroll.gg/last-epoch/planner/…).');
    const raw = await maxroll().fetchPlanner(parsed.id);
    const planner = MaxrollImport.decodePlanner(raw, loadGameData().db.skills);
    const variants = planner.variants.map(v => {
      let summary = null;
      let error = null;
      try { summary = summarizeBuild(v.build); } catch (err) { error = err.message; }
      return { ...v, summary, error, json: JSON.stringify(v.build) };
    });
    // "#N" in the link = the N-th visible variant: pre-select just that one.
    const pick = MaxrollImport.visibleVariantIndex(variants, parsed.variant);
    return { planner: { ...planner, variants, pick, link: `https://maxroll.gg/last-epoch/planner/${parsed.id}` } };
  });

  handle('maxroll:clipboardLink', async () => {
    const text = String(await clipboard.readText()).trim(); // a Promise since Electron 44 (W3C-style clipboard)
    return {
      link: text.length < 300 && /maxroll\.gg\/last-epoch\/planner\//i.test(text) && MaxrollImport.parseMaxrollLink(text) ? text : null,
      code: text.length < ShareCode.SHARE_LIMITS.code + 2000 ? ShareCode.findShareCode(text) : null,
    };
  });

  handle('share:copy', () => {
    const code = ShareCode.encodeShareCode(store.readProfile(profileId)?.build);
    clipboard.writeText(code);
    return { code };
  });

  handle('share:preview', ({ code }) => previewShareCode(code));

  handle('maxroll:open', ({ link }) => {
    const parsed = MaxrollImport.parseMaxrollLink(link);
    if (parsed) shell.openExternal(`https://maxroll.gg/last-epoch/planner/${parsed.id}`);
    return {};
  });

  handle('maxroll:checkUpdate', ({ manual } = {}) => checkGuideUpdate({ manual: !!manual }));

  handle('maxroll:dismissUpdate', ({ date }) => {
    const profile = store.readProfile(profileId);
    if (profile && typeof date === 'string') store.updateProfile(profileId, { updateCheck: { ...profile.updateCheck, dismissed: date } });
    return {};
  });

  handle('build:load', ({ phases, loadoutName, source, target }) => {
    const { parseLoadout } = require('../parser/maxroll');
    const { db } = loadGameData();
    const build = parseLoadout(phases, db.skills, db.classes, loadoutName || 'Imported loadout');
    // Where it came from — lets the app re-import it and check the guide for updates.
    const src = cleanSource(source, build.phases.length);
    if (src) build.source = src;
    if (target === 'new') {
      setActiveProfile(store.createProfile({ name: characterName(build), build }).id);
    } else {
      const current = store.readProfile(profileId);
      // An empty, never-renamed "Character 1" takes the class name with its first build.
      const rename = current && !current.build && /^Character( \d+)?$/.test(current.name) ? { name: characterName(build) } : {};
      store.updateProfile(profileId, { ...rename, build });
    }
    return profileState();
  });

  handle('build:example', () => {
    const { validateLoadout } = require('../parser/build-schema');
    const build = JSON.parse(fs.readFileSync(EXAMPLE_BUILD, 'utf-8'));
    delete build._comment;
    validateLoadout(build);
    store.saveProfileBuild(profileId, build);
    return { build };
  });

  handle('appUpdate:check', () => updater.check(true).then(() => ({ appUpdate: updater.getState() })));
  handle('appUpdate:install', () => {
    const s = updater.getState();
    if (s.state === 'available' && s.url) shell.openExternal(s.url); // portable: the release page
    else updater.install();                                          // installer: restart into it
    return {};
  });

  handle('settings:save', (next) => {
    // Bounds and the window mode are owned by main (persistBounds / window:setMode).
    const wasChecking = settings.updates.checkApp;
    settings = store.saveSettings({
      ...next,
      activeProfile: profileId,
      lastDataVersion: settings.lastDataVersion,
      lastAppVersion: settings.lastAppVersion,
      window: settings.window,
      compactWindow: settings.compactWindow,
      display: { ...next?.display, mode: settings.display.mode },
    });
    if (win) {
      applyWindowMode();
      win.webContents.setZoomFactor(settings.display.uiScale);
    }
    if (settings.updates.checkApp && !wasChecking) updater.start();
    if (!settings.updates.checkApp && wasChecking) updater.stop();
    const failedHotkeys = hotkeys.apply(settings.hotkeys);
    // Settings are saved from inside the focused window — keep track keys released.
    if (win?.isFocused()) hotkeys.setSuspended(true);
    return { settings, failedHotkeys };
  });

  handle('hotkeys:pause', ({ paused }) => { hotkeys.pause(!!paused); return {}; });

  handle('window:setMode', ({ mode }) => { setWindowMode(mode); return { settings }; });

  handle('profiles:create', ({ name } = {}) => {
    setActiveProfile(store.createProfile({ name: name || `Character ${store.listProfiles().length + 1}` }).id);
    return profileState();
  });
  handle('profiles:switch', ({ id }) => {
    if (!store.readProfile(id)) throw new Error('That character no longer exists.');
    setActiveProfile(id);
    return profileState();
  });
  handle('profiles:rename', ({ id, name }) => {
    store.updateProfile(id, { name });
    return profileState();
  });
  handle('profiles:delete', ({ id }) => {
    store.deleteProfile(id);
    if (id === profileId) setActiveProfile(store.resolveProfile(null).id);
    return profileState();
  });

  handle('templates:list', () => ({ list: store.listTemplates() }));
  handle('templates:load', ({ filename }) => ({ template: store.loadTemplate(filename) }));
  handle('templates:delete', ({ filename }) => { store.deleteTemplate(filename); return {}; });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (!IS_PRIMARY) return;
  Menu.setApplicationMenu(null);

  store = createStore({ dir: app.getPath('userData') });
  settings = store.loadSettings();
  const migratedProfile = store.migrateProfiles(characterName);
  if (migratedProfile) console.log('[main] build.json → first character profile');
  setActiveProfile(store.resolveProfile(migratedProfile ?? settings.activeProfile).id);

  hotkeys = createHotkeys({ globalShortcut, emit: emitHotkey, toggleWindow });

  updater = createUpdater({
    mode: updateMode(),
    currentVersion: app.getVersion(),
    emit: (state) => { if (win && !win.isDestroyed()) win.webContents.send('app-update', state); },
    autoUpdater: updateMode() === 'installer' ? require('electron-updater').autoUpdater : null,
    fetch: (url, init) => net.fetch(url, init),
  });
  if (settings.updates.checkApp) updater.start();
  hotkeys.apply(settings.hotkeys);

  registerIpc();
  createWindow();
});

app.on('will-quit', () => { hotkeys?.dispose(); updater?.stop(); });
app.on('window-all-closed', () => app.quit());
