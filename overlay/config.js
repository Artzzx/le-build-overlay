/**
 * overlay/config.js
 * ──────────────────
 * Renderer script for the config window (config.html).
 *
 * Manages accordion phase cards. Each phase card has a label input and a textarea
 * for pasting raw Maxroll export codes (one JSON block per line).
 *
 * On submit: collects all phase { name, json } pairs and calls
 * window.configAPI.loadLoadout(phases, loadoutName) → main.js parses and saves.
 *
 * Communicates with main.js exclusively via window.configAPI (config-preload.js).
 */

'use strict';

const MAX_PHASES = 5;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const phaseListEl       = document.getElementById('phase-list');
const addPhaseBtn       = document.getElementById('add-phase-btn');
const loadBtn           = document.getElementById('load-btn');
const saveTemplateBtn   = document.getElementById('save-template-btn');
const loadoutNameEl     = document.getElementById('loadout-name');
const statusEl          = document.getElementById('status');
const templateSelectEl  = document.getElementById('template-select');
const templateLoadBtn   = document.getElementById('template-load-btn');
const templateDelBtn    = document.getElementById('template-del-btn');

// ─── Phase card management ────────────────────────────────────────────────────

let phaseCount = 0;

/**
 * Add a new phase card at the bottom of the list.
 * The card is expanded by default; existing cards collapse.
 */
function addPhase() {
  if (phaseCount >= MAX_PHASES) return;

  phaseCount++;
  const idx = phaseCount; // 1-based display index

  // Collapse all existing cards
  phaseListEl.querySelectorAll('.phase-card').forEach(c => collapse(c));

  const card = document.createElement('div');
  card.className = 'phase-card'; // expanded by default
  card.dataset.phaseIdx = idx;

  // Header
  const header = document.createElement('div');
  header.className = 'phase-header';

  const indexLabel = document.createElement('span');
  indexLabel.className = 'phase-index-label';
  indexLabel.textContent = `Phase ${idx}`;
  header.appendChild(indexLabel);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'phase-name-input';
  nameInput.placeholder = idx === 1 ? 'e.g. Leveling' : idx === 2 ? 'e.g. Endgame' : `Phase ${idx}`;
  nameInput.maxLength = 40;
  header.appendChild(nameInput);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'phase-toggle-btn';
  toggleBtn.title = 'Collapse';
  toggleBtn.textContent = '▲';
  header.appendChild(toggleBtn);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'phase-remove-btn';
  removeBtn.title = 'Remove phase';
  removeBtn.textContent = '✕';
  removeBtn.disabled = idx === 1; // first card cannot be removed initially
  header.appendChild(removeBtn);

  card.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'phase-body';

  const bodyLabel = document.createElement('label');
  bodyLabel.textContent = 'Export codes (one JSON block per line)';
  body.appendChild(bodyLabel);

  const textarea = document.createElement('textarea');
  textarea.className = 'phase-json';
  textarea.spellcheck = false;
  textarea.placeholder =
    'Paste your export codes here — one JSON block per line.\n\n' +
    'From Maxroll planner:  click Export and copy all lines.\n' +
    'From in-game dialog:   export Passives tab, then each Skill tab.';
  body.appendChild(textarea);

  card.appendChild(body);
  phaseListEl.appendChild(card);

  // Wire up toggle: clicking the header (not inputs/buttons) toggles
  header.addEventListener('click', (e) => {
    if (e.target === nameInput || e.target === toggleBtn || e.target === removeBtn) return;
    toggleCard(card);
  });
  toggleBtn.addEventListener('click', () => toggleCard(card));

  removeBtn.addEventListener('click', () => removePhase(card));

  // Ctrl+Enter in any textarea submits
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleLoad();
  });

  // Update add button visibility
  updateAddButton();
  updateRemoveButtons();

  // Scroll new card into view
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  textarea.focus();
}

function collapse(card) {
  card.classList.add('collapsed');
  const btn = card.querySelector('.phase-toggle-btn');
  if (btn) { btn.textContent = '▼'; btn.title = 'Expand'; }
}

