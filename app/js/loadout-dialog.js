/**
 * app/js/loadout-dialog.js
 * ─────────────────────────
 * "Load build" dialog (Ctrl+O). Four views in one wide, fixed-size modal:
 *
 *   choose  — two cards: "From a Maxroll link" | "From a share code"
 *             (+ templates saved before 0.4, + re-import the current Maxroll build)
 *   maxroll — link bar · left rail: planner variants (tick up to 6) ·
 *             right pane: the focused variant (class, level, skills with icons)
 *   share   — paste a share code (LEBP1.…); main fetches its guides fresh (share:preview)
 *             and the phases open in the phases workspace for review
 *   phases  — left rail: phases (+ add another Maxroll guide) · middle: phase name
 *             (move / remove) + where it comes from · right: its summary
 *
 * Export codes (one phase pasted at a time) were retired in 0.4: builds come from Maxroll
 * planners, which stay in sync, or from share codes, which carry their guides.
 *
 * Mixing guides (e.g. a leveling guide + an endgame guide): Maxroll → "Add another guide"
 * moves the ticked variants into the phases workspace, where "Add another guide" opens
 * the Maxroll view in *adding* mode to append another planner's variants. Each phase
 * keeps its origin ({ maxroll, variant, name }, or null for a phase with no guide behind
 * it), so every guide the build came from is checked for updates later (build.source,
 * see MaxrollImport.makeSource).
 *
 * Every view loads through api.loadLoadout(phases, name, source).
 * Each view keeps its state while the dialog is open (Back loses nothing).
 */

import { h, mount } from './dom.js';
import { ui, treeArt } from './icons.js';

