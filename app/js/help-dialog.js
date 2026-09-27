/**
 * app/js/help-dialog.js — the shortcut sheet (`?`), built from the current key settings.
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';
import { keycap } from './lanes.js';

const { laneKeyLabel, laneKey, prettyAccelerator, LANE_KEYSET_LABELS } = window.HotkeyScheme;

/**
 * @param {object} o
 * @param {HTMLDialogElement} o.dialog
 * @param {object} o.hotkeys          — settings.hotkeys
 * @param {() => void} o.onOpenSettings
 */
export function openHelp({ dialog, hotkeys: hk, onOpenSettings }) {
  if (dialog.open) return;
  const k = (acc) => acc.split('+').map((p, i) => [i ? h('span.plus', '+') : null, keycap(prettyAccelerator(p), 'key-sm')]);
  const row = (keys, label) => h('div.help-row', h('span.help-keys', keys), h('span.help-label', label));
  const lanes = (kind) => [k(laneKeyLabel(hk, 0, kind).replace(/ /g, '')), h('span.dash', '–'), k(prettyAccelerator(laneKey(hk, 5)).replace(/ /g, ''))];

  const inGame = hk.enabled
    ? [
      hk.hotkeyMode === 'latch' ? row(k(hk.latchKey), 'Arm the lane keys for 5 s') : null,
      row(lanes('adv'), 'Allocate the next point in lane 1–6'),
      row(lanes('undo'), 'Undo the last point in that lane'),
      hk.phaseNextKey ? row(k(hk.phaseNextKey), 'Next phase') : null,
      hk.phasePrevKey ? row(k(hk.phasePrevKey), 'Previous phase') : null,
      hk.toggle ? row(k(hk.toggle), 'Show / hide this window') : null,
    ]
    : [h('p.help-off', 'Global hotkeys are off — turn them on in Settings to allocate without leaving the game.')];

  const inApp = [
    row([keycap('1', 'key-sm'), h('span.dash', '–'), keycap('6', 'key-sm'), hk.laneKeys !== 'digits' ? [h('span.help-or', 'or'), keycap(LANE_KEYSET_LABELS[hk.laneKeys], 'key-sm')] : null], 'Allocate (Shift = undo)'),
    row(k('Ctrl+1'), 'Fill: every remaining point of the step (Ctrl+1–6)'),
    row(k('Ctrl+Z'), 'Undo the last change, in any tree'),
    row([keycap('↑', 'key-sm'), keycap('↓', 'key-sm')], 'Focus a tree'),
    row([keycap('←', 'key-sm'), keycap('→', 'key-sm')], 'Browse its steps'),
    row([keycap('Enter', 'key-sm')], 'Allocate in the focused tree'),
    row(k('PageDown'), 'Next phase (PageUp: previous)'),
    row(k('Ctrl+M'), 'Mini mode ↔ full window'),
    row(k('Ctrl+O'), 'Load build'),
    row(k('Ctrl+,'), 'Settings'),
    row([keycap('Ctrl', 'key-sm'), h('span.plus', '+'), keycap('+', 'key-sm'), keycap('−', 'key-sm')], 'Interface size'),
  ];

  mount(dialog,
    h('div.dialog-card.dialog-help',
      h('header.dialog-head',
        h('h2', 'Shortcuts'),
        h('button.btn-icon', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, ui('x', { size: 18 }))),
      h('div.dialog-body',
        h('section.dialog-section', h('h3', 'While playing'), inGame),
        h('section.dialog-section', h('h3', 'In this window'), inApp)),
      h('footer.dialog-foot',
        h('div.dialog-status'),
        h('div.dialog-foot-actions',
          h('button.btn.btn-secondary', { type: 'button', onclick: () => { dialog.close(); onOpenSettings(); } }, ui('gear', { size: 15 }), 'Change keys'),
          h('button.btn.btn-primary', { type: 'button', onclick: () => dialog.close() }, 'Got it'))),
    ),
  );
  dialog.showModal();
}
