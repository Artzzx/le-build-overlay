/**
 * overlay/config.js
 * ──────────────────
 * Renderer script for the config window (config.html).
 * Handles the "Load Build" form: reads user input, calls configAPI.loadBuild(),
 * and shows success/error feedback.
 *
 * Communicates with main.js exclusively via window.configAPI (set up in config-preload.js).
 * No require() — this runs in the renderer context.
 */

'use strict';

const jsonInput = document.getElementById('json-input');
const buildNameInput = document.getElementById('build-name');
const loadBtn = document.getElementById('load-btn');
const clearBtn = document.getElementById('clear-btn');
const statusEl = document.getElementById('status');

// ─── UI helpers ───────────────────────────────────────────────────────────────

function showError(message) {
  statusEl.textContent = message;
  statusEl.className = 'error';
}

function showSuccess(message) {
  statusEl.textContent = message;
  statusEl.className = 'success';
}

function clearStatus() {
  statusEl.textContent = '';
  statusEl.className = '';
}

function setLoading(loading) {
  loadBtn.disabled = loading;
  loadBtn.textContent = loading ? 'Loading…' : 'Load Build';
}

// ─── Load handler ─────────────────────────────────────────────────────────────

async function handleLoad() {
  const jsonString = jsonInput.value.trim();
  const buildName = buildNameInput.value.trim() || undefined;

  if (!jsonString) {
    showError('Please paste your Maxroll build JSON into the text area.');
    return;
  }

  clearStatus();
  setLoading(true);

  try {
    const result = await window.configAPI.loadBuild(jsonString, buildName);

    if (result.success) {
      showSuccess('Build loaded! The overlay has been updated.');
      // Window will be closed by main.js after success; show message briefly in case of delay
    } else {
      showError(result.error || 'Failed to load build. Check the JSON format.');
    }
  } catch (err) {
    showError(`Unexpected error: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

// ─── Clear handler ────────────────────────────────────────────────────────────

function handleClear() {
  jsonInput.value = '';
  buildNameInput.value = '';
  clearStatus();
  jsonInput.focus();
}

// ─── Event listeners ──────────────────────────────────────────────────────────

loadBtn.addEventListener('click', handleLoad);
clearBtn.addEventListener('click', handleClear);

// Allow Ctrl+Enter to submit from the textarea
jsonInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    handleLoad();
  }
});

// Clear error styling on input
jsonInput.addEventListener('input', () => {
  if (statusEl.className === 'error') clearStatus();
});
