#!/usr/bin/env node
/**
 * scripts/build-icon-manifest.js
 * ───────────────────────────────
 * Scans assets/icons/ and writes assets/icons/manifest.json, which tells the
 * app which node / tree images exist (see app/js/icons.js for the contract):
 *
 *   assets/icons/nodes/<treeID>/<nodeID>.(png|webp|jpg|jpeg)
 *   assets/icons/trees/<treeID>.(png|webp|jpg|jpeg)
 *
 * Usage:  npm run icons   (or: node scripts/build-icon-manifest.js [iconsDir])
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg']; // earlier wins when several exist

function pick(files) {
  return [...files].sort((a, b) => EXTENSIONS.indexOf(path.extname(a).toLowerCase()) - EXTENSIONS.indexOf(path.extname(b).toLowerCase()))[0];
}

function imagesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
    .map(e => e.name);
}

/** Group image filenames by basename → best file. */
function byStem(files) {
  const groups = new Map();
  for (const f of files) {
    const stem = path.basename(f, path.extname(f));
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(f);
  }
  return [...groups].map(([stem, list]) => [stem, pick(list)]);
}

/**
 * @param {string} iconsDir
 * @returns {{ nodes: Record<string,string>, trees: Record<string,string>, skipped: string[] }}
 */
function buildManifest(iconsDir) {
  const nodes = {};
  const trees = {};
  const skipped = [];

  const nodesDir = path.join(iconsDir, 'nodes');
  if (fs.existsSync(nodesDir)) {
    for (const tree of fs.readdirSync(nodesDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
      for (const [stem, file] of byStem(imagesIn(path.join(nodesDir, tree.name)))) {
        if (!/^\d+$/.test(stem)) { skipped.push(`nodes/${tree.name}/${file}`); continue; }
        nodes[`${tree.name}/${Number(stem)}`] = `nodes/${tree.name}/${file}`;
      }
    }
  }

  for (const [stem, file] of byStem(imagesIn(path.join(iconsDir, 'trees')))) {
    trees[stem] = `trees/${file}`;
  }

  return { nodes, trees, skipped };
}

if (require.main === module) {
  const iconsDir = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'assets', 'icons'));
  const { nodes, trees, skipped } = buildManifest(iconsDir);
  fs.mkdirSync(iconsDir, { recursive: true });
  fs.writeFileSync(path.join(iconsDir, 'manifest.json'), JSON.stringify({ nodes, trees }, null, 2) + '\n');
  console.log(`[icons] ${Object.keys(nodes).length} node icons, ${Object.keys(trees).length} tree icons → ${path.join(iconsDir, 'manifest.json')}`);
  for (const s of skipped) console.warn(`[icons] skipped ${s} (file name must be the numeric nodeID)`);
}

module.exports = { buildManifest };
