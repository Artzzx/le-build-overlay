/**
 * app/js/loadout-dialog.js
 * ─────────────────────────
 * "Load build" dialog (Ctrl+O). Three views in one wide, fixed-size modal:
 *
 *   choose  — two cards: "From a Maxroll link" | "Paste export codes"
 *             (+ saved templates, + re-import the current Maxroll build)
 *   maxroll — link bar · left rail: planner variants (tick up to 6) ·
 *             right pane: the focused variant (class, level, skills with icons)
 *   codes   — the phases workspace. Left rail: phases (+ add from export codes or another
 *             Maxroll planner) · middle: phase name (move / remove) + codes · right: preview
 *
 * Mixing guides (e.g. a leveling guide + an endgame guide): Maxroll → "Add another guide
 * or codes" moves the ticked variants into the phases workspace, where "Maxroll
 * link" opens the Maxroll view in *adding* mode to append another planner's variants.
 * Each phase keeps its origin ({ maxroll, variant, name } or null = pasted codes) until its
 * codes are edited, so every guide the build came from is checked for updates later
 * (build.source, see MaxrollImport.makeSource).
 *
 * Both workspaces load through api.loadLoadout(phases, name, source), so
 * validation, templates and the rest of the app are the same as before.
 * Each view keeps its state while the dialog is open (Back loses nothing).
 */

import { h, mount } from './dom.js';
import { ui, treeArt } from './icons.js';

const MAX_PHASES = 6;
const { makeSource } = window.MaxrollImport;
const PREVIEW_DELAY_MS = 250;

const HELP = [
  'In the Maxroll planner, open your build and use Export — copy every line.',
  'Or in game: export the Passives tab, then each Skill tab, and paste each code on its own line.',
  'Add a phase per stage of the guide (e.g. Leveling → Endgame). Progress carries over where trees overlap.',
];

/**
 * @param {object} o
 * @param {HTMLDialogElement} o.dialog
 * @param {object} o.api              — window.api
 * @param {object} [o.trees]          — db.skills (tree names + icons for skill cards)
 * @param {object} [o.currentSource]  — the loaded build's source ({ maxroll: id }) for "re-import"
 * @param {boolean} o.hasProgress     — current build has allocated points (show replace warning)
 * @param {string} o.profileName      — the active character's name
 * @param {number|null} o.currentClassId — the active build's class (null = no build)
 * @param {(res: { build, profiles, activeProfile }) => void} o.onLoaded
 */
