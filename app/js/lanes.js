/**
 * app/js/lanes.js
 * ────────────────
 * One lane per tree: identity (hotkey, tree, progress) · NOW card (the point to
 * allocate next, big and readable) · path strip (every step in order, like the
 * game's allocation history bar).
 *
 * The NOW column sits at the same x-position in every lane so the player can
 * read "what's next" for all six trees in one vertical glance.
 */

import { h } from './dom.js';
import { nodeArt, treeArt, ui } from './icons.js';

// Slot 0 = passive gold; slots 1–5 = distinct skill hues. A lane's slot comes
// from ViewModel.colorSlots, so a skill keeps its colour in every phase.
const ACCENTS = ['#e3b55b', '#5ba8ff', '#b48cff', '#34cfc0', '#ff7eb3', '#ffa35c'];
export const laneAccent = (lane) => ACCENTS[(lane.colorSlot ?? lane.index) % ACCENTS.length];

// ─── Pieces ───────────────────────────────────────────────────────────────────

export function keycap(label, extra = '') {
  return h(`kbd.key${extra ? '.' + extra : ''}`, label);
}

/** Node tile: artwork + state ring + count badge. Used by the strip, NOW card and inspector. */
export function nodeTile(step, { size = 'md', badge = true } = {}) {
  const progress = step.count ? step.pointsDone / step.count : 0;
  return h(`span.tile.tile-${size}.is-${step.state}`, { style: { '--p': progress.toFixed(3) } },
    h('span.tile-art', nodeArt(step.iconKey, step.name)),
    step.state === 'done' ? h('span.tile-check', ui('check', { size: 12, stroke: 3 })) : null,
    badge && step.count > 1 ? h('span.tile-badge', `×${step.count}`) : null,
  );
}

function progressBar(pct) {
  return h('span.bar', { role: 'presentation' }, h('span.bar-fill', { style: { width: `${(pct * 100).toFixed(1)}%` } }));
}

// ─── Lane sections ────────────────────────────────────────────────────────────

function identity(lane, hotkeyLabel) {
  return h('div.lane-id',
    h('div.lane-id-top',
      keycap(hotkeyLabel, 'key-lane'),
      h('span.tree-art', treeArt(lane.treeId ?? `lane-${lane.index}`, lane.title)),
      h('div.lane-titles',
        h('div.lane-title', { title: lane.title }, lane.title),
        h('div.lane-sub', lane.subtitle),
      ),
    ),
    h('div.lane-progress',
      h('span.lane-count', h('b', lane.done), ` / ${lane.total} pts`),
      h('span.lane-pct', lane.complete ? 'Done' : `${Math.round(lane.pct * 100)}%`),
      progressBar(lane.pct),
    ),
  );
}

function nowMeta(step) {
  const parts = [step.count > 1 ? `Point ${step.pointsDone + 1} of ${step.count}` : '1 point'];
  if (step.maxPoints) {
    const inNodeAfterPoint = step.nodeTotalAfter - step.count + step.pointsDone + 1;
    parts.push(`node ${inNodeAfterPoint}/${step.maxPoints}`);
  }
  return parts.join(' · ');
}

