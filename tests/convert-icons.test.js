/**
 * tests/convert-icons.test.js
 * ────────────────────────────
 * Runs extractor/convert_icons.py on generated images (temp dir), then checks
 * that extract.py still resolves the original ".png" icon values to the new
 * ".webp" files. Skipped when python3 + Pillow (with WebP) are not installed.
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONVERT = path.join(ROOT, 'extractor', 'convert_icons.py');
const EXTRACT = path.join(ROOT, 'extractor', 'extract.py');
const PYTHON = ['python3', 'python'].find(bin =>
  spawnSync(bin, ['-c', 'from PIL import features; assert features.check("webp")']).status === 0);

const py = (code) => spawnSync(PYTHON, ['-c', code], { encoding: 'utf8' });
const run = (script, args) => spawnSync(PYTHON, [script, ...args], { encoding: 'utf8' });

/** Pillow facts about an image: [format, mode, width, height]. */
function probe(file) {
  const r = py(`from PIL import Image\nim = Image.open(${JSON.stringify(file)})\nprint(im.format, im.mode, im.width, im.height)`);
  return r.stdout.trim().split(' ');
}

describe('convert_icons.py', { skip: !PYTHON && 'python3 with Pillow (WebP) not installed' }, () => {
  let dir;
  let icons;
  const file = (rel) => path.join(icons, rel);

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-icons-'));
    icons = path.join(dir, 'icons');
    const r = py(`
from PIL import Image
import os
d = ${JSON.stringify(icons)}
os.makedirs(d + '/es6ai', exist_ok=True)
os.makedirs(d + '/fl44', exist_ok=True)
Image.new('RGBA', (128, 128), (40, 160, 255, 128)).save(d + '/es6ai/12.png')        # alpha
Image.effect_noise((256, 256), 60).convert('RGB').save(d + '/es6ai/13.png')          # oversized
Image.new('RGB', (128, 128), (255, 90, 20)).save(d + '/fl44/14.jpg', quality=95)    # jpeg
Image.new('RGB', (128, 96), (0, 0, 0)).save(d + '/fl44/15.png')                     # not square
open(d + '/fl44/16.png', 'wb').write(b'not an image')                               # corrupt
`);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('--dry-run changes nothing', () => {
    const r = run(CONVERT, ['--icons-dir', icons, '--dry-run']);
    assert.match(r.stdout, /would convert 5/);
    assert.ok(fs.existsSync(file('es6ai/12.png')));
    assert.ok(!fs.existsSync(file('es6ai/12.webp')));
  });

  test('converts to WebP, keeps alpha, downsizes, deletes originals, reports failures', () => {
    const r = run(CONVERT, ['--icons-dir', icons]);
    assert.equal(r.status, 1, 'corrupt file → exit 1');
    assert.match(r.stdout, /converted 4, already up to date 0, failed 1/);
    assert.match(r.stdout, /not square \(128×96\)/);
    assert.match(r.stderr, /FAILED fl44\/16\.png/);

    assert.deepEqual(probe(file('es6ai/12.webp')), ['WEBP', 'RGBA', '128', '128']);
    assert.deepEqual(probe(file('es6ai/13.webp')), ['WEBP', 'RGB', '128', '128']);
    assert.deepEqual(probe(file('fl44/14.webp')), ['WEBP', 'RGB', '128', '128']);
    for (const f of ['es6ai/12.png', 'es6ai/13.png', 'fl44/14.jpg', 'fl44/15.png']) assert.ok(!fs.existsSync(file(f)), `${f} removed`);
    assert.ok(fs.existsSync(file('fl44/16.png')), 'corrupt original is kept');
    assert.ok(!fs.readdirSync(file('fl44')).some(f => f.endsWith('.tmp')), 'no temp files left');
  });

  test('second run is a no-op for converted files', () => {
    const r = run(CONVERT, ['--icons-dir', icons]);
    assert.match(r.stdout, /converted 0, already up to date 0, failed 1/);
  });

  test('--keep-originals leaves the source next to the WebP', () => {
    py(`from PIL import Image\nImage.new('RGB', (64, 64)).save(${JSON.stringify(file('fl44/17.png'))})`);
    const r = run(CONVERT, ['--icons-dir', icons, '--keep-originals']);
    assert.match(r.stdout, /converted 1,/);
    assert.ok(fs.existsSync(file('fl44/17.png')) && fs.existsSync(file('fl44/17.webp')));
  });

  test('extract.py resolves the original ".png" icon values to the converted files', () => {
    fs.rmSync(file('fl44/16.png'));
    const rows = [
      ...['ac-1', 'mg-1', 'kn-1', 'rg-1', 'pr-1'].map(t => ({ treeID: t, nodeID: 0, nodeName: `P ${t}`, description: '', maxPoints: 8, stats: [] })),
      { treeID: 'es6ai', nodeID: 12, nodeName: 'Void Lens', description: '', maxPoints: 2, stats: [], icon: 'es6ai/12.png' },
      { treeID: 'es6ai', nodeID: 13, nodeName: 'Time Loop', description: '', maxPoints: 2, stats: [], icon: 'C:\\Export\\icons\\es6ai\\13.png' },
      { treeID: 'fl44', nodeID: 14, nodeName: 'Go For The Throat', description: '', maxPoints: 3, stats: [], icon: 'fl44/14.jpg' },
    ];
    fs.writeFileSync(path.join(dir, 'nodes_flat.json'), JSON.stringify(rows));
    const out = path.join(dir, 'out');
    const r = run(EXTRACT, ['--input', path.join(dir, 'nodes_flat.json'), '--out-dir', out, '--icons-dir', icons, '--strict']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const skills = JSON.parse(fs.readFileSync(path.join(out, 'skill_tree_reconciled.json'), 'utf8'));
    assert.deepEqual(skills.map(s => s.icon).sort(), ['es6ai/12.webp', 'es6ai/13.webp', 'fl44/14.webp']);
    assert.match(r.stdout, /1 icons are not WebP/, 'the kept 17.png is flagged');
  });
});
