/**
 * app/js/loadout-dialog.js
 * ─────────────────────────
 * "Load build" dialog (Ctrl+O): paste export codes for 1–5 phases, see each
 * phase validated live (class, points, skills recognised), optionally save the
 * raw inputs as a template, then load. Loading resets progress to 0.
 *
 * "From Maxroll": paste a planner link → main fetches it (api.fetchMaxroll) →
 * pick variants → each fills a phase tab with its Export-shaped JSON, so the
 * rest of the flow (live preview, templates, load) is unchanged.
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';

const MAX_PHASES = 5;
const PREVIEW_DELAY_MS = 250;

const HELP = [
  'Easiest: paste the Maxroll planner link above and pick its variants.',
  'Or in the Maxroll planner, open your build and use Export — copy every line.',
  'Or in game: export the Passives tab, then each Skill tab, and paste each code on its own line.',
  'Add a phase per stage of the guide (e.g. Leveling → Endgame). Progress carries over where trees overlap.',
];

/**
 * @param {object} o
 * @param {HTMLDialogElement} o.dialog
 * @param {object} o.api            — window.api
 * @param {boolean} o.hasProgress   — current build has allocated points (show replace warning)
 * @param {(build) => void} o.onLoaded
 */
export function openLoadout({ dialog, api, hasProgress, onLoaded }) {
  let name = '';
  let phases = [];
  let active = 0;
  let busy = false;
  let templates = [];
  // Maxroll import state
  const mx = { link: '', busy: false, error: null, canOpen: false, planner: null, selected: new Set(), used: false };
  let source = null; // { maxroll: id } once variants from a planner fill the phases

  const newPhase = (n = phases.length + 1) => ({ name: '', json: '', preview: null, error: null, pending: false, placeholder: n === 1 ? 'Leveling' : n === 2 ? 'Endgame' : `Phase ${n}` });
  phases.push(newPhase(1));

  const body = h('div.dialog-body.loadout-body');
  const status = h('div.dialog-status', { role: 'status' });
  const loadBtn = h('button.btn.btn-primary', { type: 'button', onclick: onLoad }, ui('upload', { size: 16 }), 'Load build');
  const saveTplBtn = h('button.btn.btn-secondary', { type: 'button', onclick: onSaveTemplate }, ui('save', { size: 15 }), 'Save as template');

  const setStatus = (msg, kind = 'error') => { status.className = `dialog-status is-${kind}`; status.textContent = msg; };

  // ─── Validation ─────────────────────────────────────────────────────────────

  const timers = new WeakMap();
  function schedulePreview(phase) {
    clearTimeout(timers.get(phase));
    phase.preview = null;
    phase.error = null;
    phase.pending = !!phase.json.trim();
    timers.set(phase, setTimeout(async () => {
      const json = phase.json;
      if (!json.trim()) { phase.pending = false; return paintState(); }
      const res = await api.previewPhase(json);
      if (json !== phase.json) return; // stale
      phase.pending = false;
      if (res.ok) phase.preview = res.summary;
      else phase.error = res.error;
      paintState();
    }, PREVIEW_DELAY_MS));
    paintState();
  }

  function problems() {
    const out = [];
    phases.forEach((p, i) => {
      const label = p.name || p.placeholder;
      if (!p.json.trim()) out.push(`${label}: paste export codes`);
      else if (p.error) out.push(`${label}: ${p.error}`);
    });
    // Same class in every phase; the mastery may change (e.g. plain Rogue while leveling, then Bladedancer).
    const classes = new Set(phases.map(p => p.preview?.className).filter(Boolean));
    if (classes.size > 1) out.push(`All phases must be the same class (found ${[...classes].join(' and ')})`);
    return out;
  }

  const ready = () => phases.every(p => p.preview && !p.pending) && problems().length === 0;

  // ─── Rendering ──────────────────────────────────────────────────────────────

  function phaseDot(p) {
    if (p.pending) return h('span.dot.is-pending', { title: 'Checking…' });
    if (p.error) return h('span.dot.is-error', { title: 'Has a problem' });
    if (p.preview) return h('span.dot.is-ok', { title: 'Looks good' });
    return h('span.dot', { title: 'Empty' });
  }

  function previewBlock(p) {
    if (p.pending) return h('div.preview.is-pending', h('span.spinner'), 'Checking…');
    if (p.error) return h('div.preview.is-error', ui('alert', { size: 16 }), h('div', h('b', 'Can’t read this yet. '), p.error));
    if (!p.preview) return h('div.preview.is-empty', ui('info', { size: 16 }), 'Paste your export codes above — each code on its own line.');
    const s = p.preview;
    const unknown = s.skills.filter(k => !k.known);
    return h('div.preview.is-ok',
      h('div.preview-head', ui('check', { size: 16, stroke: 3 }), h('b', s.classLabel), h('span.muted', ` · ${s.passivePoints} passive points`)),
      h('div.preview-skills', s.skills.length
        ? s.skills.map(k => h('span.skill-chip', { class: k.known ? '' : 'is-unknown', title: k.known ? k.key : `“${k.key}” is not in the game data` }, k.name, h('span.muted', k.points)))
        : h('span.muted', 'No skill trees in this phase')),
      unknown.length ? h('div.preview-warn', ui('alert', { size: 14 }), `${unknown.length} skill${unknown.length > 1 ? 's' : ''} not in the game data — ${unknown.length > 1 ? 'they' : 'it'} will show as “No tree data”.`) : null,
      s.passiveMismatch ? h('div.preview-warn', ui('alert', { size: 14 }), s.passiveMismatch) : null,
    );
  }

  let previewSlot = null;
  let tabsSlot = null;

  function paintState() {
    if (tabsSlot) mount(tabsSlot, tabs());
    if (previewSlot) mount(previewSlot, previewBlock(phases[active]));
    const issues = problems();
    loadBtn.disabled = busy || !ready();
    saveTplBtn.disabled = busy || phases.every(p => !p.json.trim());
    if (issues.length && phases.some(p => p.json.trim())) setStatus(issues[0], phases.some(p => p.error) ? 'error' : 'info');
    else if (hasProgress && ready()) setStatus('Loading replaces your current build and resets its progress.', 'warn');
    else setStatus('');
  }

  function tabs() {
    return h('div.phase-tabs', { role: 'tablist' },
      phases.map((p, i) => h('div.phase-tab', { class: i === active ? 'is-active' : '' },
        h('button.phase-tab-btn', { type: 'button', role: 'tab', 'aria-selected': String(i === active), onclick: () => { active = i; paint(); } },
          phaseDot(p), h('span', p.name || p.placeholder)),
        phases.length > 1 ? h('button.phase-tab-x', {
          type: 'button', 'aria-label': `Remove ${p.name || p.placeholder}`, title: 'Remove phase',
          onclick: () => { phases.splice(i, 1); active = Math.min(active, phases.length - 1); paint(); },
        }, ui('x', { size: 12 })) : null)),
      phases.length < MAX_PHASES
        ? h('button.phase-add', { type: 'button', onclick: () => { phases.push(newPhase()); active = phases.length - 1; paint(); } }, ui('plus', { size: 14 }), 'Add phase')
        : null,
    );
  }

  function templateBar() {
    if (!templates.length) return null;
    const sel = h('select.select', { 'aria-label': 'Saved templates' },
      h('option', { value: '' }, 'Saved templates…'),
      templates.map(t => h('option', { value: t.filename },
        `${t.loadoutName} · ${t.phaseCount} phase${t.phaseCount !== 1 ? 's' : ''}${t.savedAt ? ' · ' + new Date(t.savedAt).toLocaleDateString() : ''}`)));
    const fill = h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: true, onclick: () => fillTemplate(sel.value) }, 'Use');
    const del = h('button.btn-icon', { type: 'button', disabled: true, 'aria-label': 'Delete template', title: 'Delete template', onclick: () => deleteTemplate(sel.value, sel.selectedOptions[0]?.textContent) }, ui('trash', { size: 15 }));
    sel.addEventListener('change', () => { fill.disabled = del.disabled = !sel.value; });
    return h('div.template-bar', sel, fill, del);
  }

  function paint() {
    const p = phases[active];
    const textarea = h('textarea.code-input', {
      spellcheck: 'false',
      'aria-label': 'Export codes',
      placeholder: '{"passives":{"history":[…]},"class":3,"mastery":2}\n{"skillTrees":{"es6ai":{"history":[…]}}}\n…',
      oninput: (e) => { p.json = e.target.value; schedulePreview(p); },
      onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !loadBtn.disabled) onLoad(); },
    });
    textarea.value = p.json;

    tabsSlot = h('div');
    previewSlot = h('div');

    mount(body,
      maxrollSection(),
      h('div.loadout-top',
        h('label.text-field',
          h('span.field-label', 'Build name'),
          h('input.input', { type: 'text', maxlength: 60, placeholder: 'e.g. Void Knight Erasing Strike', value: name, oninput: (e) => { name = e.target.value; } })),
        templateBar(),
      ),
      tabsSlot,
      h('div.phase-panel',
        h('label.text-field',
          h('span.field-label', 'Phase name'),
          h('input.input', { type: 'text', maxlength: 40, placeholder: p.placeholder, value: p.name, oninput: (e) => { p.name = e.target.value; mount(tabsSlot, tabs()); } })),
        h('label.text-field',
          h('span.field-label', 'Export codes'),
          textarea),
        previewSlot,
      ),
      h('details.help',
        h('summary', ui('info', { size: 15 }), 'Where do I get export codes?'),
        h('ol', HELP.map(t => h('li', t)))),
    );
    paintState();
    if (!mx.link && !mx.planner) requestAnimationFrame(() => textarea.focus());
  }

  // ─── From Maxroll ───────────────────────────────────────────────────────────

  async function fetchMaxroll() {
    if (mx.busy || !mx.link.trim()) return;
    Object.assign(mx, { busy: true, error: null, canOpen: false, planner: null, used: false });
    paint();
    const res = await api.fetchMaxroll(mx.link.trim());
    mx.busy = false;
    if (!res.ok) {
      mx.error = res.error;
      mx.canOpen = !!res.canOpen;
    } else {
      mx.planner = res.planner;
      const usable = res.planner.variants.filter(v => !v.hidden && !v.error);
      const picked = res.planner.pick != null ? [res.planner.pick] : usable.slice(0, MAX_PHASES).map(v => v.index);
      mx.selected = new Set(picked);
    }
    paint();
  }

  function useVariants() {
    const chosen = mx.planner.variants.filter(v => mx.selected.has(v.index)).slice(0, MAX_PHASES);
    if (!chosen.length) return;
    name = mx.planner.name;
    phases = chosen.map((v, i) => ({ ...newPhase(i + 1), name: v.name.slice(0, 40), json: v.json }));
    active = 0;
    source = { maxroll: mx.planner.id };
    mx.used = true;
    paint();
    phases.forEach(schedulePreview);
  }

  function variantRow(v) {
    const on = mx.selected.has(v.index);
    const full = !on && mx.selected.size >= MAX_PHASES;
    const s = v.summary;
    const toggle = () => {
      if (on) mx.selected.delete(v.index); else if (!full) mx.selected.add(v.index);
      paint();
    };
    return h('label.mx-variant', { class: [on ? 'is-on' : '', v.error ? 'is-error' : '', v.hidden ? 'is-hidden' : ''].join(' ') },
      h('input', { type: 'checkbox', checked: on, disabled: !!v.error || full, onchange: toggle }),
      h('div.mx-variant-main',
        h('div.mx-variant-name', v.name, v.hidden ? h('span.muted', ' · hidden in the planner') : null),
        v.error
          ? h('div.mx-variant-meta.is-error', v.error)
          : h('div.mx-variant-meta', `${s.classLabel} · ${s.passivePoints} passive points`, v.level ? ` · level ${v.level}` : ''),
        s ? h('div.preview-skills', s.skills.length
          ? s.skills.map(k => h('span.skill-chip', { class: k.known ? '' : 'is-unknown' }, k.name, h('span.muted', k.points)))
          : h('span.muted', 'No specialized skills yet')) : null,
        v.unmatched?.length ? h('div.preview-warn', ui('alert', { size: 13 }), `Not found in the game data: ${v.unmatched.join(', ')}`) : null,
        s?.passiveMismatch ? h('div.preview-warn', ui('alert', { size: 13 }), s.passiveMismatch) : null,
        ...(v.warnings ?? []).map(w => h('div.preview-warn', ui('alert', { size: 13 }), w)),
      ));
  }

  function maxrollSection() {
    const input = h('input.input', {
      type: 'text', value: mx.link, spellcheck: 'false',
      placeholder: 'https://maxroll.gg/last-epoch/planner/…',
      'aria-label': 'Maxroll planner link',
      oninput: (e) => { mx.link = e.target.value; fetchBtn.disabled = mx.busy || !mx.link.trim(); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchMaxroll(); } },
    });
    const fetchBtn = h('button.btn.btn-secondary', { type: 'button', disabled: mx.busy || !mx.link.trim(), onclick: fetchMaxroll },
      mx.busy ? [h('span.spinner'), 'Fetching…'] : 'Fetch');

    let result = null;
    if (mx.error) {
      result = h('div.preview.is-error', ui('alert', { size: 16 }),
        h('div', mx.error,
          mx.canOpen ? h('button.btn.btn-ghost.btn-sm.mx-open', { type: 'button', onclick: () => api.openMaxroll(mx.link) }, 'Open in browser') : null));
    } else if (mx.planner && mx.used) {
      const n = phases.length;
      result = h('div.mx-used', ui('check', { size: 15, stroke: 3 }),
        h('span', h('b', mx.planner.name), ` — ${n} variant${n > 1 ? 's' : ''} loaded into the phases below.`),
        h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { mx.used = false; paint(); } }, 'Pick again'));
    } else if (mx.planner) {
      const p = mx.planner;
      const count = mx.selected.size;
      result = h('div.mx-result',
        h('div.mx-head',
          h('div', h('b', p.name), p.author ? h('span.muted', ` · by ${p.author}`) : null),
          h('span.muted', `${p.variants.length} variant${p.variants.length > 1 ? 's' : ''}`)),
        h('div.mx-variants', p.variants.map(variantRow)),
        h('div.mx-foot',
          h('span.muted', count >= MAX_PHASES ? `Up to ${MAX_PHASES} phases per build.` : 'Each variant becomes a phase, in this order.'),
          h('button.btn.btn-primary.btn-sm', { type: 'button', disabled: !count, onclick: useVariants },
            `Use ${count} variant${count !== 1 ? 's' : ''}`)));
    }

    return h('section.mx-section',
      h('div.field-label', 'From Maxroll'),
      h('div.mx-row', input, fetchBtn),
      result);
  }

  // ─── Actions ────────────────────────────────────────────────────────────────

  async function refreshTemplates() {
    const res = await api.listTemplates();
    templates = res.ok ? res.list : [];
  }

  async function fillTemplate(filename) {
    if (!filename) return;
    const res = await api.loadTemplate(filename);
    if (!res.ok) return setStatus(`Could not open template: ${res.error}`);
    name = res.template.loadoutName ?? '';
    source = null;
    phases = (res.template.phases ?? []).slice(0, MAX_PHASES).map((tp, i) => ({ ...newPhase(i + 1), name: tp.name ?? '', json: tp.json ?? '' }));
    if (!phases.length) phases = [newPhase(1)];
    active = 0;
    paint();
    phases.forEach(schedulePreview);
  }

  async function deleteTemplate(filename, label) {
    if (!filename || !confirm(`Delete template “${label}”?`)) return;
    const res = await api.deleteTemplate(filename);
    if (!res.ok) return setStatus(`Could not delete: ${res.error}`);
    await refreshTemplates();
    paint();
  }

  async function onSaveTemplate() {
    const res = await api.saveTemplate(name.trim() || 'Unnamed build', phases.map(p => ({ name: p.name || p.placeholder, json: p.json })));
    if (!res.ok) return setStatus(`Could not save template: ${res.error}`);
    await refreshTemplates();
    paint();
    setStatus('Template saved.', 'success');
  }

  async function onLoad() {
    if (!ready() || busy) return;
    busy = true;
    loadBtn.disabled = true;
    const res = await api.loadLoadout(phases.map(p => ({ name: p.name || p.placeholder, json: p.json })), name.trim() || undefined, source ?? undefined);
    busy = false;
    if (!res.ok) { paintState(); return setStatus(res.error); }
    dialog.close();
    onLoaded(res.build);
  }

  mount(dialog,
    h('div.dialog-card.dialog-loadout',
      h('header.dialog-head',
        h('div', h('h2', 'Load build'), h('p.dialog-sub', 'Paste a Maxroll planner link, or export codes from Maxroll or the game.')),
        h('button.btn-icon', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, ui('x', { size: 18 }))),
      body,
      h('footer.dialog-foot',
        status,
        h('div.dialog-foot-actions', saveTplBtn, h('button.btn.btn-ghost', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), loadBtn),
      ),
    ),
  );

  paint();
  dialog.showModal();
  refreshTemplates().then(paint);
  // A Maxroll link on the clipboard pre-fills the field (never fetched until asked).
  api.maxrollClipboardLink?.().then(res => {
    if (res?.ok && res.link && !mx.link) { mx.link = res.link; paint(); }
  });
}
