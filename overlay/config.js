/**
 * overlay/config.js
 * ──────────────────
 * Renderer script for the config window (config.html).
 *
 * Two build-loading modes:
 *   A) URL tab   — user pastes a Maxroll planner URL; we fetch the build via IPC
 *   B) Manual tab — user pastes in-game export codes (or Maxroll export JSON)
 *
 * Communicates with main.js exclusively via window.configAPI (config-preload.js).
 * No require() — this is a renderer context.
 */

'use strict';

// ─── DOM references ───────────────────────────────────────────────────────────

const tabBtns          = document.querySelectorAll('.tab-btn');
const tabPanels        = document.querySelectorAll('.tab-panel');

// Tab A — URL
const urlInput         = document.getElementById('url-input');
const buildNameUrlEl   = document.getElementById('build-name-url');
const fetchBtn         = document.getElementById('fetch-btn');

// Tab B — Manual
const jsonInput        = document.getElementById('json-input');
const buildNameManual  = document.getElementById('build-name-manual');
const loadBtn          = document.getElementById('load-btn');
const clearBtn         = document.getElementById('clear-btn');

// Shared
const statusEl         = document.getElementById('status');

// ─── Tab switching ────────────────────────────────────────────────────────────

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabBtns.forEach(b  => b.classList.toggle('active',  b.dataset.tab === target));
    tabPanels.forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));
    clearStatus();
  });
});

// ─── Status helpers ───────────────────────────────────────────────────────────

function showError(msg) {
  statusEl.textContent = msg;
  statusEl.className   = 'error';
}

function showSuccess(msg) {
  statusEl.textContent = msg;
  statusEl.className   = 'success';
}

function showInfo(msg) {
  statusEl.textContent = msg;
  statusEl.className   = 'info';
}

function clearStatus() {
  statusEl.textContent = '';
  statusEl.className   = '';
}

// ─── Tab A: Fetch from URL ────────────────────────────────────────────────────

async function handleFetch() {
  const url       = urlInput.value.trim();
  const buildName = buildNameUrlEl.value.trim() || undefined;

  if (!url) {
    showError('Please paste a Maxroll planner URL.');
    urlInput.focus();
    return;
  }

  if (!url.includes('maxroll.gg')) {
    showError('URL must be a Maxroll planner link (maxroll.gg/last-epoch/planner/…).');
    urlInput.focus();
    return;
  }

  clearStatus();
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching…';
  showInfo('Downloading build from Maxroll…');

  try {
    // Step 1: fetch the raw Maxroll JSON from the URL (runs in main process)
    const fetchResult = await window.configAPI.fetchBuildUrl(url);

    if (!fetchResult.success) {
      showError(`Fetch failed: ${fetchResult.error}`);
      return;
    }

    showInfo('Build data downloaded. Parsing…');

    // Step 2: pass the raw JSON through the normal load-build pipeline
    const loadResult = await window.configAPI.loadBuild(fetchResult.json, buildName);

    if (loadResult.success) {
      showSuccess('Build loaded! The overlay has been updated.');
      // main.js closes the window after success
    } else {
      showError(loadResult.error || 'Failed to parse build data.');
    }
  } catch (err) {
    showError(`Unexpected error: ${err.message}`);
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch';
  }
}

fetchBtn.addEventListener('click', handleFetch);

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleFetch();
});

urlInput.addEventListener('input', () => {
  if (statusEl.className === 'error' || statusEl.className === 'info') clearStatus();
});

// ─── Tab B: Load from pasted codes ───────────────────────────────────────────

async function handleLoad() {
  const jsonString = jsonInput.value.trim();
  const buildName  = buildNameManual.value.trim() || undefined;

  if (!jsonString) {
    showError(
      'Please paste your export codes into the text area.\n' +
      'Export from the Maxroll planner, or use the in-game Import/Export dialog.'
    );
    return;
  }

  clearStatus();
  loadBtn.disabled    = true;
  loadBtn.textContent = 'Loading…';

  try {
    const result = await window.configAPI.loadBuild(jsonString, buildName);

    if (result.success) {
      showSuccess('Build loaded! The overlay has been updated.');
    } else {
      showError(result.error || 'Failed to load build. Check the export codes format.');
    }
  } catch (err) {
    showError(`Unexpected error: ${err.message}`);
  } finally {
    loadBtn.disabled    = false;
    loadBtn.textContent = 'Load Build';
  }
}

function handleClear() {
  jsonInput.value         = '';
  buildNameManual.value   = '';
  clearStatus();
  jsonInput.focus();
}

loadBtn.addEventListener('click', handleLoad);
clearBtn.addEventListener('click', handleClear);

// Ctrl+Enter submits from the textarea
jsonInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleLoad();
});

jsonInput.addEventListener('input', () => {
  if (statusEl.className === 'error') clearStatus();
});