function expand(card) {
  card.classList.remove('collapsed');
  const btn = card.querySelector('.phase-toggle-btn');
  if (btn) { btn.textContent = '▲'; btn.title = 'Collapse'; }
}

function toggleCard(card) {
  if (card.classList.contains('collapsed')) {
    expand(card);
  } else {
    collapse(card);
  }
}

function removePhase(card) {
  card.remove();
  phaseCount--;
  renumberCards();
  updateAddButton();
  updateRemoveButtons();
}

function renumberCards() {
  const cards = phaseListEl.querySelectorAll('.phase-card');
  cards.forEach((card, i) => {
    const n = i + 1;
    card.dataset.phaseIdx = n;
    const label = card.querySelector('.phase-index-label');
    if (label) label.textContent = `Phase ${n}`;
  });
}

function updateAddButton() {
  addPhaseBtn.disabled = phaseCount >= MAX_PHASES;
  addPhaseBtn.title = phaseCount >= MAX_PHASES ? `Maximum ${MAX_PHASES} phases` : '';
}

function updateRemoveButtons() {
  const cards = phaseListEl.querySelectorAll('.phase-card');
  cards.forEach((card, i) => {
    const btn = card.querySelector('.phase-remove-btn');
    if (btn) btn.disabled = cards.length === 1; // can't remove the only card
  });
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function showError(msg) {
  statusEl.textContent = msg;
  statusEl.className   = 'error';
}

function showSuccess(msg) {
  statusEl.textContent = msg;
  statusEl.className   = 'success';
}

function clearStatus() {
  statusEl.textContent = '';
  statusEl.className   = '';
}

// ─── Saved templates ─────────────────────────────────────────────────────────

/**
 * Reload the template dropdown from disk.
 */
async function refreshTemplates() {
  if (!window.configAPI?.listTemplates) return;
  const result = await window.configAPI.listTemplates();
  templateSelectEl.innerHTML = '';

  if (!result.success || result.list.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no saved templates —';
    templateSelectEl.appendChild(opt);
    templateLoadBtn.disabled = true;
    templateDelBtn.disabled  = true;
    return;
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— select a template —';
  templateSelectEl.appendChild(placeholder);

  for (const { filename, loadoutName, savedAt, phaseCount } of result.list) {
    const opt = document.createElement('option');
    opt.value = filename;
    const date = savedAt ? new Date(savedAt).toLocaleDateString() : '';
    opt.textContent = `${loadoutName} (${phaseCount} phase${phaseCount !== 1 ? 's' : ''}${date ? ' · ' + date : ''})`;
    templateSelectEl.appendChild(opt);
  }

  const hasSelection = () => !!templateSelectEl.value;
  templateLoadBtn.disabled = !hasSelection();
  templateDelBtn.disabled  = !hasSelection();
}

/**
 * Pre-fill the form with a saved template's data.
 * Does NOT immediately load the loadout — user must still click "Load Loadout".
 */
async function fillFromTemplate() {
  const filename = templateSelectEl.value;
  if (!filename || !window.configAPI?.loadTemplate) return;

  const result = await window.configAPI.loadTemplate(filename);
  if (!result.success) {
    showError(`Could not load template: ${result.error}`);
    return;
  }

  const { loadoutName, phases } = result.template;

  // Clear existing phase cards
  phaseListEl.innerHTML = '';
  phaseCount = 0;

  // Set loadout name
  loadoutNameEl.value = loadoutName || '';

  // Recreate phase cards from template
  for (const phase of (phases || [])) {
    addPhase();
    const card = phaseListEl.querySelectorAll('.phase-card')[phaseCount - 1];
    if (!card) continue;
    const nameInput = card.querySelector('.phase-name-input');
    const textarea  = card.querySelector('.phase-json');
    if (nameInput) nameInput.value = phase.name || '';
    if (textarea)  textarea.value  = phase.json  || '';
  }

  clearStatus();
  showSuccess('Template loaded into form. Edit if needed, then click "Load Loadout".');
}

/**
 * Save the current form inputs as a reusable template.
 */
async function handleSaveTemplate() {
  if (!window.configAPI?.saveTemplate) return;

  const loadoutName = loadoutNameEl.value.trim() || 'Unnamed Loadout';
  const cards = phaseListEl.querySelectorAll('.phase-card');
  const phases = [];

  for (const card of cards) {
    const nameInput = card.querySelector('.phase-name-input');
    const textarea  = card.querySelector('.phase-json');
    phases.push({
      name: nameInput?.value.trim() || `Phase ${phases.length + 1}`,
      json: textarea?.value.trim() || '',
    });
  }

  saveTemplateBtn.disabled    = true;
  saveTemplateBtn.textContent = 'Saving…';

  try {
    const result = await window.configAPI.saveTemplate(loadoutName, phases);
    if (result.success) {
      clearStatus();
      showSuccess(`Template "${loadoutName}" saved.`);
      await refreshTemplates();
    } else {
      showError(`Save failed: ${result.error}`);
    }
  } finally {
    saveTemplateBtn.disabled    = false;
    saveTemplateBtn.textContent = 'Save Template';
  }
}

/**
 * Delete the currently selected saved template after confirmation.
 */
async function handleDeleteTemplate() {
  const filename = templateSelectEl.value;
  if (!filename || !window.configAPI?.deleteTemplate) return;

  const name = templateSelectEl.options[templateSelectEl.selectedIndex]?.textContent ?? filename;
  if (!confirm(`Delete saved template "${name}"?`)) return;

  const result = await window.configAPI.deleteTemplate(filename);
  if (result.success) {
    await refreshTemplates();
    clearStatus();
  } else {
    showError(`Delete failed: ${result.error}`);
  }
}

// ─── Submit ───────────────────────────────────────────────────────────────────

async function handleLoad() {
  clearStatus();

  const loadoutName = loadoutNameEl.value.trim() || undefined;

  // Collect phases from cards
  const cards = phaseListEl.querySelectorAll('.phase-card');
  const phases = [];

  for (const card of cards) {
    const nameInput = card.querySelector('.phase-name-input');
    const textarea  = card.querySelector('.phase-json');
    const json      = textarea.value.trim();
    const name      = nameInput.value.trim() || `Phase ${phases.length + 1}`;

    if (!json) {
      showError(`Phase ${phases.length + 1} (${name}) is empty. Paste export codes for every phase.`);
      // Expand the card with the issue
      expand(card);
      textarea.focus();
      return;
    }

    phases.push({ name, json });
  }

  if (phases.length === 0) {
    showError('Add at least one phase with export codes.');
    return;
  }

  loadBtn.disabled    = true;
  loadBtn.textContent = 'Loading…';

  try {
    const result = await window.configAPI.loadLoadout(phases, loadoutName);

    if (result.success) {
      showSuccess('Loadout loaded! The overlay has been updated.');
      // main.js closes the window after success
    } else {
      showError(result.error || 'Failed to load loadout. Check export codes format.');
    }
  } catch (err) {
    showError(`Unexpected error: ${err.message}`);
  } finally {
    loadBtn.disabled    = false;
    loadBtn.textContent = 'Load Loadout';
  }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

addPhaseBtn.addEventListener('click', addPhase);
loadBtn.addEventListener('click', handleLoad);
saveTemplateBtn.addEventListener('click', handleSaveTemplate);
templateLoadBtn.addEventListener('click', fillFromTemplate);
templateDelBtn.addEventListener('click', handleDeleteTemplate);

templateSelectEl.addEventListener('change', () => {
  const has = !!templateSelectEl.value;
  templateLoadBtn.disabled = !has;
  templateDelBtn.disabled  = !has;
});

// Ctrl+Enter from loadout name field also submits
loadoutNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleLoad();
});

// ─── Init — start with one phase card open ────────────────────────────────────

addPhase();
refreshTemplates();
