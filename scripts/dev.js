/**
 * scripts/dev.js
 * ───────────────
 * Development launcher: starts the app with --dev, which opens DevTools
 * (detached) and enables Electron logging.
 *
 * Usage:  node scripts/dev.js
 *   OR:   npm run dev
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Run Electron's own CLI with Node: works on every OS (the .bin/electron shim is a
// shell script Windows can't spawn) and downloads the binary on first use (Electron 42+).
const electronCli = require.resolve('electron/cli.js', { paths: [path.join(__dirname, '..')] });

// Pass --dev flag so main.js can detect dev mode and open DevTools
const proc = spawn(process.execPath, [electronCli, '.', '--dev'], {
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
