/**
 * app/js/icons.js
 * ────────────────
 * Node / tree artwork + UI glyphs.
 *
 * Artwork comes straight from the game data: every node row carries `icon`, a
 * path relative to db/data/icons/ that extractor/extract.py has already checked
 * exists. A null icon — or a file that fails to load — falls back to a
 * generated glyph, so the UI never shows a broken image.
 */

import { h, svg } from './dom.js';

const ICON_BASE = '../db/data/icons/';

const iconUrl = (rel) => ICON_BASE + rel.split('/').map(encodeURIComponent).join('/');

// ─── Glyph placeholders ──────────────────────────────────────────────────────

function hash(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

function initials(name) {
  const words = String(name).replace(/[^\p{L}\p{N}\s'-]/gu, '').split(/\s+/)
    .filter(w => w && !/^(of|the|and|a|an|to|for|in|on)$/i.test(w));
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2);
  return (words[0][0] + words[1][0]);
}

// Placeholder hues skip the green band (95°–175°): green means "allocate now".
function glyphHue(seed) {
  const h = hash(seed) % 280;
  return h < 95 ? h : h + 80;
}

function glyph(seed, label) {
  const hue = glyphHue(seed);
  return h('span.glyph', { style: { '--glyph-hue': String(hue) }, 'aria-hidden': 'true' }, initials(label));
}

function art(icon, seed, label) {
  if (!icon) return glyph(seed, label);
  const img = h('img.art', { src: iconUrl(icon), alt: '', draggable: 'false', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(glyph(seed, label)), { once: true });
  return img;
}

/** Artwork for one step (ViewModel step: { icon, iconKey, name }). */
export function nodeArt(step) {
  return art(step.icon, step.iconKey, step.name);
}

/** Artwork for a whole tree (ViewModel lane: { treeIcon, treeId, title }). */
export function treeArt(lane) {
  return art(lane.treeIcon, `tree:${lane.treeId ?? lane.index}`, lane.title);
}

// ─── UI glyphs (24×24 stroke paths) ──────────────────────────────────────────

const UI = {
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  ],
  pin: ['M12 17v5', 'M9 10.76V6h6v4.76l2.2 2.2A1 1 0 0 1 16.5 14.7H7.5a1 1 0 0 1-.7-1.74Z', 'M8 2h8'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  chevronLeft: ['M15 18l-6-6 6-6'],
  chevronRight: ['M9 18l6-6-6-6'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  alert: ['M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z', 'M12 9v4', 'M12 17h.01'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 16v-4', 'M12 8h.01'],
  keyboard: ['M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z', 'M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 17h8'],
  save: ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z', 'M17 21v-8H7v8', 'M7 3v5h8'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  target: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z', 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'],
  shrink: ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7'],
  expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  volume: ['M11 5 6 9H2v6h4l5 4V5Z', 'M15.54 8.46a5 5 0 0 1 0 7.07', 'M19.07 4.93a10 10 0 0 1 0 14.14'],
  sparkles: ['M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.4l-1.9-5.8L4 10.7l6.1-1.9Z'],
};

export function ui(name, opts) {
  return svg(UI[name] ?? UI.info, opts);
}
