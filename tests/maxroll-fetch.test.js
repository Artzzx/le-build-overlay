/**
 * tests/maxroll-fetch.test.js
 * ────────────────────────────
 * electron/maxroll.js with a stubbed fetch (no network, no Electron).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createMaxrollClient } = require('../electron/maxroll');

const reply = (status, body) => async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const OK = { id: 'abc12345', game: 'le', public: true, data: '{"profiles":[]}' };

describe('createMaxrollClient.fetchPlanner', () => {
  test('GETs the LE profile endpoint with an identifying User-Agent, and caches', async () => {
    const calls = [];
    const client = createMaxrollClient({ fetch: async (url, init) => { calls.push([url, init.headers['User-Agent']]); return reply(200, OK)(); } });
    assert.deepEqual(await client.fetchPlanner('abc12345'), OK);
    await client.fetchPlanner('abc12345');
    assert.equal(calls.length, 1, 'second call served from cache');
    assert.equal(calls[0][0], 'https://planners.maxroll.gg/profiles/le/abc12345');
    assert.match(calls[0][1], /LE-Build-Planner/);
  });

  test('404 → "no planner" error that offers the browser', async () => {
    const client = createMaxrollClient({ fetch: reply(404, 'nope') });
    await assert.rejects(client.fetchPlanner('abc12345'), (err) => /No Maxroll planner/.test(err.message) && err.canOpen);
  });

  test('a bot-check page falls back to the hidden window', async () => {
    let used = null;
    const client = createMaxrollClient({ fetch: reply(403, '<html>Just a moment…</html>'), loadInWindow: async (url) => { used = url; return JSON.stringify(OK); } });
    assert.deepEqual(await client.fetchPlanner('abc12345'), OK);
    assert.equal(used, 'https://planners.maxroll.gg/profiles/le/abc12345');
  });

  test('blocked with no way around → clear error', async () => {
    const client = createMaxrollClient({ fetch: reply(403, '<html></html>'), loadInWindow: async () => '<html></html>' });
    await assert.rejects(client.fetchPlanner('abc12345'), /blocked/);
  });

  test('unlisted vs dataless planners, and network failures (retried once)', async () => {
    assert.deepEqual(await createMaxrollClient({ fetch: reply(200, { ...OK, public: false }) }).fetchPlanner('abc12345'), { ...OK, public: false }, 'unlisted still imports');
    await assert.rejects(createMaxrollClient({ fetch: reply(200, { id: 'abc12345', error: 'forbidden' }) }).fetchPlanner('abc12345'), /private/);
    let n = 0;
    const offline = createMaxrollClient({ fetch: async () => { n++; throw new TypeError('net::ERR_INTERNET_DISCONNECTED'); } });
    await assert.rejects(offline.fetchPlanner('abc12345'), /offline/);
    assert.equal(n, 2);
  });

  test('LE_MAXROLL_FIXTURES serves the committed fixture instead of the network', async () => {
    const client = createMaxrollClient({ fetch: async () => { throw new Error('network used'); }, fixturesDir: path.join(__dirname, 'fixtures') });
    assert.equal((await client.fetchPlanner('sb62zd0e')).id, 'sb62zd0e');
  });
});
