/**
 * app/js/loadout-dialog.js
 * ─────────────────────────
 * "Load build" dialog (Ctrl+O): paste export codes for 1–5 phases, see each
 * phase validated live (class, points, skills recognised), optionally save the
 * raw inputs as a template, then load. Loading resets progress to 0.
 */

import { h, mount } from './dom.js';
import { ui } from './icons.js';

const MAX_PHASES = 5;
const PREVIEW_DELAY_MS = 250;

const HELP = [
  'In the Maxroll planner, open your build and use Export — copy every line.',
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
    requestAnimationFrame(() => textarea.focus());
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
    const res = await api.loadLoadout(phases.map(p => ({ name: p.name || p.placeholder, json: p.json })), name.trim() || undefined);
    busy = false;
    if (!res.ok) { paintState(); return setStatus(res.error); }
    dialog.close();
    onLoaded(res.build);
  }

  mount(dialog,
    h('div.dialog-card.dialog-loadout',
      h('header.dialog-head',
        h('div', h('h2', 'Load build'), h('p.dialog-sub', 'Paste the export codes from Maxroll or the in-game export.')),
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
}
