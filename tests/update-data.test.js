/**
 * tests/update-data.test.js
 * ──────────────────────────
 * scripts/update-data.js: the season label survives every shell (PowerShell strips `--`).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../scripts/update-data');

test('the label arrives whatever the shell did to it; other flags pass through', () => {
  const label = (argv, env) => parseArgs(argv, env).label;
  assert.equal(label(['Season 4 (1.4)']), 'Season 4 (1.4)');               // npm run data "Season 4 (1.4)"
  assert.equal(label(['Season', '4']), 'Season 4');                         // PowerShell: quotes and `--` lost
  assert.equal(label(['--label', 'Season 4']), 'Season 4');                 // bash: npm run data -- --label "Season 4"
  assert.equal(label(['--label=Season 4']), 'Season 4');
  assert.equal(label([], { npm_config_label: 'Season 4' }), 'Season 4');   // npm run data --label="Season 4"
  assert.equal(label([], { npm_config_label: 'true' }), null);              // bare --label swallowed by npm
  assert.equal(label([]), null);                                            // no label: extract.py keeps the last one
  assert.deepEqual(parseArgs(['--strict', 'Season', '4', '--verbose']).extractArgs, ['--strict', '--verbose', '--label', 'Season 4']);
  assert.deepEqual(parseArgs([]).extractArgs, []);
});
