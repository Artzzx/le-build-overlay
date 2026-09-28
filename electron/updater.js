/**
 * electron/updater.js
 * ────────────────────
 * App updates, published as GitHub Releases (electron-builder `publish`).
 *
 *   installer — electron-updater: checks, downloads in the background, installs on
 *               quit. The player can restart right away from the status bar, but
 *               the app never restarts on its own: they may be mid-fight.
 *   portable  — a portable exe can't replace itself: compare with the latest
 *               GitHub release and offer its download page.
 *   off       — dev runs, test profiles (LE_USER_DATA) and the Settings toggle.
 *
 * Dependencies are injected (like hotkeys.js / maxroll.js) so this is tested
 * without Electron. State goes to the renderer through `emit(state)`:
 *   { state: 'off'|'idle'|'checking'|'downloading'|'ready'|'available'|'error',
 *     version?, progress?, url?, error?, current }
 */

'use strict';

const RELEASES_API = 'https://api.github.com/repos/Artzzx/le-build-overlay/releases/latest';
const FIRST_CHECK_MS = 10 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const OFFLINE_RE = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_PROXY/i;

/**
 * What a manual check says when it fails: offline, a release the server can't serve
 * (missing latest.yml, no published version), or the raw reason — never a guess.
 */
function describeError(err) {
  const code = err?.code ?? '';
  const msg = String(err?.message ?? err ?? '');
  if (OFFLINE_RE.test(code) || OFFLINE_RE.test(msg)) return 'Couldn’t check for updates — you seem to be offline.';
  if (/ERR_UPDATER_(CHANNEL_FILE_NOT_FOUND|LATEST_VERSION_NOT_FOUND|NO_PUBLISHED_VERSIONS|INVALID_RELEASE_FEED)/.test(code) || /HTTP (403|404)/.test(msg)) {
    return 'Couldn’t check for updates: the download page isn’t ready (try again in a few minutes).';
  }
  const first = msg.split('\n')[0].slice(0, 140);
  return `Couldn’t check for updates${first ? `: ${first}` : '.'}`;
}

/** Compare "1.2.10" with "v1.2.9" → 1 / 0 / -1 (numeric parts only; pre-release tags ignored). */
function compareVersions(a, b) {
  const parts = (v) => String(v ?? '').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * @param {object} o
 * @param {'installer'|'portable'|'off'} o.mode
 * @param {string} o.currentVersion
 * @param {(state) => void} o.emit
 * @param {object} [o.autoUpdater]           — electron-updater's autoUpdater (installer mode)
 * @param {(url, init) => Promise<Response>} [o.fetch] — net.fetch (portable mode)
 * @param {{ setTimeout, setInterval, clearTimeout, clearInterval }} [o.timers]
 * @param {Console} [o.log]
 */
function createUpdater({ mode, currentVersion, emit, autoUpdater = null, fetch = null, timers = globalThis, log = console }) {
  let status = { state: mode === 'off' ? 'off' : 'idle', current: currentVersion };
  let firstTimer = null;
  let everyTimer = null;
  let manual = false;

  const set = (next) => {
    status = { ...next, current: currentVersion };
    emit(status);
  };

  if (mode === 'installer' && autoUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // installs when the player closes the app
    autoUpdater.on('checking-for-update', () => { if (status.state !== 'ready') set({ state: 'checking' }); });
    autoUpdater.on('update-not-available', () => { if (status.state !== 'ready') set({ state: 'idle', upToDate: manual }); manual = false; });
    autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info?.version, progress: 0 }));
    autoUpdater.on('download-progress', (p) => { if (status.state === 'downloading') set({ ...status, progress: Math.round(p?.percent ?? 0) }); });
    autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info?.version }));
    autoUpdater.on('error', (err) => {
      log.error('[updater]', err?.message ?? err);
      // Background failures stay quiet (offline, GitHub down); a manual check reports them.
      if (status.state !== 'ready') set(manual ? { state: 'error', error: describeError(err) } : { state: 'idle' });
      manual = false;
    });
  }

  async function checkPortable() {
    set({ state: 'checking' });
    try {
      const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LE-Build-Planner' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rel = await res.json();
      if (rel?.tag_name && compareVersions(rel.tag_name, currentVersion) > 0) {
        set({ state: 'available', version: String(rel.tag_name).replace(/^v/i, ''), url: rel.html_url });
      } else {
        set({ state: 'idle', upToDate: manual });
      }
    } catch (err) {
      log.error('[updater]', err.message);
      set(manual ? { state: 'error', error: describeError(err) } : { state: 'idle' });
    }
    manual = false;
  }

  /** Check now. `isManual` = the player asked (answers "up to date" / errors). */
  async function check(isManual = false) {
    if (mode === 'off' || status.state === 'ready' || status.state === 'downloading') return status;
    manual = isManual;
    if (mode === 'portable') return checkPortable();
    try { await autoUpdater.checkForUpdates(); } catch { /* reported through the 'error' event */ }
    return status;
  }

  function start() {
    if (mode === 'off') return;
    firstTimer = timers.setTimeout(() => check(false), FIRST_CHECK_MS);
    everyTimer = timers.setInterval(() => check(false), CHECK_EVERY_MS);
  }

  function stop() {
    if (firstTimer) timers.clearTimeout(firstTimer);
    if (everyTimer) timers.clearInterval(everyTimer);
  }

  /** Installer: restart into the downloaded version now (only when the player clicks). */
  function install() {
    if (mode !== 'installer' || status.state !== 'ready') return false;
    autoUpdater.quitAndInstall(true, true); // silent installer, relaunch after
    return true;
  }

  return { start, stop, check, install, getState: () => status };
}

module.exports = { createUpdater, compareVersions, describeError, RELEASES_API, FIRST_CHECK_MS, CHECK_EVERY_MS };
