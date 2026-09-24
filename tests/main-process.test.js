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
const { createHotkeys, LATCH_TIMEOUT_MS, REPEAT_GUARD_MS } = require('../electron/hotkeys');

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
      compactWindow: { width: 10, height: 'x', x: 40 },
      display: { uiScale: 9, opacity: 0.1, volume: 3, sound: 'yes', mode: 'tiny', theme: 'x' },
      hotkeys: { hotkeyMode: 'weird', undoModifier: 'Hyper', toggle: 5, legacyKey: 'F2', laneKeys: 'mouse' },
    });
    assert.equal(s.window.width, 420);
    assert.equal(s.window.height, DEFAULT_SETTINGS.window.height);
    assert.equal(s.window.x, null);
    assert.deepEqual(s.compactWindow, { x: 40, y: null, width: 260, height: DEFAULT_SETTINGS.compactWindow.height });
    assert.equal(s.display.uiScale, 1.6);
    assert.equal(s.display.opacity, 0.35);
    assert.equal(s.display.volume, 1);
    assert.equal(s.display.sound, true);
    assert.equal(s.display.mode, 'full');
    assert.equal('theme' in s.display, false);
    assert.equal(s.hotkeys.hotkeyMode, 'direct');
    assert.equal(s.hotkeys.undoModifier, 'Shift');
    assert.equal(s.hotkeys.toggle, 'F8');
    assert.equal('legacyKey' in s.hotkeys, false);
  });

  test('fresh install: F1–F6 lanes, show/hide F8, phases F9 / Shift+F9', () => {
    const { hotkeys } = mergeSettings({});
    assert.equal(hotkeys.laneKeys, 'fkeys');
    assert.deepEqual([hotkeys.toggle, hotkeys.phaseNextKey, hotkeys.phasePrevKey], ['F8', 'F9', 'Shift+F9']);
  });

  test('settings saved before lane keys existed stay on digits (no F1 clash with an old toggle)', () => {
    const old = { hotkeys: { enabled: true, hotkeyMode: 'direct', toggle: 'F1', phaseNextKey: 'F6', phasePrevKey: 'Shift+F6', advanceModifier: '', undoModifier: 'Shift', latchKey: '`' } };
    const s = mergeSettings(old);
    assert.equal(s.hotkeys.laneKeys, 'digits');
    assert.equal(s.hotkeys.toggle, 'F1');
    assert.equal(mergeSettings({ ...old, hotkeys: { ...old.hotkeys, laneKeys: 'numpad' } }).hotkeys.laneKeys, 'numpad');
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
// Classic layout (settings from before lane keys existed): bare digits, F1 / F6.
const DIGITS = (over = {}) => HK({ laneKeys: 'digits', toggle: 'F1', phaseNextKey: 'F6', phasePrevKey: 'Shift+F6', ...over });

describe('createHotkeys', () => {
  test('defaults: F1–F6 allocate, Shift+F1–F6 undo, F8 show/hide, F9 / Shift+F9 phases — digits stay free', () => {
    const gs = fakeShortcuts();
    const events = [];
    const hk = createHotkeys({ globalShortcut: gs, emit: e => events.push(e), toggleWindow() {}, log: quiet });
    assert.deepEqual(hk.apply(HK()), []);
    for (const k of ['F1', 'F6', 'Shift+F1', 'Shift+F6', 'F8', 'F9', 'Shift+F9']) assert.ok(gs.registered.has(k), k);
    assert.equal(gs.registered.has('1'), false, 'the game keeps its number keys');
    gs.press('F3');
    gs.press('Shift+F2');
    assert.deepEqual(events.map(e => [e.action, e.trackIndex]), [['advance', 2], ['undo', 1]]);
  });

  test('digits and numpad lane key sets', () => {
    const gs = fakeShortcuts();
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    assert.deepEqual(hk.apply(DIGITS()), []);
    for (const k of ['1', '6', 'Shift+1', 'Shift+6', 'F1', 'F6', 'Shift+F6']) assert.ok(gs.registered.has(k), k);
    assert.deepEqual(hk.apply(HK({ laneKeys: 'numpad', advanceModifier: 'Alt', undoModifier: 'Ctrl' })), []);
    for (const k of ['Alt+num1', 'Alt+num6', 'Ctrl+num1']) assert.ok(gs.registered.has(k), k);
  });

  test('a held key (auto-repeat) cannot burn through points; separate taps all count', () => {
    let t = 0;
    const gs = fakeShortcuts();
    const events = [];
    const hk = createHotkeys({ globalShortcut: gs, emit: e => events.push(e), toggleWindow() {}, log: quiet, now: () => t });
    hk.apply(HK());
    // Held F2: first press, first repeat after the OS delay, then a repeat every ~33 ms.
    for (const at of [0, 500, 533, 566, 600, 633, 666]) { t = at; gs.press('F2'); }
    assert.equal(events.length, 2, 'press + first repeat at most');
    // Four deliberate taps, ~200 ms apart.
    events.length = 0;
    for (const at of [2000, 2200, 2400, 2600]) { t = at; gs.press('F2'); }
    assert.equal(events.length, 4);
    // Different keys never block each other.
    events.length = 0;
    t = 3000; gs.press('F1'); t = 3010; gs.press('F4');
    assert.equal(events.length, 2);
    // Phase keys are guarded too: a held F9 must not cycle through phases.
    events.length = 0;
    for (const at of [4000, 4500, 4533, 4566]) { t = at; gs.press('F9'); }
    assert.ok(events.length <= 2 && events.every(e => e.action === 'phase'));
    assert.ok(REPEAT_GUARD_MS < 200, 'double-taps must still count');
  });

  test('focus suspends track keys (so typing works) and blur restores them', () => {
    const gs = fakeShortcuts();
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    hk.apply(DIGITS());
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
    hk.apply(DIGITS());
    hk.setSuspended(true);
    hk.apply(DIGITS({ undoModifier: 'Ctrl' }));
    assert.equal(gs.registered.has('1'), false);
    hk.setSuspended(false);
    assert.ok(gs.registered.has('Ctrl+1'));
  });

  test('bad or taken keys are reported without blocking the rest', () => {
    const gs = fakeShortcuts({ taken: ['F6'] });
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    const failed = hk.apply(DIGITS({ toggle: 'Bad+Key' }));
    assert.deepEqual(failed.sort(), ['Bad+Key', 'F6']);
    assert.ok(gs.registered.has('1') && gs.registered.has('Shift+F6'));
  });

  test('disabled registers nothing', () => {
    const gs = fakeShortcuts();
    const hk = createHotkeys({ globalShortcut: gs, emit() {}, toggleWindow() {}, log: quiet });
    hk.apply(DIGITS({ enabled: false }));
    assert.equal(gs.registered.size, 0);
  });

  test('latch mode: key arms 1–6, each use re-arms, timeout disarms', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gs = fakeShortcuts();
    const events = [];
    const hk = createHotkeys({ globalShortcut: gs, emit: e => events.push(e), toggleWindow() {}, log: quiet });
    hk.apply(DIGITS({ hotkeyMode: 'latch' }));
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
    hk.apply(DIGITS({ hotkeyMode: 'latch' }));
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
    hk.apply(DIGITS());
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

