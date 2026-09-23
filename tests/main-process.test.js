/**
 * tests/main-process.test.js
 * ───────────────────────────
 * Electron-free tests for electron/store.js and electron/hotkeys.js.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore, mergeSettings, DEFAULT_SETTINGS } = require('../electron/store');
const { createHotkeys, LATCH_TIMEOUT_MS } = require('../electron/hotkeys');

const quiet = { log() {}, warn() {}, error() {} };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'le-store-'));
}

// ─── mergeSettings ────────────────────────────────────────────────────────────

describe('mergeSettings', () => {
  test('empty input yields defaults', () => {
    assert.deepEqual(mergeSettings(undefined), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  });

  test('clamps and sanitises bad values, drops unknown keys', () => {
    const s = mergeSettings({
      window: { width: 50, height: 'x', x: 'nope' },
      display: { uiScale: 9, opacity: 0.2 },
      hotkeys: { hotkeyMode: 'weird', undoModifier: 'Hyper', toggle: 5, legacyKey: 'F2' },
    });
    assert.equal(s.window.width, 420);
    assert.equal(s.window.height, DEFAULT_SETTINGS.window.height);
    assert.equal(s.window.x, null);
    assert.equal(s.display.uiScale, 1.6);
    assert.equal('opacity' in s.display, false);
    assert.equal(s.hotkeys.hotkeyMode, 'direct');
    assert.equal(s.hotkeys.undoModifier, 'Shift');
    assert.equal(s.hotkeys.toggle, 'F1');
    assert.equal('legacyKey' in s.hotkeys, false);
  });
});

// ─── store ────────────────────────────────────────────────────────────────────

describe('createStore', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('build round-trips and writes atomically (no temp file left)', () => {
    const store = createStore({ dir, log: quiet });
    assert.equal(store.loadBuild(), null);
    store.saveBuild({ phases: [] });
    assert.deepEqual(store.loadBuild(), { phases: [] });
    assert.deepEqual(fs.readdirSync(dir), ['build.json']);
  });

  test('corrupt JSON is moved aside and the fallback returned', () => {
    fs.writeFileSync(path.join(dir, 'build.json'), '{oops');
    const store = createStore({ dir, log: quiet });
    assert.equal(store.loadBuild(), null);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('build.json.corrupt-')));
  });

  test('saveSettings returns and persists merged settings', () => {
    const store = createStore({ dir, log: quiet });
    const s = store.saveSettings({ display: { uiScale: 1.2, alwaysOnTop: true } });
    assert.equal(s.display.uiScale, 1.2);
    assert.equal(store.loadSettings().display.alwaysOnTop, true);
  });

  test('templates: save, list (newest first), load, delete; filenames cannot traverse', () => {
    const store = createStore({ dir, log: quiet });
    const a = store.saveTemplate({ loadoutName: 'First', phases: [{ name: 'P1', json: '{}' }] });
    const b = store.saveTemplate({ loadoutName: '../../evil', phases: [] });
    assert.ok(!b.includes('/'));
    const list = store.listTemplates();
    assert.equal(list.length, 2);
    assert.equal(store.loadTemplate(a).phases[0].name, 'P1');
    assert.throws(() => store.loadTemplate('../build.json'));
    store.deleteTemplate(a);
    assert.equal(store.listTemplates().length, 1);
  });

  test('migrateLegacy copies build, hotkeys (not overlay bounds) and saves — once', () => {
    const legacy = tmpDir();
    fs.writeFileSync(path.join(legacy, 'build.json'), JSON.stringify({ phases: ['x'] }));
    fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({
      window: { width: 265, height: 466 }, hotkeys: { hotkeyMode: 'latch', toggle: 'F9' },
    }));
    fs.mkdirSync(path.join(legacy, 'saves'));
    fs.writeFileSync(path.join(legacy, 'saves', 't.json'), '{}');

    const store = createStore({ dir, legacyDir: legacy, log: quiet });
    const migrated = store.migrateLegacy();
    assert.deepEqual(migrated.sort(), ['build.json', 'saves/t.json', 'settings.json (hotkeys)']);
    const s = store.loadSettings();
    assert.equal(s.hotkeys.hotkeyMode, 'latch');
    assert.equal(s.hotkeys.toggle, 'F9');
    assert.equal(s.window.width, DEFAULT_SETTINGS.window.width);
    assert.deepEqual(store.migrateLegacy(), []); // idempotent
    fs.rmSync(legacy, { recursive: true, force: true });
  });
});

// ─── hotkeys ──────────────────────────────────────────────────────────────────

function fakeShortcuts({ taken = [] } = {}) {
  const registered = new Map();
  return {
    registered,
    register(acc, fn) {
      if (acc === 'Bad+Key') throw new Error('invalid accelerator');
      if (taken.includes(acc) || registered.has(acc)) return false;
      registered.set(acc, fn);
      return true;
    },
    unregister(acc) { registered.delete(acc); },
    unregisterAll() { registered.clear(); },
    press(acc) { registered.get(acc)?.(); },
  };
}

const HK = (over = {}) => ({ ...DEFAULT_SETTINGS.hotkeys, ...over });

describe('createHotkeys', () => {
  test('direct mode registers 1–6, Shift+1–6, toggle and phase keys', () => {
    const gs = fakeShortcuts();
    const events = [];
    const hk = createHotkeys({ globalShortcut: gs, emit: e => events.push(e), toggleWindow() {}, log: quiet });
    assert.deepEqual(hk.apply(HK()), []);
    for (const k of ['1', '6', 'Shift+1', 'Shift+6', 'F1', 'F6', 'Shift+F6']) assert.ok(gs.registered.has(k), k);
    gs.press('3');
    gs.press('Shift+2');
    assert.deepEqual(events.map(e => [e.action, e.trackIndex]), [['advance', 2], ['undo', 1]]);
  });

  test('focus suspends track keys (so typing works) and blur restores them', () => {
    const gs = fakeShortcuts();
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    hk.apply(HK());
    hk.setSuspended(true);
    assert.equal(gs.registered.has('1'), false);
    assert.equal(gs.registered.has('Shift+1'), false);
    assert.ok(gs.registered.has('F6'));
    hk.setSuspended(false);
    assert.ok(gs.registered.has('1'));
  });

  test('apply while suspended does not grab track keys', () => {
    const gs = fakeShortcuts();
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    hk.apply(HK());
    hk.setSuspended(true);
    hk.apply(HK({ undoModifier: 'Ctrl' }));
    assert.equal(gs.registered.has('1'), false);
    hk.setSuspended(false);
    assert.ok(gs.registered.has('Ctrl+1'));
  });

  test('bad or taken keys are reported without blocking the rest', () => {
    const gs = fakeShortcuts({ taken: ['F6'] });
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    const failed = hk.apply(HK({ toggle: 'Bad+Key' }));
    assert.deepEqual(failed.sort(), ['Bad+Key', 'F6']);
    assert.ok(gs.registered.has('1') && gs.registered.has('Shift+F6'));
  });

  test('disabled registers nothing', () => {
    const gs = fakeShortcuts();
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    hk.apply(HK({ enabled: false }));
    assert.equal(gs.registered.size, 0);
  });

  test('latch mode: key arms 1–6, each use re-arms, timeout disarms', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gs = fakeShortcuts();
    const events = [];
    const hk = createHotkeys({ globalShortcut: gs, emit: e => events.push(e), toggleWindow() {}, log: quiet });
    hk.apply(HK({ hotkeyMode: 'latch' }));
    assert.equal(gs.registered.has('1'), false);

    gs.press('`');
    assert.ok(gs.registered.has('1'));
    t.mock.timers.tick(LATCH_TIMEOUT_MS - 100);
    gs.press('1');                               // re-arms
    t.mock.timers.tick(LATCH_TIMEOUT_MS - 100);
    assert.ok(gs.registered.has('1'), 'still armed thanks to the re-arm');
    t.mock.timers.tick(200);
    assert.equal(gs.registered.has('1'), false);
    assert.deepEqual(events.filter(e => e.action === 'latch').map(e => e.active), [true, false]);
  });

  test('latch mode: focusing the app disarms and releases the latch key', () => {
    const gs = fakeShortcuts();
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    hk.apply(HK({ hotkeyMode: 'latch' }));
    gs.press('`');
    hk.setSuspended(true);
    assert.equal(gs.registered.has('`'), false);
    assert.equal(gs.registered.has('1'), false);
    hk.setSuspended(false);
    assert.ok(gs.registered.has('`'));
  });
});

describe('createHotkeys.pause', () => {
  test('pause releases everything; resume restores; focus changes while paused are ignored', () => {
    const gs = fakeShortcuts();
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    hk.apply(HK());
    hk.setSuspended(true);
    hk.pause(true);
    assert.equal(gs.registered.size, 0);
    hk.setSuspended(false);
    assert.equal(gs.registered.size, 0);
    hk.pause(false);
    assert.ok(gs.registered.has('F1'));
    assert.ok(gs.registered.has('1'), 'blurred while paused → track keys back on resume');
  });
});

// ─── icon manifest ────────────────────────────────────────────────────────────

describe('buildManifest', () => {
  const { buildManifest } = require('../scripts/build-icon-manifest');

  test('maps nodes/<tree>/<id>.<ext> and trees/<tree>.<ext>, prefers webp, skips bad names', () => {
    const dir = tmpDir();
    const touch = (rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), ''); };
    touch('nodes/es6ai/12.png');
    touch('nodes/es6ai/12.webp');
    touch('nodes/es6ai/007.jpg');
    touch('nodes/es6ai/notes.png');
    touch('nodes/es6ai/readme.txt');
    touch('trees/es6ai.png');
    const m = buildManifest(dir);
    assert.deepEqual(m.nodes, { 'es6ai/12': 'nodes/es6ai/12.webp', 'es6ai/7': 'nodes/es6ai/007.jpg' });
    assert.deepEqual(m.trees, { es6ai: 'trees/es6ai.png' });
    assert.deepEqual(m.skipped, ['nodes/es6ai/notes.png']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('missing folder yields an empty manifest', () => {
    assert.deepEqual(buildManifest(path.join(os.tmpdir(), 'does-not-exist-xyz')), { nodes: {}, trees: {}, skipped: [] });
  });
});
