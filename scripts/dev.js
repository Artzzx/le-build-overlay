/**
 * scripts/dev.js
 * ───────────────
 * Development launcher for the overlay.
 * Starts Electron with DevTools open and a shorter hotkey set to avoid
 * conflicting with other apps while developing.
 *
 * Usage:  node scripts/dev.js
 *   OR:   npm run dev
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const electronBin = require.resolve('.bin/electron', {
  paths: [path.join(__dirname, '..', 'node_modules')],
});

// Pass --dev flag so main.js can detect dev mode and open DevTools
const proc = spawn(electronBin, ['.', '--dev'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    NODE_ENV: 'development',
  },
});

proc.on('close', (code) => {
  process.exit(code);
});
