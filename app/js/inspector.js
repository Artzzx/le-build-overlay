/**
 * app/js/inspector.js
 * ────────────────────
 * Detail panel for one step: artwork, name, what this step allocates, the
 * in-game description and per-point stats. Follows the focused lane's NEXT UP
 * node unless the user hovers or pins another step.
 */

import { h, richText } from './dom.js';
import { ui } from './icons.js';
import { nodeTile, laneAccent, keycap } from './lanes.js';

const STATE_LABEL = { done: 'Allocated', current: 'Next up', upcoming: 'Upcoming' };

function pips(filledBefore, adding, max) {
  if (!max || max > 12) return null;
  const out = [];
  for (let i = 0; i < max; i++) {
    const cls = i < filledBefore ? 'pip is-have' : i < filledBefore + adding ? 'pip is-add' : 'pip';
    out.push(h(`span.${cls.replace(/ /g, '.')}`));
  }
  return h('span.pips', { 'aria-hidden': 'true' }, out);
}

const ROUTE_BEFORE = 2;
const ROUTE_SIZE = 9;

/** Readable list of the steps around the inspected one — names, not just icons. */
function route(lane, inspected, onPick) {
  const anchor = inspected.idx;
  const start = Math.max(0, Math.min(anchor - ROUTE_BEFORE, lane.steps.length - ROUTE_SIZE));
  const rows = lane.steps.slice(start, start + ROUTE_SIZE);
  const rest = lane.steps.length - (start + rows.length);
  return h('div.route',
    h('div.route-head', h('div.insp-section-title', `Route · ${lane.title}`), h('span.muted', `${lane.done} / ${lane.total} pts`)),
    rows.map(st => h('button.route-row', {
      type: 'button',
      class: [`is-${st.state}`, st.idx === anchor ? 'is-inspected' : ''].join(' '),
      title: st.name,
      onclick: () => onPick(lane.index, st.idx),
    },
    h('span.route-n', st.idx + 1),
    nodeTile(st, { size: 'sm', badge: false }),
    h('span.route-name', st.name),
    h('span.route-count', st.state === 'done' ? '✓' : `×${st.count}`))),
    rest > 0 ? h('div.route-more', `+${rest} more step${rest > 1 ? 's' : ''}`) : null,
  );
}

/**
 * @param {object|null} ctx — { lane, step, mode: 'next'|'hover'|'pinned' } or null
 * @param {object} actions — { onSetCurrent(laneIdx, stepIdx), onUnpin(), onPick(laneIdx, stepIdx) }
 */
export function renderInspector(ctx, actions) {
  if (!ctx?.step) {
    return h('div.inspector-empty',
      ui('target', { size: 28, stroke: 1.5 }),
      h('p', 'Hover or click any node to see what it does.'),
    );
  }

  const { lane, step, mode } = ctx;
  const before = step.nodeTotalAfter - step.count;
  const eyebrow = mode === 'next' ? `Next up · ${lane.title}` : `${STATE_LABEL[step.state]} · ${lane.title}`;

  const statRows = step.stats.filter(s => s.statName).map(s =>
    h('div.stat-row', h('span.stat-name', s.statName), h('span.stat-value', s.value || '✓')));

  return h('div.inspector-body', { style: { '--accent': laneAccent(lane) } },
    h('div.insp-eyebrow', keycap(String(lane.hotkey), 'key-sm'), h('span', eyebrow)),

    h('div.insp-hero',
      nodeTile(step, { size: 'xl', badge: false }),
      h('div.insp-hero-text',
        h('h2.insp-name', step.name),
        h('div.insp-sub', `Step ${step.idx + 1} of ${lane.steps.length}`,
          h('span.chip', { class: `chip-${step.state}` }, STATE_LABEL[step.state])),
      ),
    ),

    h('div.insp-points',
      h('div.insp-points-line',
        h('b', `+${step.count} point${step.count > 1 ? 's' : ''}`),
        step.maxPoints ? h('span', ` → ${step.nodeTotalAfter} / ${step.maxPoints} in node`) : null,
      ),
      pips(before, step.count, step.maxPoints),
    ),

    step.description
      ? h('p.insp-desc', richText(step.description))
      : h('p.insp-desc.is-empty', step.known ? 'No description in the game data.' : 'This node is missing from the game data.'),

    statRows.length ? h('div.insp-stats', h('div.insp-section-title', 'Per point'), statRows) : null,

    h('div.insp-actions',
      step.state !== 'current'
        ? h('button.btn.btn-secondary', {
          type: 'button',
          title: 'Mark every step before this one as allocated and make this the next step',
          onclick: () => actions.onSetCurrent(lane.index, step.idx),
          disabled: lane.unresolved,
        }, ui('target', { size: 15 }), 'Start from here')
        : null,
      mode === 'pinned' && step.state !== 'current'
        ? h('button.btn.btn-ghost', { type: 'button', onclick: actions.onUnpin }, 'Back to next up', h('kbd.key.key-sm', 'Esc'))
        : null,
    ),

    route(lane, step, actions.onPick),
  );
}
