/**
 * electron/maxroll.js
 * ────────────────────
 * Fetches a Maxroll Last Epoch planner by id (main process only — the renderer
 * CSP forbids network access). Decoding lives in shared/maxroll-import.js.
 *
 *   1. GET https://planners.maxroll.gg/profiles/le/<id> with Electron's net.fetch
 *      (Chromium network stack: same TLS fingerprint and proxy as a browser).
 *   2. If the answer is not JSON (a Cloudflare challenge page), load the same URL
 *      in a hidden, sandboxed window — the way a browser gets it — and read the text.
 *
 * The endpoint is undocumented. Requests are only made when the player asks,
 * with an identifying User-Agent and a short cache. Pasting Export codes stays
 * the fallback for every failure.
 *
 * Test hook: env LE_MAXROLL_FIXTURES=<dir> serves <dir>/<id>.json (or
 * maxroll-profile-le.json for any id) instead of the network.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { API_BASE } = require('../shared/maxroll-import');

const TIMEOUT_MS = 10000;
const CACHE_MS = 10 * 60 * 1000;
const USER_AGENT = 'LE-Build-Planner (desktop app; imports a planner when the user asks)';

class MaxrollError extends Error {
  constructor(message, { canOpen = false } = {}) {
    super(message);
    this.canOpen = canOpen; // UI offers "Open in browser"
  }
}

/**
 * @param {object} deps
 * @param {(url: string, init: object) => Promise<Response>} deps.fetch        — electron net.fetch
 * @param {(url: string) => Promise<string>} [deps.loadInWindow]              — hidden-window fallback
 * @param {string} [deps.fixturesDir]
 * @param {() => number} [deps.now]
 */
function createMaxrollClient({ fetch, loadInWindow = null, fixturesDir = null, now = Date.now }) {
  const cache = new Map(); // id → { at, json }

  async function fetchText(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: ctrl.signal });
      return { status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

  function fromFixture(id) {
    for (const f of [`${id}.json`, 'maxroll-profile-le.json']) {
      const file = path.join(fixturesDir, f);
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    throw new MaxrollError(`No fixture for planner “${id}”.`);
  }

  /** Raw planner JSON for an id. Throws MaxrollError with a player-facing message. */
  async function fetchPlanner(id) {
    const hit = cache.get(id);
    if (hit && now() - hit.at < CACHE_MS) return hit.json;
    if (fixturesDir) return fromFixture(id);

    const url = API_BASE + encodeURIComponent(id);
    let res = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try { res = await fetchText(url); } catch (err) { lastErr = err; }
    }
    if (!res) {
      throw new MaxrollError(lastErr?.name === 'AbortError'
        ? 'Maxroll did not answer in time. Try again, or use the Export codes.'
        : 'Could not reach Maxroll — are you offline?', { canOpen: true });
    }
    if (res.status === 404) throw new MaxrollError('No Maxroll planner with that link. Check the link, or that the planner is public.', { canOpen: true });

    let json = res.status === 200 ? parse(res.text) : null;
    if (!json && loadInWindow && (res.status === 200 || res.status === 403 || res.status === 503)) {
      // Not JSON: most likely a bot check. A real (hidden) browser window passes it.
      try { json = parse(await loadInWindow(url)); } catch { /* reported below */ }
    }
    if (!json) {
      throw new MaxrollError(res.status === 403 || res.status === 503
        ? 'Maxroll blocked the request. Open the planner in your browser and use Export instead.'
        : `Maxroll answered with something unexpected (HTTP ${res.status}).`, { canOpen: true });
    }
    // `public: false` only means "not listed in Maxroll's build database": a shared link still has the data.
    if (typeof json.data !== 'string' && typeof json.data !== 'object') {
      throw new MaxrollError('This planner has no readable data — it may be private. Make it public on Maxroll, or use the Export codes.', { canOpen: true });
    }
    cache.set(id, { at: now(), json });
    return json;
  }

  return { fetchPlanner };
}

/** Hidden-window fallback: let Chromium load the URL like a browser tab, then read the page text. */
function hiddenWindowLoader(BrowserWindow) {
  return (url) => new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true } });
    const done = (fn, v) => { clearTimeout(timer); if (!win.isDestroyed()) win.destroy(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error('timeout')), 20000);
    const tryRead = async () => {
      try {
        const text = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
        if (text.trim().startsWith('{')) done(resolve, text);
      } catch { /* page still loading */ }
    };
    // A bot check reloads the page once it passes: read after every load.
    win.webContents.on('did-finish-load', tryRead);
    win.loadURL(url).catch(() => {});
  });
}

module.exports = { createMaxrollClient, hiddenWindowLoader };
