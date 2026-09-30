/**
 * app/js/profile-menu.js
 * ───────────────────────
 * Character menu (the name button in the top bar): switch between character
 * profiles, make a new one, rename or delete the active one, and check its
 * Maxroll guide for updates. Each profile keeps its own build and progress.
 *
 * A modal <dialog> anchored under the button: Esc and a click outside close it,
 * and while it's open the app's own shortcuts are off (main.js ignores keys
 * while any dialog is open).
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';

/**
 * @param {object} o
 * @param {HTMLElement} o.anchor
 * @param {{ id, name, buildName, classId, masteryId }[]} o.profiles
 * @param {string} o.activeId
 * @param {(p) => string} o.describe        — "Rogue · Bladedancer" for a profile
 * @param {boolean} o.canCheckUpdate        — the active build came from Maxroll
 * @param {(id) => void} o.onSwitch
 * @param {() => void} o.onCreate
 * @param {(id, name) => void} o.onRename
 * @param {(id) => void} o.onDelete
 * @param {() => void} o.onCheckUpdate
 * @param {boolean} o.canShare            — the active character has a build
 * @param {() => void} o.onShare          — copy its share code
 * @param {boolean} o.canClear            — the active build has progress to clear
 * @param {() => void} o.onClear          — full clear (asks for confirmation itself)
 */
export function openProfileMenu(o) {
  const dlg = h('dialog.menu-pop', { 'aria-label': 'Characters' });
  document.body.append(dlg);
  const close = () => { if (dlg.open) dlg.close(); };
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  // Clicks on the backdrop hit the dialog element itself.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });

  const active = o.profiles.find(p => p.id === o.activeId);
  const run = (fn) => () => { close(); fn(); };

  function listView() {
    return [
      h('div.menu-head', 'Characters'),
      h('div.menu-list', { role: 'menu' }, o.profiles.map(p => {
        const on = p.id === o.activeId;
        return h('button.menu-item', {
          type: 'button', role: 'menuitemradio', 'aria-checked': String(on),
          class: on ? 'is-active' : '',
          onclick: on ? close : run(() => o.onSwitch(p.id)),
        },
        h('span.menu-check', on ? ui('check', { size: 14, stroke: 3 }) : null),
        h('span.menu-text',
          h('span.menu-name', p.name),
          h('span.menu-sub', p.buildName ? [p.buildName, o.describe(p) ? ` · ${o.describe(p)}` : ''] : 'No build loaded')));
      })),
      h('div.menu-sep'),
      h('button.menu-item.menu-action', { type: 'button', onclick: run(o.onCreate) }, ui('plus', { size: 15 }), 'New character'),
      h('button.menu-item.menu-action', { type: 'button', onclick: run(o.onShare), disabled: !o.canShare, title: 'Copy a code that anyone can paste in Load build › From a share code' },
        ui('share', { size: 15 }), 'Share this build'),
      o.canCheckUpdate
        ? h('button.menu-item.menu-action', { type: 'button', onclick: run(o.onCheckUpdate) }, ui('refresh', { size: 15 }), 'Check the guide for updates')
        : null,
      h('button.menu-item.menu-action', { type: 'button', onclick: run(o.onClear), disabled: !o.canClear, title: 'Every phase back to 0 (Ctrl+Shift+Delete)' },
        ui('undo', { size: 15 }), 'Clear all progress', h('kbd.key.key-sm.menu-kbd', 'Ctrl Shift Del')),
      h('button.menu-item.menu-action', { type: 'button', onclick: () => paint(renameView) }, ui('edit', { size: 15 }), `Rename “${active?.name ?? ''}”`),
      o.profiles.length > 1
        ? h('button.menu-item.menu-action.is-danger', {
          type: 'button',
          onclick: () => {
            if (confirm(`Delete “${active?.name}” and its progress? This can’t be undone.`)) run(() => o.onDelete(o.activeId))();
          },
        }, ui('trash', { size: 15 }), `Delete “${active?.name ?? ''}”`)
        : null,
    ];
  }

  function renameView() {
    const input = h('input.input', { type: 'text', maxlength: 40, value: active?.name ?? '', 'aria-label': 'Character name' });
    const save = () => { const name = input.value.trim(); if (name) run(() => o.onRename(o.activeId, name))(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return [
      h('div.menu-head', 'Rename character'),
      h('div.menu-form', input,
        h('div.menu-form-actions',
          h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => paint(listView) }, 'Back'),
          h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: save }, 'Save'))),
    ];
  }

  function paint(view) { mount(dlg, h('div.menu-card', view())); }

  paint(listView);
  dlg.showModal();
  // Under the anchor, kept inside the window.
  const r = o.anchor.getBoundingClientRect();
  const w = dlg.offsetWidth;
  dlg.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  dlg.style.top = `${r.bottom + 6}px`;
  dlg.querySelector('.menu-item.is-active, .menu-item')?.focus();
}
