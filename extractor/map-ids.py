#!/usr/bin/env python3
"""
extractor/map-ids.py
─────────────────────
Maps Maxroll's opaque skill keys (fl44, fl22, etc.) to actual skill names
extracted from AssetStudio MonoBehaviour assets.

─── The Problem ─────────────────────────────────────────────────────────────

extract.py keys skills.json by AssetStudio asset names
(e.g. "SkillTreeData_ErasingStrike"). But Maxroll uses its own opaque keys
(e.g. "fl44"). These two must be reconciled to display correct skill names.

─── Strategy ────────────────────────────────────────────────────────────────

Use node ID intersection:
  1. Take a known Maxroll build (e.g. Void Knight with Erasing Strike)
  2. Extract the nodeIds in fl44.history: e.g. [4, 4, 14, 11, 12, ...]
  3. For each extracted skill tree in skills.json:
     - Count how many of fl44's nodeIds appear in that tree's nodes
  4. The tree with the highest match count IS the fl44 skill tree
  5. Record: fl44 → SkillTreeData_ErasingStrike → "Erasing Strike"

─── Output ──────────────────────────────────────────────────────────────────

  extractor/skillkey-map.json  — { "fl44": "SkillTreeData_ErasingStrike", ... }

After running this script, re-run extract.py OR run patch-skills.py (below)
to update db/data/skills.json with the correct fl44/fl22 etc. keys.

─── Usage ───────────────────────────────────────────────────────────────────

  python extractor/map-ids.py \\
    --build config/my-known-build.json \\
    --skills db/data/skills.json \\
    --output extractor/skillkey-map.json

  # Then apply the mapping to skills.json:
  python extractor/map-ids.py \\
    --apply extractor/skillkey-map.json \\
    --skills db/data/skills.json
"""

import argparse
import json
import sys
from pathlib import Path
from collections import defaultdict

# ─── CLI ──────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        description='Map Maxroll skill keys (fl44 etc.) to extracted skill tree names'
    )
    subparsers = parser.add_subparsers(dest='command', required=True)

    # Discover mapping
    find_parser = subparsers.add_parser('find', help='Discover skillKey → assetName mapping')
    find_parser.add_argument('--build', required=True,
                             help='Path to a Maxroll JSON build file (known build)')
    find_parser.add_argument('--skills', required=True,
                             help='Path to db/data/skills.json (from extract.py)')
    find_parser.add_argument('--output', default='extractor/skillkey-map.json',
                             help='Output path for the mapping file')

    # Apply mapping
    apply_parser = subparsers.add_parser('apply', help='Apply mapping → rekey skills.json')
    apply_parser.add_argument('--map', required=True,
                              help='Path to skillkey-map.json (from find command)')
    apply_parser.add_argument('--skills', required=True,
                              help='Path to db/data/skills.json to update')

    return parser.parse_args()

# ─── Find command ─────────────────────────────────────────────────────────────

def cmd_find(args):
    """
    For each Maxroll skillKey, find the best-matching extracted skill tree
    by intersection of nodeIds.
    """
    with open(args.build, 'r') as f:
        build = json.load(f)

    with open(args.skills, 'r') as f:
        skills_db = json.load(f)

    skill_trees = build.get('skillTrees', {})
    if not skill_trees:
        print('[ERROR] No skillTrees found in build JSON', file=sys.stderr)
        sys.exit(1)

    # Build set of nodeIds for each Maxroll key
    maxroll_node_sets = {}
    for skill_key, tree_data in skill_trees.items():
        maxroll_node_sets[skill_key] = set(str(n) for n in tree_data.get('history', []))

    # Build set of nodeIds for each extracted asset
    asset_node_sets = {}
    for asset_name, asset_data in skills_db.items():
        asset_node_sets[asset_name] = set(asset_data.get('nodes', {}).keys())

    # For each Maxroll key, find the best-matching asset
    mapping = {}
    for skill_key, maxroll_nodes in maxroll_node_sets.items():
        if not maxroll_nodes:
            print(f'  [SKIP] {skill_key} has empty history')
            continue

        scores = {}
        for asset_name, asset_nodes in asset_node_sets.items():
            intersection = len(maxroll_nodes & asset_nodes)
            if intersection > 0:
                scores[asset_name] = intersection

        if not scores:
            print(f'  [WARN] {skill_key}: no matching asset found (0 nodeId overlaps)')
            continue

        best_match = max(scores, key=scores.get)
        best_score = scores[best_match]
        skill_name = skills_db[best_match].get('name', best_match)

        print(f'  {skill_key} → {best_match} ("{skill_name}") — {best_score}/{len(maxroll_nodes)} nodes matched')
        mapping[skill_key] = best_match

    # Write mapping file
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(mapping, f, indent=2)
    print(f'\n[write] {out_path}')

# ─── Apply command ────────────────────────────────────────────────────────────

def cmd_apply(args):
    """
    Rekey skills.json: replace asset name keys with Maxroll skill keys (fl44, etc.).
    Creates a new skills.json where keys are the fl** Maxroll keys.

    Entries NOT in the mapping are kept under their original asset names
    (so the DB stays complete even for skills not yet mapped).
    """
    with open(args.map, 'r') as f:
        key_map = json.load(f)  # { "fl44": "SkillTreeData_ErasingStrike", ... }

    with open(args.skills, 'r') as f:
        skills_db = json.load(f)

    # Invert: asset_name → fl_key
    asset_to_fl = {v: k for k, v in key_map.items()}

    new_skills = {}
    mapped_count = 0
    for asset_name, skill_data in skills_db.items():
        fl_key = asset_to_fl.get(asset_name)
        if fl_key:
            new_skills[fl_key] = skill_data
            mapped_count += 1
            print(f'  Remapped: {asset_name} → {fl_key}')
        else:
            new_skills[asset_name] = skill_data

    with open(args.skills, 'w', encoding='utf-8') as f:
        json.dump(new_skills, f, indent=2, ensure_ascii=False)

    print(f'\n[write] {args.skills} ({mapped_count} keys remapped to fl** format)')

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    if args.command == 'find':
        cmd_find(args)
    elif args.command == 'apply':
        cmd_apply(args)

if __name__ == '__main__':
    main()
