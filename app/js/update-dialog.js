/**
 * app/js/update-dialog.js
 * ────────────────────────
 * "Guide updated" review: what changed in the build's Maxroll guide since it
 * was loaded, phase by phase, and what that does to the player's progress.
 * Apply keeps every point on the unchanged part of each route (TreeUtils.mergeProgress);
 * Keep mine leaves the build as it is and stops offering this version.
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';

const pts = (n) => `${n} point${n === 1 ? '' : 's'}`;

/**
 * @param {object} o
 * @param {HTMLDialogElement} o.dialog
 * @param {object} o.update       — { planner: { name, author, date }, diff, missing }
 * @param {object|null} o.transition — mergeProgress().transition for the played phase
 * @param {number} o.currentPhase
 * @param {(t) => string} o.treeName  — display name for a diff entry
 * @param {(id) => string} o.masteryName
 * @param {() => void} o.onApply
 * @param {() => void} o.onKeep
 */
export function openUpdate({ dialog, update, transition, currentPhase, treeName, masteryName, onApply, onKeep }) {
  const { planner, diff, missing } = update;
  const close = () => dialog.close();

  function changeLine(c) {
    const name = treeName(c);
    if (c.common === c.before) return h('li', h('b', name), ` — ${pts(c.after - c.before)} added at the end`);
    if (c.common === c.after) return h('li', h('b', name), ` — last ${pts(c.before - c.after)} removed`);
    const total = c.before === c.after ? '' : ` (${c.before} → ${c.after} points)`;
    return h('li', h('b', name), ` — route changed after point ${c.common}${total}`);
  }

  function phaseBlock(p) {
    const lines = [
      p.masteryChange ? h('li', 'Mastery: ', h('b', masteryName(p.masteryChange.from)), ' → ', h('b', masteryName(p.masteryChange.to))) : null,
      ...p.changed.map(changeLine),
      ...p.added.map(t => h('li.is-add', h('b', treeName(t)), ` — new ${t.type === 'passive' ? 'tree' : 'skill'} (${pts(t.points)})`)),
      ...p.removed.map(t => h('li.is-remove', h('b', treeName(t)), ' — removed from the guide')),
    ].filter(Boolean);
    return h('section.up-phase', { class: lines.length ? '' : 'is-same' },
      h('div.up-phase-head', h('span.up-phase-name', p.name), p.index === currentPhase ? h('span.ld-chip', 'playing') : null,
        lines.length ? null : h('span.muted', 'no change')),
      lines.length ? h('ul.up-list', lines) : null);
  }

  const impact = transition?.unspecNeeded.length
    ? h('div.preview-warn', ui('alert', { size: 14 }),
      h('div', h('b', 'Respec needed in the phase you’re playing: '),
        transition.unspecNeeded.map(u => `${treeName(u)} ${u.isRemove ? '(remove from bar)' : `−${u.amount}`}`).join(' · '),
        '. The rest of your progress is kept.'))
    : h('div.up-ok', ui('check', { size: 14, stroke: 3 }), 'All your allocated points stay — the changes are ahead of you.');

  mount(dialog,
    h('div.dialog-card.dialog-update',
      h('header.dialog-head',
        h('div',
          h('h2', 'Guide updated'),
          h('div.muted', `“${planner.name}”${planner.author ? ` by ${planner.author}` : ''}${planner.date ? ` · saved ${planner.date.slice(0, 10)}` : ''}`)),
        h('button.btn-icon', { type: 'button', 'aria-label': 'Close', onclick: close }, ui('x', { size: 18 }))),
      h('div.dialog-body',
        impact,
        missing.length ? h('div.preview-warn', ui('alert', { size: 14 }), `Not in the guide any more (kept as is): ${missing.join(', ')}`) : null,
        diff.phases.map(phaseBlock)),
      h('footer.dialog-foot',
        h('div.dialog-foot-actions',
          h('button.btn.btn-ghost', { type: 'button', onclick: () => { close(); onKeep(); }, title: 'Don’t offer this version again' }, 'Keep my version'),
          h('button.btn.btn-primary', { type: 'button', onclick: () => { close(); onApply(); } }, ui('refresh', { size: 15 }), 'Apply update')))));
  dialog.showModal();
}