const MAX_PHASES = 6;
const { makeSource } = window.MaxrollImport;

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
  let clipboardCode = null;

  // Phases workspace (planner variants, a share code's phases, an old template).
  // `dates` = each planner's last-save date. A phase: { name, json, preview, error, pending, origin, note }.
  const plan = { name: '', phases: [], active: 0, dates: {} };
  const newPhase = (n) => ({ name: '', json: '', preview: null, error: null, pending: false, origin: null, note: null, placeholder: n === 1 ? 'Leveling' : n === 2 ? 'Endgame' : `Phase ${n}` });

  // Share code view
  const share = { text: '', busy: false, error: null };

  // Maxroll workspace
  // adding = picking variants to append to the phases workspace (another guide).
  const mx = { link: '', busy: false, error: null, canOpen: false, planner: null, selected: new Set(), focus: 0, name: '', names: new Map(), adding: false };

  const body = h('div.ld-body');
  const status = h('div.dialog-status', { role: 'status' });
  const crumb = h('div.ld-crumb');
  const backBtn = h('button.btn.btn-ghost.btn-sm.ld-back', { type: 'button', onclick: () => back(), title: 'Back (Alt+←)' }, ui('chevronLeft', { size: 15 }), 'Back');
  const loadBtn = h('button.btn.btn-primary', { type: 'button', onclick: onLoad, title: 'Load (Ctrl+Enter)' });
  const targetSlot = h('div.ld-target');

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
    if (mx.adding) return plan.phases.find(p => p.preview)?.preview.classId ?? null;
    if (view === 'maxroll' && !mx.adding) return chosenVariants().find(v => v.summary)?.summary.classId ?? null;
    if (view === 'phases') return plan.phases.find(p => p.preview)?.preview.classId ?? null;
    return null;
  }

  function effectiveTarget() {
    if (target) return target;
    const incoming = incomingClassId();
    return currentClassId != null && incoming != null && incoming !== currentClassId ? 'new' : 'current';
  }

  function paintTarget() {
    targetSlot.hidden = view === 'choose' || view === 'share' || isAdding();
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

  /** Summaries for phases that arrive without one (old templates). */
  async function previewPhase(phase) {
    phase.pending = true;
    const res = await api.previewPhase(phase.json);
    phase.pending = false;
    if (res.ok) phase.preview = res.summary;
    else phase.error = res.error;
    if (view === 'phases') paint();
  }

  const isAdding = () => view === 'maxroll' && mx.adding;
  const filledPhases = () => plan.phases.filter(p => p.json.trim());
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
    if (view === 'share') return []; // its error shows inline, next to the code
    if (!plan.phases.length) return ['Add a guide’s variants to load.'];
    plan.phases.forEach((p) => {
      if (p.error) out.push(`${p.name || p.placeholder}: ${p.error}`);
    });
    // Same class in every phase; the mastery may change (e.g. plain Rogue while leveling, then Bladedancer).
    const classes = new Set(plan.phases.map(p => p.preview?.className).filter(Boolean));
    if (classes.size > 1) out.push(`All phases must be the same class (found ${[...classes].join(' and ')})`);
    return out;
  }

  const ready = () => {
    if (view === 'maxroll') return !!mx.planner && problems().length === 0;
    if (view === 'phases') return plan.phases.length > 0 && plan.phases.every(p => p.preview && !p.pending) && problems().length === 0;
    return false;
  };

  function paintFooter() {
    const n = view === 'maxroll' ? chosenVariants().length : plan.phases.length;
    const hasPhases = view === 'phases' || (view === 'maxroll' && mx.planner);
    const s = n !== 1 ? 's' : '';
    if (isAdding()) mount(loadBtn, ui('plus', { size: 16 }), `Add ${n} phase${s}`);
    else mount(loadBtn, ui('upload', { size: 16 }), hasPhases ? `Load ${n} phase${s}` : 'Load build');
    loadBtn.title = isAdding() ? 'Add to the phases (Ctrl+Enter)' : 'Load (Ctrl+Enter)';
    loadBtn.disabled = busy || !ready();
    loadBtn.hidden = view === 'choose' || view === 'share'; // nothing to load until there are phases
    backBtn.hidden = view === 'choose';
    mount(crumb, view === 'choose'
      ? h('span', 'Where does your build come from?')
      : isAdding()
        ? [h('span', 'Phases'), ui('chevronRight', { size: 14 }), h('b', 'Add from Maxroll')]
        : [h('span', 'Load build'), ui('chevronRight', { size: 14 }), h('b', { maxroll: 'From Maxroll', share: 'From a share code', phases: 'Phases' }[view])]);

    paintTarget();
    const issues = view === 'choose' ? [] : problems();
    const started = view === 'maxroll' ? !!mx.planner : plan.phases.length > 0;
    if (issues.length && started) setStatus(issues[0], plan.phases.some(p => p.error) ? 'error' : 'info');
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

    const codeClip = clipboardCode
      ? h('div.ld-clip',
        h('div.ld-clip-label', ui('info', { size: 13 }), 'Share code on your clipboard'),
        h('div.ld-clip-link', { title: clipboardCode }, `${clipboardCode.slice(0, 28)}…`),
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => { share.text = clipboardCode; go('share'); readShareCode(); } }, 'Use this code'))
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
        card('2', 'share', 'From a share code', 'Someone shared their build plan (LEBP1.…)? Paste it — every phase, in their order, synced with its guides.', {
          extra: codeClip ?? steps('Copy the whole code from Discord or wherever it was posted', 'The app fetches its guides fresh', 'Review the phases, then Load'),
          onPick: () => go('share'),
        }),
      ),
      templates.length || reimport
        ? h('div.ld-more',
          templates.length ? h('div.ld-templates',
            h('div.ld-more-label', 'Saved templates', h('span.muted', ' — from before share codes; not synced with a guide')),
            h('div.ld-template-list', templates.map(t => h('div.ld-template',
              h('button.ld-template-open', { type: 'button', onclick: () => fillTemplate(t.filename), title: 'Open its phases' },
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
        mx.canOpen ? h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => api.openMaxroll(mx.link) }, 'Open in browser') : null);
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
        type: 'button', disabled: !chosenVariants().length, onclick: toPhases,
        title: 'Combine these variants with another guide’s (e.g. a leveling guide), reorder or rename them',
      }, ui('plus', { size: 14 }), 'Add another guide'),
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
    );
  }

  // ─── View: share code ───────────────────────────────────────────────────────

  function shareView() {
    const input = h('textarea.code-input.ld-share-input', {
      spellcheck: 'false', rows: 4, 'aria-label': 'Share code',
      placeholder: 'LEBP1.…  — paste the whole code (a message around it is fine)',
      oninput: (e) => { share.text = e.target.value; share.error = null; readBtn.disabled = share.busy || !share.text.trim(); paintFooter(); },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); readShareCode(); } },
    });
    input.value = share.text;
    const readBtn = h('button.btn.btn-primary', { type: 'button', disabled: share.busy || !share.text.trim(), onclick: readShareCode },
      share.busy ? [h('span.spinner'), 'Fetching its guides…'] : 'Read code');
    return h('div.ld-share',
      h('div.ld-share-box',
        h('label.ld-name-label', { for: 'ld-share-code' }, 'Share code'),
        input,
        h('div.ld-share-actions', readBtn,
          h('span.muted', 'Guides are fetched fresh from Maxroll, so you get their latest version — and their updates later.'))),
      share.error
        ? h('div.preview.is-error', ui('alert', { size: 16 }), h('div', share.error))
        : h('details.help',
          h('summary', ui('info', { size: 15 }), 'Where do share codes come from?'),
          h('ol',
            h('li', 'In the app, the character menu (the name at the top left) › Share this build copies its code.'),
            h('li', 'Paste it anywhere: Discord, Reddit, a message. It holds the plan only — never anyone’s progress.'),
            h('li', 'Here, the phases open for review: reorder, rename or drop any, then Load.'))),
    );
  }

  // ─── View: phases ───────────────────────────────────────────────────────────

  let railSlot = null;

  function removePhase(i) {
    plan.phases.splice(i, 1);
    plan.active = Math.max(0, Math.min(plan.active, plan.phases.length - 1));
    paint();
  }

  /** Move / remove the selected phase (next to its name, so the rail stays readable). */
  function phaseTools(i) {
    const label = plan.phases[i].name || plan.phases[i].placeholder;
    return h('div.ld-phase-tools',
      plan.phases.length > 1 ? [
        h('button.btn-icon.btn-sm', { type: 'button', disabled: i === 0, 'aria-label': `Move ${label} earlier`, title: 'Earlier phase (Alt+↑)', onclick: () => movePhase(i, -1) }, ui('chevronUp', { size: 16 })),
        h('button.btn-icon.btn-sm', { type: 'button', disabled: i === plan.phases.length - 1, 'aria-label': `Move ${label} later`, title: 'Later phase (Alt+↓)', onclick: () => movePhase(i, 1) }, ui('chevronDown', { size: 16 })),
      ] : null,
      h('button.btn-icon.btn-sm', { type: 'button', 'aria-label': `Remove ${label}`, title: 'Remove this phase', onclick: () => removePhase(i) }, ui('trash', { size: 15 })));
  }

  function movePhase(i, d) {
    const j = i + d;
    if (j < 0 || j >= plan.phases.length) return;
    [plan.phases[i], plan.phases[j]] = [plan.phases[j], plan.phases[i]];
    plan.active = j;
    paint();
  }

  /** Where a phase came from, for the rail: its guide's name, or "no guide". */
  const originChip = (p) => (p.origin
    ? h('span.ld-chip.ld-origin', { title: `From the Maxroll planner “${p.origin.guide ?? p.origin.maxroll}” — checked for guide updates` }, p.origin.guide ?? 'Maxroll')
    : h('span.ld-chip.ld-origin.is-codes', { title: 'Not linked to a guide — it never changes by itself' }, 'no guide'));

  function originNote(p) {
    return h('div.ld-origin-slot',
      p.origin
        ? h('div.ld-origin-note', ui('info', { size: 13 }),
          h('span', 'From ', h('b', p.origin.guide ?? 'its Maxroll guide'), ` · ${p.origin.name}. Checked for guide updates.`))
        : h('div.ld-origin-note', ui('info', { size: 13 }), h('span', 'Not linked to a guide: this phase never changes by itself.')),
      p.note ? h('div.preview-warn', ui('alert', { size: 13 }), p.note) : null);
  }

  function phaseDot(p) {
    if (p.pending) return h('span.dot.is-pending', { title: 'Checking…' });
    if (p.error) return h('span.dot.is-error', { title: 'Has a problem' });
    if (p.preview) return h('span.dot.is-ok', { title: 'Looks good' });
    return h('span.dot', { title: 'Empty' });
  }

  function phaseRail() {
    return h('aside.ld-rail',
      h('div.ld-rail-head', h('span', 'Phases'), h('span.ld-count', { class: plan.phases.length >= MAX_PHASES ? 'is-full' : '' }, `${plan.phases.length} of ${MAX_PHASES}`)),
      h('div.ld-rail-list', plan.phases.map((p, i) => h('div.ld-rail-item', {
        class: i === plan.active ? 'is-focus' : '',
        onclick: () => { plan.active = i; paint(); },
      },
      phaseDot(p),
      h('div.ld-rail-text',
        h('div.ld-rail-name', p.name || p.placeholder),
        h('div.ld-rail-meta',
          p.preview ? `${p.preview.passivePoints} pts · ${p.preview.skills.length} skill${p.preview.skills.length !== 1 ? 's' : ''}` : p.error ? h('span.ld-err', 'has a problem') : 'checking…',
          originChip(p)))))),
      plan.phases.length < MAX_PHASES
        ? h('button.ld-add', { type: 'button', title: 'Add phases from another Maxroll planner (e.g. a leveling guide)', onclick: startAdding },
          ui('plus', { size: 14 }), 'Add another guide')
        : null,
    );
  }

  function phasePreview(p) {
    if (!p) return placeholder('plus', 'No phases', 'Add a guide’s variants with “Add another guide”.');
    if (p.pending) return placeholder('target', 'Checking…', null);
    if (p.error) return h('div.preview.is-error', ui('alert', { size: 16 }), h('div', h('b', 'Can’t read this phase. '), p.error));
    return summaryCard(p.preview);
  }

  function phasesView() {
    const p = plan.phases[plan.active];
    railSlot = h('div.ld-rail-slot', phaseRail());
    return h('div.ld-codes',
      h('div.ld-bar',
        h('div.ld-bar-row',
          h('label.ld-name', h('span.ld-name-label', 'Build name'),
            h('input.input', { type: 'text', maxlength: 60, placeholder: 'e.g. Void Knight Erasing Strike', value: plan.name, oninput: (e) => { plan.name = e.target.value; } })))),
      h('div.ld-split.ld-split-3',
        railSlot,
        p
          ? h('section.ld-editor',
            h('div.ld-editor-head',
              h('label.ld-name', h('span.ld-name-label', 'Phase name'),
                h('input.input', { type: 'text', maxlength: 40, placeholder: p.placeholder, value: p.name, oninput: (e) => { p.name = e.target.value; mount(railSlot, phaseRail()); } })),
              phaseTools(plan.active)),
            originNote(p))
          : h('section.ld-editor'),
        h('section.ld-pane.ld-pane-preview', phasePreview(p))),
    );
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
    mount(body, { choose: chooseView, maxroll: maxrollView, share: shareView, phases: phasesView }[view]());
    paintFooter();
    if (refocus) body.querySelector(refocus)?.focus();
    else if (body.contains(active) || active === document.body || active === dialog) {
      (view === 'choose' ? body.querySelector('.ld-choice') : dialog.querySelector('.dialog-card'))?.focus();
    }
  }

  /** Back: out of "add from Maxroll" to the phases, else to the choose screen. */
  function back() {
    if (isAdding()) { mx.adding = false; go('phases'); } else go('choose');
  }

  function go(next) {
    if (next !== 'maxroll') mx.adding = false;
    view = next;
    paint();
    requestAnimationFrame(() => {
      const target = next === 'maxroll' ? (mx.planner ? body.querySelector('.ld-rail-item input') : body.querySelector('.ld-link-input'))
        : next === 'share' ? body.querySelector('.ld-share-input')
          : next === 'phases' ? body.querySelector('.ld-rail-item.is-focus')
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

  /** Move the ticked variants into the phases workspace: to add another guide, reorder or rename. */
  function toPhases() {
    const chosen = chosenVariants();
    if (!chosen.length) return;
    plan.name = mx.name.trim() || mx.planner.name;
    plan.phases = chosen.map((v, i) => variantPhase(v, i + 1));
    plan.active = 0;
    plan.dates = plannerDates();
    go('phases');
  }

  /** Decode a share code in main (which fetches its guides fresh), then review its phases. */
  async function readShareCode() {
    if (share.busy || !share.text.trim()) return;
    Object.assign(share, { busy: true, error: null });
    paint();
    const res = await api.previewShareCode(share.text);
    share.busy = false;
    if (!res.ok) { share.error = res.error; paint(); return; }
    plan.name = res.name;
    plan.phases = res.phases.map((p, i) => ({ ...newPhase(i + 1), name: p.name, json: p.json, preview: p.summary, error: p.error, origin: p.origin, note: p.note }));
    plan.dates = res.dates ?? {};
    plan.active = 0;
    go('phases');
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
    plan.phases = [...kept, ...chosen.map((v, i) => variantPhase(v, kept.length + i + 1))];
    plan.dates = { ...plan.dates, ...plannerDates() };
    if (!plan.name.trim()) plan.name = mx.planner.name;
    plan.active = kept.length;
    mx.adding = false;
    go('phases');
  }

  /** What Load uses, from whichever workspace is open. */
  function currentLoadout() {
    if (view === 'maxroll') {
      return {
        name: mx.name.trim() || mx.planner.name,
        phases: chosenVariants().map(v => ({ name: variantName(v).slice(0, 40), json: v.json })),
        source: maxrollSource(),
      };
    }
    return {
      name: plan.name.trim(),
      phases: plan.phases.map(p => ({ name: p.name || p.placeholder, json: p.json })),
      source: makeSource(plan.phases.map(p => p.origin), plan.dates),
    };
  }

  async function refreshTemplates() {
    const res = await api.listTemplates();
    templates = res.ok ? res.list : [];
  }

  async function fillTemplate(filename) {
    const res = await api.loadTemplate(filename);
    if (!res.ok) return setStatus(`Could not open template: ${res.error}`);
    plan.name = res.template.loadoutName ?? '';
    plan.phases = (res.template.phases ?? []).slice(0, MAX_PHASES).filter(tp => String(tp.json ?? '').trim())
      .map((tp, i) => ({ ...newPhase(i + 1), name: tp.name ?? '', json: tp.json }));
    plan.active = 0;
    plan.dates = {};
    plan.phases.forEach(previewPhase);
    go('phases');
  }

  async function deleteTemplate(filename, label) {
    if (!confirm(`Delete template “${label}”?`)) return;
    const res = await api.deleteTemplate(filename);
    if (!res.ok) return setStatus(`Could not delete: ${res.error}`);
    await refreshTemplates();
    paint();
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
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && view === 'phases') { e.preventDefault(); movePhase(plan.active, e.key === 'ArrowUp' ? -1 : 1); return; }
    if (view === 'choose' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && !(e.target instanceof HTMLInputElement)) {
      if (e.key === '1') { e.preventDefault(); go('maxroll'); }
      if (e.key === '2') { e.preventDefault(); go('share'); }
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
        h('div.dialog-foot-actions', h('button.btn.btn-ghost', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), loadBtn),
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
  // A Maxroll link or a share code on the clipboard is offered on the choose screen (never read until asked).
  api.maxrollClipboardLink?.().then(res => {
    if (!res?.ok) return;
    if (res.link) { clipboardLink = res.link; if (!mx.link) mx.link = res.link; }
    if (res.code) { clipboardCode = res.code; if (!share.text) share.text = res.code; }
    if ((res.link || res.code) && view === 'choose') paint();
  });
}
