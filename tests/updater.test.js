/**
 * tests/updater.test.js
 * ──────────────────────
 * electron/updater.js with a fake electron-updater and a fake GitHub API.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createUpdater, compareVersions, describeError, CHECK_EVERY_MS, FIRST_CHECK_MS } = require('../electron/updater');

const quiet = { log() {}, error() {} };

function fakeAutoUpdater() {
  const u = new EventEmitter();
  u.checks = 0;
  u.installed = null;
  u.checkForUpdates = async () => { u.checks++; };
  u.quitAndInstall = (silent, relaunch) => { u.installed = { silent, relaunch }; };
  return u;
}

function fakeTimers() {
  const t = { timeouts: [], intervals: [], cleared: 0 };
  t.setTimeout = (fn, ms) => { t.timeouts.push({ fn, ms }); return t.timeouts.length; };
  t.setInterval = (fn, ms) => { t.intervals.push({ fn, ms }); return t.intervals.length; };
  t.clearTimeout = () => { t.cleared++; };
  t.clearInterval = () => { t.cleared++; };
  return t;
}

describe('compareVersions', () => {
  test('numeric, with or without v, pre-release tags ignored', () => {
    assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
    assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
    assert.equal(compareVersions('0.1.9', 'v0.2.0'), -1);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.1.0-beta.1', '1.0.9'), 1);
  });
});

describe('describeError: a manual check says why it failed', () => {
  test('offline, a release GitHub can’t serve, or the raw reason', () => {
    assert.match(describeError(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })), /offline/);
    assert.match(describeError(new Error('net::ERR_INTERNET_DISCONNECTED')), /offline/);
    // v0.2.0: two releases under one tag, latest.yml in the other one → 404
    const missing = Object.assign(new Error('Cannot find latest.yml in the latest release artifacts (…/v0.2.0/latest.yml): HttpError: 404'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    assert.match(describeError(missing), /download page isn’t ready/);
    assert.doesNotMatch(describeError(missing), /offline/);
    assert.equal(describeError(new Error('Something odd\nstack…')), 'Couldn’t check for updates: Something odd');
  });
});

describe('createUpdater — installer', () => {
  test('downloads in the background, installs only when asked; auto-install on quit is on', async () => {
    const u = fakeAutoUpdater();
    const states = [];
    const up = createUpdater({ mode: 'installer', currentVersion: '0.1.0', emit: (s) => states.push(s), autoUpdater: u, log: quiet });
    assert.equal(u.autoDownload, true);
    assert.equal(u.autoInstallOnAppQuit, true);
    await up.check();
    assert.equal(u.checks, 1);
    u.emit('checking-for-update');
    u.emit('update-available', { version: '0.2.0' });
    u.emit('download-progress', { percent: 42.4 });
    assert.deepEqual(up.getState(), { state: 'downloading', version: '0.2.0', progress: 42, current: '0.1.0' });
    assert.equal(u.installed, null, 'never restarts by itself');
    u.emit('update-downloaded', { version: '0.2.0' });
    assert.equal(up.getState().state, 'ready');
    assert.equal(up.install(), true);
    assert.deepEqual(u.installed, { silent: true, relaunch: true });
  });

  test('background errors stay quiet; a manual check reports them', async () => {
    const u = fakeAutoUpdater();
    const up = createUpdater({ mode: 'installer', currentVersion: '0.1.0', emit() {}, autoUpdater: u, log: quiet });
    await up.check(false);
    u.emit('error', new Error('offline'));
    assert.equal(up.getState().state, 'idle');
    await up.check(true);
    u.emit('error', new Error('offline'));
    assert.equal(up.getState().state, 'error');
  });

  test('a manual check that finds nothing says so; install() does nothing until ready', async () => {
    const u = fakeAutoUpdater();
    const up = createUpdater({ mode: 'installer', currentVersion: '0.1.0', emit() {}, autoUpdater: u, log: quiet });
    assert.equal(up.install(), false);
    await up.check(true);
    u.emit('update-not-available');
    assert.deepEqual(up.getState(), { state: 'idle', upToDate: true, current: '0.1.0' });
  });

  test('checks 10 s after start, then every 6 h; stop() clears both', () => {
    const t = fakeTimers();
    const up = createUpdater({ mode: 'installer', currentVersion: '0.1.0', emit() {}, autoUpdater: fakeAutoUpdater(), timers: t, log: quiet });
    up.start();
    assert.deepEqual([t.timeouts[0].ms, t.intervals[0].ms], [FIRST_CHECK_MS, CHECK_EVERY_MS]);
    up.stop();
    assert.equal(t.cleared, 2);
  });
});

describe('createUpdater — portable and off', () => {
  const release = (tag) => async () => ({ ok: true, json: async () => ({ tag_name: tag, html_url: `https://github.com/x/releases/${tag}` }) });

  test('portable: a newer GitHub release is offered with its page', async () => {
    const up = createUpdater({ mode: 'portable', currentVersion: '0.1.0', emit() {}, fetch: release('v0.3.0'), log: quiet });
    await up.check();
    assert.deepEqual(up.getState(), { state: 'available', version: '0.3.0', url: 'https://github.com/x/releases/v0.3.0', current: '0.1.0' });
    assert.equal(up.install(), false, 'a portable exe is never replaced in place');
  });

  test('portable: same or older release = up to date; network errors only reported when asked', async () => {
    const same = createUpdater({ mode: 'portable', currentVersion: '0.3.0', emit() {}, fetch: release('v0.3.0'), log: quiet });
    await same.check(true);
    assert.equal(same.getState().upToDate, true);
    const down = createUpdater({ mode: 'portable', currentVersion: '0.3.0', emit() {}, fetch: async () => { throw new Error('offline'); }, log: quiet });
    await down.check(false);
    assert.equal(down.getState().state, 'idle');
    await down.check(true);
    assert.equal(down.getState().state, 'error');
  });

  test('off: never checks, never schedules', async () => {
    const t = fakeTimers();
    const u = fakeAutoUpdater();
    const up = createUpdater({ mode: 'off', currentVersion: '0.1.0', emit() {}, autoUpdater: u, timers: t, log: quiet });
    up.start();
    await up.check(true);
    assert.equal(u.checks, 0);
    assert.equal(t.timeouts.length + t.intervals.length, 0);
    assert.equal(up.getState().state, 'off');
  });
});
