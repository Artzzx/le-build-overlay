/**
 * app/js/mini.js
 * ───────────────
 * Mini mode (display.mode = 'compact'): a small always-on-top window parked in
 * a corner over the game. One row per tree — key · art · NEXT node · points —
 * and nothing else. Completed trees collapse to a single dimmed line so the
 * rows that still need attention stay on top of the eye path.
 *
 * Click a row to allocate, right-click to undo (same as the lane keys).
 */

import { h } from './dom.js';
import { ui } from './icons.js';
import { nodeTile, keycap, laneAccent } from './lanes.js';

/**
 * @param {object} lane — ViewModel lane
 * @param {object} o    — { keyLabel, focused, onAllocate, onUndo }
 */
export function renderMiniLane(lane, { keyLabel, focused, onAllocate, onUndo }) {
  const cls = ['mini-lane'];
  if (focused) cls.push('is-focused');
  if (lane.complete) cls.push('is-complete');
  if (lane.unresolved) cls.push('is-unresolved');

  const onContext = (e) => { e.preventDefault(); onUndo(); };
  const shell = (label, ...children) => h(`section.${cls.join('.')}`, {
    dataset: { lane: lane.index },
    style: { '--accent': laneAccent(lane), '--pct': lane.pct.toFixed(4) },
  }, h('button.mini-hit', {
    type: 'button',
    title: 'Click: allocate · Right-click: undo',
    'aria-label': label,
    onclick: onAllocate,
    oncontextmenu: onContext,
  }, keycap(keyLabel, 'key-lane'), ...children));

  if (lane.unresolved) {
    return shell(`${lane.title}: no tree data`,
      h('span.mini-state', ui('alert', { size: 14 })),
      h('span.mini-text', h('span.mini-name', lane.title), h('span.mini-sub', 'No tree data')));
  }

  if (lane.complete) {
    return shell(`${lane.title}: complete`,
      h('span.mini-state', ui('check', { size: 14, stroke: 3 })),
      h('span.mini-text', h('span.mini-name', lane.title)),
      h('span.mini-count', `${lane.total} pts`));
  }

  const { now, next } = lane;
  const multi = now.count > 1;
  return shell(`Allocate ${now.name} in ${lane.title}`,
    nodeTile(now, { size: 'sm', badge: false }),
    h('span.mini-text',
      h('span.mini-name', { title: now.name }, now.name),
      h('span.mini-sub', lane.title, next ? [h('span.mini-then', ' → '), next.name] : ' · last node')),
    h('span.mini-count', { class: multi ? 'is-multi' : '' }, multi ? `${now.pointsDone}/${now.count}` : '+1'),
  );
}
