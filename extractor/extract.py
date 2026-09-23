#!/usr/bin/env python3
"""
extractor/extract.py
─────────────────────
Cleans the flat node export (extractor/nodes_flat.json) into the two runtime
files read by build-db.js / app.js / main.js:

  db/data/skill_tree_reconciled.json  ← every skill tree (+ weaver tree)
  db/data/passives.json               ← the 5 class passive trees
                                         (ac-1, mg-1, kn-1, rg-1, pr-1)

Both outputs are flat arrays with the same row shape:

  {
    "treeID":      "es6ai",            ← Maxroll skillKey / passive treeID
    "treeName":    "Erasing Strike",
    "nodeID":      12,
    "nodeName":    "Champion of the Void",
    "description": "...",
    "maxPoints":   4,
    "stats":       [{ "statName": "...", "value": "+8%" }]
  }

─── Input ───────────────────────────────────────────────────────────────────

  nodes_flat.json is a flat array of node rows already tagged with treeID:
    { sourceType, nodeID, nodeName, description, maxPoints, treeID,
      treeFile, treeRawFields, stats }

─── Cleanup rules ───────────────────────────────────────────────────────────

  1. Drop rows with no treeID (orphan nodes not attached to any tree).
  2. Trim whitespace from names.
  3. Drop placeholder nodes: nodeName "Name" or "" with no description.
  4. Merge duplicates (same treeID, nodeID, nodeName) — keep the row with
     the most stats/description. Stats with a null statName are dropped.
  5. (treeID, nodeID) must be unique. On collision:
       - nodeID 0 → keep the root node (maxPoints 0)
       - otherwise keep the first named row and report the collision
         (the export contains stale nodes from older tree versions)
  6. treeName:
       - passive trees → class name from db/data/classes.json
       - TREE_NAME_OVERRIDES
       - otherwise the root node's name (nodeID 0, maxPoints 0)
       - fallback: the treeID itself

─── Usage ───────────────────────────────────────────────────────────────────

  python extractor/extract.py
  python extractor/extract.py --input path/to/nodes_flat.json --verbose
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / 'extractor' / 'nodes_flat.json'
DATA_DIR = ROOT / 'db' / 'data'

PASSIVE_TREE_IDS = ('ac-1', 'mg-1', 'kn-1', 'rg-1', 'pr-1')

# Trees whose export has no usable root node (nodeID 0, maxPoints 0).
TREE_NAME_OVERRIDES = {
    'vo54': 'Volcanic Orb',
}

PLACEHOLDER_NAMES = {'', 'Name'}

OUTPUT_FIELDS = ('treeID', 'treeName', 'nodeID', 'nodeName', 'description', 'maxPoints', 'stats')


def load_json(path):
    with open(path, encoding='utf-8-sig') as f:
        return json.load(f)


def write_json(path, data):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')


def passive_tree_names():
    """treeID → class name, from classes.json passiveTreeByClass."""
    classes = load_json(DATA_DIR / 'classes.json')
    return {
        tree_id: classes['classes'][class_id]
        for class_id, tree_id in classes['passiveTreeByClass'].items()
    }


def clean_rows(raw):
    stats = defaultdict(int)
    rows = []
    for r in raw:
        if not r.get('treeID'):
            stats['no treeID'] += 1
            continue
        name = (r.get('nodeName') or '').strip()
        desc = r.get('description') or ''
        if name in PLACEHOLDER_NAMES and not desc.strip():
            stats['placeholder'] += 1
            continue
        rows.append({
            'treeID':      r['treeID'],
            'nodeID':      r['nodeID'],
            'nodeName':    name,
            'description': desc,
            'maxPoints':   r.get('maxPoints', 0),
            'stats':       [st for st in (r.get('stats') or []) if st.get('statName')],
        })
    return rows, stats


def resolve_collisions(rows, stats):
    """Enforce one row per (treeID, nodeID). Returns (rows, unresolved collisions)."""
    groups = defaultdict(list)
    for r in rows:
        key = (r['treeID'], r['nodeID'])
        same = next((g for g in groups[key] if g['nodeName'] == r['nodeName']), None)
        if same is None:
            groups[key].append(r)
            continue
        # Same node exported twice — keep the richer row.
        stats['duplicate'] += 1
        if len(r['stats']) > len(same['stats']) or len(r['description']) > len(same['description']):
            groups[key][groups[key].index(same)] = r

    kept, collisions = [], []
    for (tree_id, node_id), group in groups.items():
        if len(group) == 1:
            kept.append(group[0])
            continue
        if node_id == 0:
            roots = [g for g in group if g['maxPoints'] == 0]
            if roots:
                kept.append(roots[0])
                stats['collision (root kept)'] += len(group) - 1
                continue
        group.sort(key=lambda g: not g['nodeName'])  # prefer a named row
        kept.append(group[0])
        stats['collision (first kept)'] += len(group) - 1
        collisions.append((tree_id, node_id, group))
    return kept, collisions


def tree_names(rows, passive_names):
    names = {}
    for r in rows:
        if r['nodeID'] == 0 and r['maxPoints'] == 0 and r['nodeName']:
            names[r['treeID']] = r['nodeName']
    names.update(TREE_NAME_OVERRIDES)
    names.update(passive_names)
    return names


def to_output(rows, names):
    out = []
    for r in rows:
        row = dict(r, treeName=names.get(r['treeID'], r['treeID']))
        out.append({k: row[k] for k in OUTPUT_FIELDS})
    out.sort(key=lambda r: (r['treeName'].lower(), r['treeID'], r['nodeID']))
    return out


def main():
    ap = argparse.ArgumentParser(description='Clean nodes_flat.json into db/data runtime files.')
    ap.add_argument('--input', type=Path, default=DEFAULT_INPUT)
    ap.add_argument('--out-dir', type=Path, default=DATA_DIR)
    ap.add_argument('--verbose', action='store_true', help='list every unresolved collision')
    args = ap.parse_args()

    raw = load_json(args.input)
    rows, stats = clean_rows(raw)
    rows, collisions = resolve_collisions(rows, stats)

    passive_names = passive_tree_names()
    missing = [t for t in PASSIVE_TREE_IDS if t not in passive_names]
    if missing:
        sys.exit(f'classes.json passiveTreeByClass is missing: {missing}')

    names = tree_names(rows, passive_names)
    out = to_output(rows, names)

    passives = [r for r in out if r['treeID'] in PASSIVE_TREE_IDS]
    skills   = [r for r in out if r['treeID'] not in PASSIVE_TREE_IDS]

    args.out_dir.mkdir(parents=True, exist_ok=True)
    write_json(args.out_dir / 'skill_tree_reconciled.json', skills)
    write_json(args.out_dir / 'passives.json', passives)

    # ─── Report ───────────────────────────────────────────────────────────────
    print(f'Input rows: {len(raw)}')
    for k, v in sorted(stats.items()):
        print(f'  dropped {k}: {v}')

    skill_trees = sorted({r['treeID'] for r in skills})
    print(f'skill_tree_reconciled.json: {len(skills)} nodes, {len(skill_trees)} trees')
    print(f'passives.json: {len(passives)} nodes')
    for t in PASSIVE_TREE_IDS:
        n = sum(1 for r in passives if r['treeID'] == t)
        print(f'  {t} ({names[t]}): {n} nodes')
        if not n:
            print(f'  WARNING: no nodes for passive tree {t}')

    unnamed = [t for t in skill_trees if names.get(t) is None]
    if unnamed:
        print(f'WARNING: {len(unnamed)} trees have no root name (add to TREE_NAME_OVERRIDES): {unnamed}')

    if collisions:
        print(f'WARNING: {len(collisions)} (treeID, nodeID) collisions resolved by keeping the first row'
              + ('' if args.verbose else ' (use --verbose to list)'))
        if args.verbose:
            for tree_id, node_id, group in collisions:
                alts = ', '.join(f'"{g["nodeName"]}" ({g["maxPoints"]}pt)' for g in group)
                print(f'  {tree_id}:{node_id} -> {alts}')


if __name__ == '__main__':
    main()