export function openLoadout({ dialog, api, trees = {}, currentSource = null, hasProgress, profileName, currentClassId = null, onLoaded }) {
  let view = 'choose';
  let busy = false;
  // Load into the active character or a new one. null = automatic: a new character when the
  // build is another class than the current one (an alt), else this character.
  let target = null;
  let templates = [];
  let clipboardLink = null;

  // Phases workspace (pasted codes and/or planner variants). `dates` = each planner's last-save date.
  const codes = { name: '', phases: [], active: 0, dates: {} };
  const newPhase = (n) => ({ name: '', json: '', preview: null, error: null, pending: false, origin: null, placeholder: n === 1 ? 'Leveling' : n === 2 ? 'Endgame' : `Phase ${n}` });
  codes.phases.push(newPhase(1));

  // Maxroll workspace
  // adding = picking variants to append to the phases workspace (another guide).
  const mx = { link: '', busy: false, error: null, canOpen: false, planner: null, selected: new Set(), focus: 0, name: '', names: new Map(), adding: false };

  const body = h('div.ld-body');
  const status = h('div.dialog-status', { role: 'status' });
  const crumb = h('div.ld-crumb');
  const backBtn = h('button.btn.btn-ghost.btn-sm.ld-back', { type: 'button', onclick: () => back(), title: 'Back (Alt+←)' }, ui('chevronLeft', { size: 15 }), 'Back');
  const loadBtn = h('button.btn.btn-primary', { type: 'button', onclick: onLoad, title: 'Load (Ctrl+Enter)' });
  const targetSlot = h('div.ld-target');
  const saveTplBtn = h('button.btn.btn-secondary', { type: 'button', onclick: onSaveTemplate }, ui('save', { size: 15 }), 'Save as template');

  const setStatus = (msg, kind = 'error') => { status.className = `dialog-status is-${kind}`; status.textContent = msg; };

  // ─── Shared pieces ──────────────────────────────────────────────────────────

  function skillCard(k) {
    const tree = trees[k.key];
    return h('div.ld-skill', { class: k.known ? '' : 'is-unknown', title: k.known ? k.key : `“${k.key}” is not in the game data` },
      h('span.ld-skill-art', treeArt({ treeIcon: tree?.icon ?? null, treeId: k.key, title: k.name })),
      h('span.ld-skill-name', k.name),
      h('span.ld-skill-pts', `${k.points} pts`));
  }

  /** Class, points, skills and warnings for one phase (preview summary from main). */
  function summaryCard(s, { level = null } = {}) {
    const unknown = s.skills.filter(k => !k.known);
    return h('div.ld-summary',
      h('div.ld-stats',
        h('div.ld-stat', h('span.ld-stat-label', 'Class'), h('span.ld-stat-value', s.classLabel.replace(' — ', ' · '))),
        level ? h('div.ld-stat', h('span.ld-stat-label', 'Level'), h('span.ld-stat-value', String(level))) : null,
        h('div.ld-stat', h('span.ld-stat-label', 'Passive points'), h('span.ld-stat-value', String(s.passivePoints))),
        h('div.ld-stat', h('span.ld-stat-label', 'Skills'), h('span.ld-stat-value', String(s.skills.length)))),
      h('div.ld-skills', s.skills.length ? s.skills.map(skillCard) : h('p.muted.ld-none', 'No specialized skills in this phase.')),
      unknown.length ? h('div.preview-warn', ui('alert', { size: 14 }), `${unknown.length} skill${unknown.length > 1 ? 's' : ''} not in the game data — ${unknown.length > 1 ? 'they' : 'it'} will show as “No tree data”.`) : null,
      s.passiveMismatch ? h('div.preview-warn', ui('alert', { size: 14 }), s.passiveMismatch) : null,
    );
  }

  function placeholder(icon, title, text, ...actions) {
    return h('div.ld-placeholder', ui(icon, { size: 28, stroke: 1.5 }), h('div.ld-placeholder-title', title), text ? h('p', text) : null, actions.length ? h('div.ld-placeholder-actions', actions) : null);
  }

  /** Class of the build about to be loaded, once known. */
  function incomingClassId() {
    if (mx.adding) return codes.phases.find(p => p.preview)?.preview.classId ?? null;
    if (view === 'maxroll' && !mx.adding) return chosenVariants().find(v => v.summary)?.summary.classId ?? null;
    if (view === 'codes') return codes.phases.find(p => p.preview)?.preview.classId ?? null;
    return null;
  }

  function effectiveTarget() {
    if (target) return target;
    const incoming = incomingClassId();
    return currentClassId != null && incoming != null && incoming !== currentClassId ? 'new' : 'current';
  }

  function paintTarget() {
    targetSlot.hidden = view === 'choose' || isAdding();
    const t = effectiveTarget();
    const seg = (key, label, title) => h('button.seg', {
      type: 'button', role: 'radio', 'aria-checked': String(t === key), class: t === key ? 'is-active' : '', title,
      onclick: () => { target = key; paintFooter(); },
    }, label);
    mount(targetSlot,
      h('span.ld-target-label', 'Load into'),
      h('div.segmented', { role: 'radiogroup', 'aria-label': 'Load into' },
        seg('current', profileName, `Replace ${profileName}’s build`),
        seg('new', 'New character', 'Keep this character as it is and add a new one')));
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  const timers = new WeakMap();
  function schedulePreview(phase) {
    clearTimeout(timers.get(phase));
    phase.preview = null;
    phase.error = null;
    phase.pending = !!phase.json.trim();
    timers.set(phase, setTimeout(async () => {
      const json = phase.json;
      if (!json.trim()) { phase.pending = false; return paintCodesLive(); }
      const res = await api.previewPhase(json);
      if (json !== phase.json) return; // stale
      phase.pending = false;
      if (res.ok) phase.preview = res.summary;
      else phase.error = res.error;
      paintCodesLive();
    }, PREVIEW_DELAY_MS));
  }

  const isAdding = () => view === 'maxroll' && mx.adding;
  const filledPhases = () => codes.phases.filter(p => p.json.trim());
  /** How many variants can be ticked: all 6, or what's left next to the phases already there. */
  const variantLimit = () => (mx.adding ? Math.max(0, MAX_PHASES - filledPhases().length) : MAX_PHASES);
  const chosenVariants = () => (mx.planner?.variants ?? []).filter(v => mx.selected.has(v.index)).slice(0, variantLimit());
  const variantName = (v) => (mx.names.get(v.index) ?? v.name).trim() || v.name;
  // Where a phase came from: lets the app check that guide for updates later. `guide` is for display.
  const originOf = (v) => ({ maxroll: mx.planner.id, variant: v.index, name: v.name, guide: mx.planner.name });
  const plannerDates = () => (mx.planner?.date ? { [mx.planner.id]: mx.planner.date } : {});
  const maxrollSource = () => makeSource(chosenVariants().map(originOf), plannerDates());

  function problems() {
    const out = [];
    if (view === 'maxroll') {
      if (!mx.planner) return ['Fetch a planner first.'];
      const chosen = chosenVariants();
      if (mx.adding && !variantLimit()) return [`There are already ${MAX_PHASES} phases — remove one first.`];
      if (!chosen.length) out.push(mx.adding ? 'Tick the variants to add.' : 'Tick at least one variant.');
      const classes = new Set([
        ...(mx.adding ? filledPhases().map(p => p.preview?.className) : []),
        ...chosen.map(v => v.summary?.className),
      ].filter(Boolean));
      if (classes.size > 1) out.push(`All phases must be the same class (found ${[...classes].join(' and ')})`);
      return out;
    }
    codes.phases.forEach((p) => {
      const label = p.name || p.placeholder;
      if (!p.json.trim()) out.push(`${label}: paste export codes`);
      else if (p.error) out.push(`${label}: ${p.error}`);
    });
    // Same class in every phase; the mastery may change (e.g. plain Rogue while leveling, then Bladedancer).
    const classes = new Set(codes.phases.map(p => p.preview?.className).filter(Boolean));
    if (classes.size > 1) out.push(`All phases must be the same class (found ${[...classes].join(' and ')})`);
    return out;
  }

  const ready = () => {
    if (view === 'maxroll') return !!mx.planner && problems().length === 0;
    if (view === 'codes') return codes.phases.every(p => p.preview && !p.pending) && problems().length === 0;
    return false;
  };

  function paintFooter() {
    const n = view === 'maxroll' ? chosenVariants().length : codes.phases.length;
    const hasPhases = view === 'codes' || (view === 'maxroll' && mx.planner);
    const s = n !== 1 ? 's' : '';
    if (isAdding()) mount(loadBtn, ui('plus', { size: 16 }), `Add ${n} phase${s}`);
    else mount(loadBtn, ui('upload', { size: 16 }), hasPhases ? `Load ${n} phase${s}` : 'Load build');
    loadBtn.title = isAdding() ? 'Add to the phases (Ctrl+Enter)' : 'Load (Ctrl+Enter)';
    loadBtn.disabled = busy || !ready();
    saveTplBtn.hidden = view === 'choose' || isAdding();
    loadBtn.hidden = view === 'choose'; // nothing to load until a source is picked
    saveTplBtn.disabled = busy || (view === 'maxroll' ? !chosenVariants().length : codes.phases.every(p => !p.json.trim()));
    backBtn.hidden = view === 'choose';
    mount(crumb, view === 'choose'
      ? h('span', 'Where does your build come from?')
      : isAdding()
        ? [h('span', 'Phases'), ui('chevronRight', { size: 14 }), h('b', 'Add from Maxroll')]
        : [h('span', 'Load build'), ui('chevronRight', { size: 14 }), h('b', view === 'maxroll' ? 'From Maxroll' : 'Phases')]);

    paintTarget();
    const issues = view === 'choose' ? [] : problems();
    const started = view === 'maxroll' ? !!mx.planner : codes.phases.some(p => p.json.trim());
    if (issues.length && started) setStatus(issues[0], codes.phases.some(p => p.error) && view === 'codes' ? 'error' : 'info');
    else if (isAdding()) setStatus(mx.planner ? `Adds after your ${filledPhases().length} phase${filledPhases().length !== 1 ? 's' : ''} — reorder them next.` : 'Fetch the other guide’s planner.', 'info');
    else if (ready() && effectiveTarget() === 'new') setStatus(`Adds a new character. ${profileName} is kept as it is.`, 'info');
    else if (hasProgress && ready()) setStatus(`Replaces ${profileName}’s build and resets its progress.`, 'warn');
    else setStatus('');
  }

  // ─── View: choose ───────────────────────────────────────────────────────────

  function chooseView() {
    const steps = (...items) => h('ol.ld-steps', items.map(t => h('li', t)));
    const card = (key, icon, title, text, { badge = null, extra = null, onPick }) =>
      h('div.ld-choice', {
        role: 'button', tabindex: '0', dataset: { key },
        onclick: (e) => { if (!e.target.closest('button, input')) onPick(); },
        onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onPick(); } },
      },
      h('div.ld-choice-top', h('span.ld-choice-icon', ui(icon, { size: 22 })), badge ? h('span.ld-badge', badge) : null, h('kbd.key.key-sm.ld-choice-key', key)),
      h('div.ld-choice-title', title),
      h('p.ld-choice-text', text),
      extra);

    const clip = clipboardLink
      ? h('div.ld-clip',
        h('div.ld-clip-label', ui('info', { size: 13 }), 'Link on your clipboard'),
        h('div.ld-clip-link', { title: clipboardLink }, clipboardLink.replace(/^https?:\/\//, '')),
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => { mx.link = clipboardLink; go('maxroll'); fetchMaxroll(); } }, 'Fetch this build'))
      : null;

    const reimport = currentSource?.maxroll
      ? h('button.ld-link', { type: 'button', onclick: () => { mx.link = `https://maxroll.gg/last-epoch/planner/${currentSource.maxroll}`; go('maxroll'); fetchMaxroll(); } },
        ui('undo', { size: 14 }), 'Re-import the current build from Maxroll')
      : null;

    return h('div.ld-choose',
      h('div.ld-choices',
        card('1', 'arrowRight', 'From a Maxroll link', 'Paste a planner link and pick its variants — Leveling, Endgame… each becomes a phase.', {
          badge: 'Recommended',
          extra: clip ?? steps('Copy the planner’s link', 'Fetch — every variant is listed', 'Tick the ones you want, then Load'),
          onPick: () => go('maxroll'),
        }),
        card('2', 'keyboard', 'Paste export codes', 'Codes from Maxroll’s Export dialog or the in-game export, one phase at a time.', {
          extra: steps('Works without a Maxroll link or internet', 'One phase per stage (up to 6)', 'Live check of class, points and skills'),
          onPick: () => go('codes'),
        }),
      ),
      templates.length || reimport
        ? h('div.ld-more',
          templates.length ? h('div.ld-templates',
            h('div.ld-more-label', 'Saved templates'),
            h('div.ld-template-list', templates.map(t => h('div.ld-template',
              h('button.ld-template-open', { type: 'button', onclick: () => fillTemplate(t.filename), title: 'Open in the codes editor' },
                h('span.ld-template-name', t.loadoutName),
                h('span.muted', `${t.phaseCount} phase${t.phaseCount !== 1 ? 's' : ''}${t.savedAt ? ' · ' + new Date(t.savedAt).toLocaleDateString() : ''}`)),
              h('button.btn-icon.btn-xs', { type: 'button', 'aria-label': `Delete template ${t.loadoutName}`, title: 'Delete', onclick: () => deleteTemplate(t.filename, t.loadoutName) }, ui('trash', { size: 13 })))))) : null,
          reimport)
        : null,
    );
  }

  // ─── View: Maxroll ──────────────────────────────────────────────────────────

  function maxrollView() {
    const input = h('input.input.ld-link-input', {
      type: 'text', value: mx.link, spellcheck: 'false',
      placeholder: 'https://maxroll.gg/last-epoch/planner/…',
      'aria-label': 'Maxroll planner link',
      oninput: (e) => { mx.link = e.target.value; fetchBtn.disabled = mx.busy || !mx.link.trim(); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchMaxroll(); } },
    });
    const fetchBtn = h('button.btn.btn-secondary', { type: 'button', disabled: mx.busy || !mx.link.trim(), onclick: fetchMaxroll },
      mx.busy ? [h('span.spinner'), 'Fetching…'] : 'Fetch');

    const bar = h('div.ld-bar',
      h('div.ld-bar-row', h('span.ld-bar-icon', ui('arrowRight', { size: 16 })), input, fetchBtn),
      mx.planner
        ? h('div.ld-bar-row.ld-bar-meta',
          mx.adding
            ? h('span', h('b', mx.planner.name))
            : h('label.ld-name', h('span.ld-name-label', 'Build name'),
              h('input.input', { type: 'text', maxlength: 60, value: mx.name, oninput: (e) => { mx.name = e.target.value; } })),
          h('span.muted', mx.planner.author ? `by ${mx.planner.author}` : ''))
        : null);

    let content;
    if (mx.busy) {
      content = placeholder('target', 'Fetching the planner…', null);
    } else if (mx.error) {
      content = placeholder('alert', 'Couldn’t import this planner', mx.error,
        mx.canOpen ? h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => api.openMaxroll(mx.link) }, 'Open in browser') : null,
        h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => go('codes') }, 'Paste codes instead'));
    } else if (!mx.planner) {
      content = mx.adding
        ? placeholder('plus', 'Add phases from another guide', 'Paste that guide’s Maxroll planner link, fetch it, and tick the variants to add.')
        : placeholder('arrowRight', 'Paste a Maxroll planner link', 'maxroll.gg/last-epoch/planner/… — add #2 to take only the 2nd variant.');
    } else {
      content = h('div.ld-split', variantRail(), variantPane());
    }
    return h('div.ld-maxroll', bar, content);
  }

  function variantRail() {
    const limit = variantLimit();
    const count = Math.min(mx.selected.size, limit);
    return h('aside.ld-rail',
      h('div.ld-rail-head', h('span', 'Variants'), h('span.ld-count', { class: count >= limit ? 'is-full' : '' }, mx.adding ? `${count} of ${limit} free` : `${count} of ${MAX_PHASES} phases`)),
      h('div.ld-rail-list', mx.planner.variants.map(v => {
        const on = mx.selected.has(v.index);
        const full = !on && count >= limit;
        const mastery = v.summary?.classLabel.split(' — ')[1] ?? v.summary?.classLabel ?? '';
        return h('div.ld-rail-item', {
          class: [v.index === mx.focus ? 'is-focus' : '', on ? 'is-on' : '', v.hidden ? 'is-hidden' : '', v.error ? 'is-error' : ''].join(' '),
          onclick: (e) => { if (e.target.tagName !== 'INPUT') { mx.focus = v.index; paint(); } },
        },
        h('input', {
          type: 'checkbox', checked: on, disabled: !!v.error || full, 'aria-label': `Use ${v.name}`,
          onchange: () => { if (on) mx.selected.delete(v.index); else mx.selected.add(v.index); mx.focus = v.index; paint(); },
        }),
        h('div.ld-rail-text',
          h('div.ld-rail-name', variantName(v)),
          h('div.ld-rail-meta',
            v.level ? h('span', `lvl ${v.level}`) : null,
            mastery ? h('span.ld-chip', mastery) : null,
            v.hidden ? h('span.muted', 'hidden') : null,
            v.error ? h('span.ld-err', 'can’t read') : null)));
      })),
      mx.adding ? null : h('button.ld-add', {
        type: 'button', disabled: !chosenVariants().length, onclick: editAsCodes,
        title: 'Combine these variants with another guide’s, or with export codes',
      }, ui('plus', { size: 14 }), 'Add another guide or codes'),
    );
  }

  function variantPane() {
    const v = mx.planner.variants.find(x => x.index === mx.focus) ?? mx.planner.variants[0];
    const on = mx.selected.has(v.index);
    return h('section.ld-pane',
      h('div.ld-pane-head',
        h('div',
          h('div.ld-pane-kicker', on ? `Phase ${chosenVariants().findIndex(x => x.index === v.index) + 1}` : 'Not used'),
          h('h3.ld-pane-title', v.name)),
        h('label.ld-name.ld-name-sm', h('span.ld-name-label', 'Phase name'),
          h('input.input', { type: 'text', maxlength: 40, value: mx.names.get(v.index) ?? v.name, oninput: (e) => { mx.names.set(v.index, e.target.value); } }))),
      v.error
        ? h('div.preview.is-error', ui('alert', { size: 16 }), h('div', v.error))
        : summaryCard(v.summary, { level: v.level }),
      ...(v.unmatched?.length ? [h('div.preview-warn', ui('alert', { size: 13 }), `Not found in the game data: ${v.unmatched.join(', ')}`)] : []),
      ...(v.warnings ?? []).map(w => h('div.preview-warn', ui('alert', { size: 13 }), w)),
      mx.adding ? null : h('div.ld-pane-foot',
        h('button.ld-link', { type: 'button', onclick: editAsCodes, disabled: !chosenVariants().length }, ui('keyboard', { size: 14 }), 'Edit the chosen variants as codes')),
    );
  }

  // ─── View: codes ────────────────────────────────────────────────────────────

  let codesPreviewSlot = null;
  let codesRailSlot = null;
  let originSlot = null;

  function originNote(p) {
    return p.origin
      ? h('div.ld-origin-note', ui('info', { size: 13 }),
        h('span', 'From ', h('b', p.origin.guide ?? 'Maxroll'), ` · ${p.origin.name}. Checked for guide updates — editing the codes unlinks it.`))
      : null;
  }
  const paintOrigin = () => { if (originSlot) mount(originSlot, originNote(codes.phases[codes.active])); };

  function removePhase(i) {
    codes.phases.splice(i, 1);
    codes.active = Math.min(codes.active, codes.phases.length - 1);
    paint();
  }

  /** Move / remove the selected phase (next to its name, so the rail stays readable). */
  function phaseTools(i) {
    if (codes.phases.length < 2) return null;
    const label = codes.phases[i].name || codes.phases[i].placeholder;
    return h('div.ld-phase-tools',
      h('button.btn-icon.btn-sm', { type: 'button', disabled: i === 0, 'aria-label': `Move ${label} earlier`, title: 'Earlier phase (Alt+↑)', onclick: () => movePhase(i, -1) }, ui('chevronUp', { size: 16 })),
      h('button.btn-icon.btn-sm', { type: 'button', disabled: i === codes.phases.length - 1, 'aria-label': `Move ${label} later`, title: 'Later phase (Alt+↓)', onclick: () => movePhase(i, 1) }, ui('chevronDown', { size: 16 })),
      h('button.btn-icon.btn-sm', { type: 'button', 'aria-label': `Remove ${label}`, title: 'Remove this phase', onclick: () => removePhase(i) }, ui('trash', { size: 15 })));
  }

  function movePhase(i, d) {
    const j = i + d;
    if (j < 0 || j >= codes.phases.length) return;
    [codes.phases[i], codes.phases[j]] = [codes.phases[j], codes.phases[i]];
    codes.active = j;
    paint();
  }

  /** Where a phase came from, for the rail: the guide's name, or "codes". */
  const originChip = (p) => (p.origin
    ? h('span.ld-chip.ld-origin', { title: `From the Maxroll planner “${p.origin.guide ?? p.origin.maxroll}” — checked for guide updates` }, p.origin.guide ?? 'Maxroll')
    : p.json.trim() ? h('span.ld-chip.ld-origin.is-codes', { title: 'Pasted codes — not checked for guide updates' }, 'codes') : null);

  function phaseDot(p) {
    if (p.pending) return h('span.dot.is-pending', { title: 'Checking…' });
    if (p.error) return h('span.dot.is-error', { title: 'Has a problem' });
    if (p.preview) return h('span.dot.is-ok', { title: 'Looks good' });
    return h('span.dot', { title: 'Empty' });
  }

  function phaseRail() {
    return h('aside.ld-rail',
      h('div.ld-rail-head', h('span', 'Phases'), h('span.ld-count', { class: codes.phases.length >= MAX_PHASES ? 'is-full' : '' }, `${codes.phases.length} of ${MAX_PHASES}`)),
      h('div.ld-rail-list', codes.phases.map((p, i) => h('div.ld-rail-item', {
        class: i === codes.active ? 'is-focus' : '',
        onclick: () => { codes.active = i; paint(); },
      },
      phaseDot(p),
      h('div.ld-rail-text',
        h('div.ld-rail-name', p.name || p.placeholder),
        h('div.ld-rail-meta',
          p.preview ? `${p.preview.passivePoints} pts · ${p.preview.skills.length} skill${p.preview.skills.length !== 1 ? 's' : ''}` : p.error ? h('span.ld-err', 'has a problem') : p.pending ? 'checking…' : 'empty',
          originChip(p)))))),
      codes.phases.length < MAX_PHASES
        ? h('div.ld-add-row',
          h('button.ld-add', { type: 'button', title: 'Add a phase and paste its export codes', onclick: () => { codes.phases.push(newPhase(codes.phases.length + 1)); codes.active = codes.phases.length - 1; paint(); } },
            ui('keyboard', { size: 14 }), 'Codes'),
          h('button.ld-add', { type: 'button', title: 'Add phases from another Maxroll planner (e.g. a leveling guide)', onclick: startAdding },
            ui('plus', { size: 14 }), 'Maxroll link'))
        : null,
    );
  }

  function codesPreview(p) {
    if (p.pending) return placeholder('target', 'Checking…', null);
    if (p.error) return h('div.preview.is-error', ui('alert', { size: 16 }), h('div', h('b', 'Can’t read this yet. '), p.error));
    if (!p.preview) return placeholder('info', 'Live preview', 'Paste the codes on the left — class, points and skills show up here.');
    return summaryCard(p.preview);
  }

  function codesView() {
    const p = codes.phases[codes.active];
    const textarea = h('textarea.code-input.ld-code', {
      spellcheck: 'false',
      'aria-label': 'Export codes',
      placeholder: '{"passives":{"history":[…]},"class":2,"mastery":1}\n{"skillTrees":{"es6ai":{"history":[…]}}}\n…',
      // Edited codes are no longer the guide's variant: this phase stops being checked for updates.
      oninput: (e) => { p.json = e.target.value; if (p.origin) { p.origin = null; paintOrigin(); } schedulePreview(p); paintCodesLive(); },
    });
    textarea.value = p.json;
    codesRailSlot = h('div.ld-rail-slot', phaseRail());
    originSlot = h('div.ld-origin-slot', originNote(p));
    codesPreviewSlot = h('div.ld-preview-slot', codesPreview(p));

    return h('div.ld-codes',
      h('div.ld-bar',
        h('div.ld-bar-row',
          h('label.ld-name', h('span.ld-name-label', 'Build name'),
            h('input.input', { type: 'text', maxlength: 60, placeholder: 'e.g. Void Knight Erasing Strike', value: codes.name, oninput: (e) => { codes.name = e.target.value; } })))),
      h('div.ld-split.ld-split-3',
        codesRailSlot,
        h('section.ld-editor',
          h('div.ld-editor-head',
            h('label.ld-name', h('span.ld-name-label', 'Phase name'),
              h('input.input', { type: 'text', maxlength: 40, placeholder: p.placeholder, value: p.name, oninput: (e) => { p.name = e.target.value; mount(codesRailSlot, phaseRail()); } })),
            phaseTools(codes.active)),
          originSlot,
          h('label.ld-code-wrap', h('span.ld-name-label', 'Export codes'), textarea)),
        h('section.ld-pane.ld-pane-preview',
          codesPreviewSlot,
          h('details.help',
            h('summary', ui('info', { size: 15 }), 'Where do I get export codes?'),
            h('ol', HELP.map(t => h('li', t)))))),
    );
  }

  /** Refresh the parts of the codes view that change while typing, without re-creating the textarea. */
  function paintCodesLive() {
    if (view !== 'codes') return;
    if (codesRailSlot) mount(codesRailSlot, phaseRail());
    if (codesPreviewSlot) mount(codesPreviewSlot, codesPreview(codes.phases[codes.active]));
    paintFooter();
  }

  // ─── Paint / navigation ─────────────────────────────────────────────────────

  function paint() {
    // Re-rendering replaces the focused element: remember what had focus and put it back,
    // so keyboard use (and Ctrl+Enter) keeps working after a click or a checkbox toggle.
    const active = document.activeElement;
    const refocus = body.contains(active)
      ? active.matches('.ld-choice') ? `.ld-choice[data-key="${active.dataset.key}"]`
      : active.matches('.ld-rail-item input') ? '.ld-rail-item.is-focus input'
        : active.matches('.ld-rail-item') ? '.ld-rail-item.is-focus'
          : active.matches('.ld-link-input') ? '.ld-link-input'
            : null
      : null;
    body.dataset.view = view;
    mount(body, view === 'choose' ? chooseView() : view === 'maxroll' ? maxrollView() : codesView());
    paintFooter();
    if (refocus) body.querySelector(refocus)?.focus();
    else if (body.contains(active) || active === document.body || active === dialog) {
      (view === 'choose' ? body.querySelector('.ld-choice') : dialog.querySelector('.dialog-card'))?.focus();
    }
  }

  /** Back: out of "add from Maxroll" to the phases, else to the choose screen. */
  function back() {
    if (isAdding()) { mx.adding = false; go('codes'); } else go('choose');
  }

  function go(next) {
    if (next !== 'maxroll') mx.adding = false;
    view = next;
    paint();
    requestAnimationFrame(() => {
      const target = next === 'maxroll' ? (mx.planner ? body.querySelector('.ld-rail-item input') : body.querySelector('.ld-link-input'))
        : next === 'codes' ? body.querySelector('.ld-code')
          : body.querySelector('.ld-choice');
      target?.focus();
    });
  }

  // ─── Actions ────────────────────────────────────────────────────────────────

  async function fetchMaxroll() {
    if (mx.busy || !mx.link.trim()) return;
    Object.assign(mx, { busy: true, error: null, canOpen: false, planner: null });
    mx.names.clear();
    paint();
    const res = await api.fetchMaxroll(mx.link.trim());
    mx.busy = false;
    if (!res.ok) {
      mx.error = res.error;
      mx.canOpen = !!res.canOpen;
    } else {
      const p = res.planner;
      mx.planner = p;
      mx.name = p.name;
      const usable = p.variants.filter(v => !v.hidden && !v.error);
      mx.selected = new Set(p.pick != null ? [p.pick] : mx.adding ? [] : usable.slice(0, MAX_PHASES).map(v => v.index));
      mx.focus = p.pick ?? usable[0]?.index ?? p.variants[0].index;
    }
    paint();
  }

  const variantPhase = (v, n) => ({ ...newPhase(n), name: variantName(v).slice(0, 40), json: v.json, preview: v.summary, origin: originOf(v) });

  /** Move the ticked variants into the phases workspace: to tweak their codes or add more phases. */
  function editAsCodes() {
    const chosen = chosenVariants();
    if (!chosen.length) return;
    codes.name = mx.name.trim() || mx.planner.name;
    codes.phases = chosen.map((v, i) => variantPhase(v, i + 1));
    codes.active = 0;
    codes.dates = plannerDates();
    go('codes');
  }

  /** From the phases: fetch another planner and pick variants to append. */
  function startAdding() {
    mx.adding = true;
    Object.assign(mx, { link: '', error: null, canOpen: false, planner: null, selected: new Set(), names: new Map() });
    view = 'maxroll';
    paint();
    requestAnimationFrame(() => body.querySelector('.ld-link-input')?.focus());
  }

  /** Append the ticked variants after the phases already there (empty ones are dropped). */
  function addFromMaxroll() {
    const chosen = chosenVariants();
    if (!chosen.length) return;
    const kept = filledPhases();
    codes.phases = [...kept, ...chosen.map((v, i) => variantPhase(v, kept.length + i + 1))];
    codes.dates = { ...codes.dates, ...plannerDates() };
    if (!codes.name.trim()) codes.name = mx.planner.name;
    codes.active = kept.length;
    mx.adding = false;
    go('codes');
  }

  /** What Load / Save as template use, from whichever workspace is open. */
  function currentLoadout() {
    if (view === 'maxroll') {
      return {
        name: mx.name.trim() || mx.planner.name,
        phases: chosenVariants().map(v => ({ name: variantName(v).slice(0, 40), json: v.json })),
        source: maxrollSource(),
      };
    }
    return {
      name: codes.name.trim(),
      phases: codes.phases.map(p => ({ name: p.name || p.placeholder, json: p.json })),
      source: makeSource(codes.phases.map(p => p.origin), codes.dates),
    };
  }

  async function refreshTemplates() {
    const res = await api.listTemplates();
    templates = res.ok ? res.list : [];
  }

  async function fillTemplate(filename) {
    const res = await api.loadTemplate(filename);
    if (!res.ok) return setStatus(`Could not open template: ${res.error}`);
    codes.name = res.template.loadoutName ?? '';
    codes.phases = (res.template.phases ?? []).slice(0, MAX_PHASES).map((tp, i) => ({ ...newPhase(i + 1), name: tp.name ?? '', json: tp.json ?? '' }));
    if (!codes.phases.length) codes.phases = [newPhase(1)];
    codes.active = 0;
    codes.dates = {};
    codes.phases.forEach(schedulePreview);
    go('codes');
  }

  async function deleteTemplate(filename, label) {
    if (!confirm(`Delete template “${label}”?`)) return;
    const res = await api.deleteTemplate(filename);
    if (!res.ok) return setStatus(`Could not delete: ${res.error}`);
    await refreshTemplates();
    paint();
  }

  async function onSaveTemplate() {
    const l = currentLoadout();
    const res = await api.saveTemplate(l.name || 'Unnamed build', l.phases);
    if (!res.ok) return setStatus(`Could not save template: ${res.error}`);
    await refreshTemplates();
    setStatus('Template saved.', 'success');
  }

  async function onLoad() {
    if (!ready() || busy) return;
    if (isAdding()) return addFromMaxroll();
    busy = true;
    paintFooter();
    const l = currentLoadout();
    const res = await api.loadLoadout(l.phases, l.name || undefined, l.source ?? undefined, effectiveTarget());
    busy = false;
    if (!res.ok) { paintFooter(); return setStatus(res.error); }
    dialog.close();
    onLoaded(res);
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onLoad(); return; }
    if (e.key === 'ArrowLeft' && e.altKey && view !== 'choose') { e.preventDefault(); back(); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && view === 'codes') { e.preventDefault(); movePhase(codes.active, e.key === 'ArrowUp' ? -1 : 1); return; }
    if (view === 'choose' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && !(e.target instanceof HTMLInputElement)) {
      if (e.key === '1') { e.preventDefault(); go('maxroll'); }
      if (e.key === '2') { e.preventDefault(); go('codes'); }
    }
  }

  mount(dialog,
    h('div.dialog-card.dialog-loadout', { tabindex: '-1' },
      h('header.dialog-head.ld-head',
        h('div.ld-head-left', backBtn, h('div', h('h2', 'Load build'), crumb)),
        h('button.btn-icon', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, ui('x', { size: 18 }))),
      body,
      h('footer.dialog-foot',
        status,
        targetSlot,
        h('div.dialog-foot-actions', saveTplBtn, h('button.btn.btn-ghost', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), loadBtn),
      ),
    ),
  );

  // Shortcuts listen on the document while the dialog is open, so they work wherever focus is.
  const keys = (e) => { if (dialog.open) onKeyDown(e); };
  document.addEventListener('keydown', keys, true);
  dialog.addEventListener('close', () => document.removeEventListener('keydown', keys, true), { once: true });
  go('choose');
  dialog.showModal();
  refreshTemplates().then(() => { if (view === 'choose') paint(); });
  // A Maxroll link on the clipboard is offered on the choose screen (never fetched until asked).
  api.maxrollClipboardLink?.().then(res => {
    if (res?.ok && res.link) { clipboardLink = res.link; if (!mx.link) mx.link = res.link; if (view === 'choose') paint(); }
  });
}