function nowCard(lane, { hotkeyLabel, onAllocate, onUndo, onSelect }) {
  const undo = h('button.btn-icon.btn-undo', {
    type: 'button',
    title: `Undo last point (Shift+${hotkeyLabel})`,
    'aria-label': `Undo last point in ${lane.title}`,
    disabled: lane.unresolved || lane.done === 0,
    onclick: onUndo,
  }, ui('undo', { size: 16 }));

  if (lane.unresolved) {
    return h('div.lane-now.now-missing',
      h('div.now-label', ui('alert', { size: 13 }), 'No tree data'),
      h('div.now-body',
        h('div.now-text',
          h('div.now-name.now-name-sm', `“${lane.treeId}” isn't in the game data`),
          h('div.now-meta', 'Regenerate the data files — see README › Game Data'),
        ),
      ),
    );
  }

  if (lane.complete) {
    return h('div.lane-now.now-complete',
      h('div.now-label', ui('check', { size: 13, stroke: 3 }), 'Tree complete'),
      h('div.now-body',
        h('div.now-text',
          h('div.now-name.now-name-sm', `All ${lane.total} points allocated`),
          h('div.now-meta', lane.steps.length ? `Last: ${lane.steps[lane.steps.length - 1].name}` : ''),
        ),
        h('div.now-actions', undo),
      ),
    );
  }

  const { now, next } = lane;
  return h('div.lane-now',
    h('div.now-label', h('span.pulse'), 'Next up'),
    h('div.now-body',
      h('button.now-tile', {
        type: 'button', title: 'Show details', 'aria-label': `Details for ${now.name}`,
        onclick: () => onSelect(now.idx),
      }, nodeTile(now, { size: 'lg', badge: false })),
      h('div.now-text',
        h('div.now-name', { title: now.name }, now.name),
        h('div.now-meta', nowMeta(now)),
        h('div.now-then', next
          ? [h('span.then-label', 'Then'), ui('arrowRight', { size: 12 }), h('span.then-name', next.name), next.count > 1 ? h('span.then-count', `×${next.count}`) : null]
          : h('span.then-label', 'Last node in this tree')),
      ),
      h('div.now-actions',
        h('button.btn-allocate', {
          type: 'button',
          title: `Allocate this point (${hotkeyLabel})`,
          'aria-label': `Allocate ${now.name}`,
          onclick: onAllocate,
        }, ui('plus', { size: 18, stroke: 2.5 }), h('span.btn-allocate-label', 'Allocate')),
        undo,
      ),
    ),
  );
}

function pathStrip(lane, { selectedIdx, onSelect, onHover }) {
  const nextIdx = lane.now ? lane.now.idx + 1 : -1;
  const items = lane.steps.map((step) => {
    const cls = ['step', `is-${step.state}`];
    if (step.idx === nextIdx) cls.push('is-next');
    if (step.idx === selectedIdx) cls.push('is-selected');
    return h(`li.${cls.join('.')}`, { dataset: { step: step.idx } },
      h('button.step-btn', {
        type: 'button',
        title: `${step.name}${step.count > 1 ? ` ×${step.count}` : ''}`,
        'aria-label': `Step ${step.idx + 1}: ${step.name}, ${step.count} point${step.count > 1 ? 's' : ''}, ${step.state}`,
        onclick: () => onSelect(step.idx),
        onmouseenter: () => onHover(step.idx),
        onfocus: () => onHover(step.idx),
      }, nodeTile(step)),
    );
  });

  const strip = h('ol.strip', items);
  const scroller = h('div.lane-path', {
    onmouseleave: () => onHover(null),
    // Mouse wheel scrolls the strip sideways.
    onwheel: (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scroller.scrollWidth > scroller.clientWidth) {
        scroller.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
  }, strip);
  return scroller;
}

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * @param {object} lane   — from ViewModel.buildLane
 * @param {object} opts   — { focused, selectedIdx, hotkeyLabel, onAllocate, onUndo, onSelect, onHover, onFocus }
 */
export function renderLane(lane, opts) {
  const cls = ['lane'];
  if (opts.focused) cls.push('is-focused');
  if (lane.complete) cls.push('is-complete');
  if (lane.unresolved) cls.push('is-unresolved');

  return h(`section.${cls.join('.')}`, {
    dataset: { lane: lane.index },
    style: { '--accent': laneAccent(lane) },
    'aria-label': `${lane.title}: ${lane.done} of ${lane.total} points`,
    onpointerdown: () => opts.onFocus(),
  },
    identity(lane, opts.hotkeyLabel),
    nowCard(lane, opts),
    pathStrip(lane, opts),
  );
}

/**
 * Scroll a lane's strip so the current step sits near the left third, with the
 * last couple of completed steps still visible for context.
 */
export function revealCurrent(laneEl, { smooth = true, stepIdx = null } = {}) {
  const scroller = laneEl?.querySelector('.lane-path');
  if (!scroller) return;
  const target = stepIdx != null
    ? scroller.querySelector(`[data-step="${stepIdx}"]`)
    : scroller.querySelector('.step.is-current') ?? scroller.querySelector('.step:last-child');
  if (!target) return;
  const left = target.offsetLeft - scroller.clientWidth * 0.28;
  scroller.scrollTo({ left: Math.max(0, left), behavior: smooth ? 'smooth' : 'auto' });
}

