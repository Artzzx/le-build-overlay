/**
 * tests/hotkey-scheme.test.js
 * ────────────────────────────
 * shared/hotkey-scheme.js — lane keys, labels, conflicts, in-app key mapping.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../shared/hotkey-scheme');
const { DEFAULT_SETTINGS } = require('../electron/store');

const HK = (over = {}) => ({ ...DEFAULT_SETTINGS.hotkeys, ...over });

describe('trackAccelerators', () => {
  test('one entry per lane for each key set', () => {
    assert.deepEqual(S.trackAccelerators(HK())[1], { trackIndex: 1, adv: 'F2', undo: 'Shift+F2' });
    assert.deepEqual(S.trackAccelerators(HK({ laneKeys: 'digits' }))[5], { trackIndex: 5, adv: '6', undo: 'Shift+6' });
    assert.deepEqual(S.trackAccelerators(HK({ laneKeys: 'numpad', advanceModifier: 'Alt' }))[0], { trackIndex: 0, adv: 'Alt+num1', undo: 'Shift+num1' });
    assert.equal(S.trackAccelerators(HK()).length, S.LANE_COUNT);
  });

  test('undo identical to allocate is dropped', () => {
    assert.equal(S.trackAccelerators(HK({ undoModifier: '' }))[0].undo, null);
  });
});

describe('labels', () => {
  test('laneKeyLabel is short and readable', () => {
    assert.equal(S.laneKeyLabel(HK(), 1), 'F2');
    assert.equal(S.laneKeyLabel(HK(), 1, 'undo'), 'Shift+F2');
    assert.equal(S.laneKeyLabel(HK({ laneKeys: 'numpad' }), 2), 'Num 3');
    assert.equal(S.laneKeyLabel(HK({ laneKeys: 'digits', advanceModifier: 'Alt' }), 0), 'Alt+1');
    assert.equal(S.prettyAccelerator(''), '—');
  });
});

describe('hotkeyConflicts', () => {
  test('defaults have no conflicts', () => {
    assert.deepEqual(S.hotkeyConflicts(HK()), []);
    assert.deepEqual(S.hotkeyConflicts(HK({ laneKeys: 'digits' })), []);
  });

  test('old F1 toggle with F-key lanes is a conflict', () => {
    const c = S.hotkeyConflicts(HK({ toggle: 'F1' }));
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].actions, ['Allocate lane 1', 'Show / hide']);
  });

  test('comparison ignores case and modifier order', () => {
    const c = S.hotkeyConflicts(HK({ laneKeys: 'digits', advanceModifier: 'Alt', undoModifier: 'Ctrl', phaseNextKey: 'ctrl+3' }));
    assert.deepEqual(c.map(x => x.actions), [['Undo lane 3', 'Next phase']]);
    assert.equal(S.normalize('Shift+Control+F2'), S.normalize('ctrl+shift+f2'));
  });

  test('latch key only counts in latch mode; nothing when disabled', () => {
    assert.deepEqual(S.hotkeyConflicts(HK({ latchKey: 'F8' })), []);
    assert.equal(S.hotkeyConflicts(HK({ hotkeyMode: 'latch', latchKey: 'F8' })).length, 1);
    assert.deepEqual(S.hotkeyConflicts(HK({ enabled: false, toggle: 'F1' })), []);
  });
});

describe('laneFromCode', () => {
  test('maps the configured lane keys, not the others', () => {
    assert.equal(S.laneFromCode(HK(), 'F3'), 2);
    assert.equal(S.laneFromCode(HK(), 'F7'), -1);
    assert.equal(S.laneFromCode(HK(), 'Numpad3'), -1);
    assert.equal(S.laneFromCode(HK({ laneKeys: 'numpad' }), 'Numpad6'), 5);
    assert.equal(S.laneFromCode(HK({ laneKeys: 'digits' }), 'F3'), -1);
  });
});
