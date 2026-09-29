/**
 * app/js/changes-dialog.js — "What's new": what changed in each version, for players.
 *
 *   By version — newest first: version, minor / patch badge, date, title, the features it
 *                touched, then one line per change (tagged with its feature).
 *   By feature — the same changes grouped by feature, each line tagged with its version:
 *                the history of one part of the app at a glance.
 *
 * Data: app/changelog.json via api.changelog(), shaped by shared/changelog.js. Versions
 * newer than the running app (written ahead of a release) never show.
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';

const { AREAS, releases, byArea } = window.Changelog;

const TYPE_LABEL = { first: 'First release', major: 'Major update', minor: 'Minor update', patch: 'Patch' };
const TYPE_HINT = {
  first: 'The first public version',
  major: 'Big changes — may change how things work',
  minor: 'New features',
  patch: 'Fixes and small improvements',
};

const formatDate = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null);

/**
 * @param {object} o
 * @param {HTMLDialogElement} o.dialog
 * @param {object} o.changelog        — app/changelog.json
 * @param {string} o.version          — the running app version
 * @param {string|null} [o.updatedFrom] — the version this start replaced (highlights what's new since)
 */
export function openChanges({ dialog, changelog, version, updatedFrom = null }) {
  if (dialog.open) return;
  const list = releases(changelog, { upTo: version });
  const groups = byArea(list);
  // After an update: the versions since the one the player had (all of them if unknown).
  const sinceIdx = updatedFrom && updatedFrom !== 'earlier' ? list.findIndex(r => r.version === updatedFrom) : -1;
  const isNew = (r) => !!updatedFrom && (sinceIdx < 0 ? r.current : list.indexOf(r) < sinceIdx);
  let view = 'version';
  const body = h('div.dialog-body.changes-body');

  const badge = (type) => h(`span.chg-type.is-${type}`, { title: TYPE_HINT[type] }, TYPE_LABEL[type]);
  const areaChip = (area) => h('span.chg-area', AREAS[area]);

  function versionView() {
    if (!list.length) return h('p.muted', 'No history yet.');
    return list.map(r => h('section.chg-release', { class: isNew(r) ? 'is-new' : '' },
      h('div.chg-head',
        h('span.chg-version', r.version),
        badge(r.type),
        r.current ? h('span.chg-mark', 'your version') : isNew(r) ? h('span.chg-mark', 'new for you') : null,
        r.date ? h('span.chg-date', formatDate(r.date)) : null),
      r.title ? h('div.chg-title', r.title) : null,
      h('ul.chg-list', r.changes.map(c => h('li', areaChip(c.area), h('span', c.text))))));
  }

  function featureView() {
    if (!groups.length) return h('p.muted', 'No history yet.');
    return groups.map(g => h('section.chg-feature',
      h('h3', g.label, h('span.chg-count', `${g.changes.length} change${g.changes.length !== 1 ? 's' : ''}`)),
      h('ul.chg-list', g.changes.map(c => h('li',
        h('span.chg-ver-tag', { title: TYPE_LABEL[c.type] }, c.version),
        h('span', c.text))))));
  }

  function paint() {
    mount(body, view === 'version' ? versionView() : featureView());
    tabs.querySelectorAll('.seg').forEach(b => {
      const on = b.dataset.view === view;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
    body.scrollTop = 0;
  }

  const seg = (key, label) => h('button.seg', { type: 'button', role: 'radio', dataset: { view: key }, onclick: () => { view = key; paint(); } }, label);
  const tabs = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Show changes' }, seg('version', 'By version'), seg('feature', 'By feature'));

  mount(dialog,
    h('div.dialog-card.dialog-changes',
      h('header.dialog-head',
        h('div',
          h('h2', 'What’s new'),
          h('div.muted', `You have version ${version}${updatedFrom && updatedFrom !== 'earlier' ? ` (updated from ${updatedFrom})` : ''}.`)),
        h('div.chg-head-right',
          tabs,
          h('button.btn-icon', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, ui('x', { size: 18 })))),
      body,
      h('footer.dialog-foot',
        h('div.dialog-status', 'Minor updates add features; patches fix things. Both install by themselves.'),
        h('div.dialog-foot-actions',
          h('button.btn.btn-primary', { type: 'button', onclick: () => dialog.close() }, 'Close'))),
    ),
  );
  paint();
  dialog.showModal();
}
