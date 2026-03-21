#!/usr/bin/env python3
"""
extractor/extract.py
─────────────────────
Converts the single "Global Tree Data.json" MonoBehaviour export into the
clean db/data/*.json files consumed by the overlay at runtime.

─── Source file ──────────────────────────────────────────────────────────────

  "Global Tree Data.json"  (in project root — exported from AssetStudio)

  Top-level structure:
    skillTrees   → list of 138 skill tree objects
    passiveTrees → list of 5 passive tree objects (one per base class)
    weaverTree   → single weaver tree object (future use)

─── Key insight: treeID = Maxroll skill key ──────────────────────────────────

  Each tree has a "treeID" field (e.g. "es6ai", "fl44", "v01cv").
  This IS the same key Maxroll uses in its JSON export (skillTrees.es6ai, etc.).
  No mapping step is required — treeID is used directly as the db key.

─── Node structure (actual fields in source data) ───────────────────────────

  {
    "id":                  int   — node identifier (used in Maxroll history[])
    "name":                str   — display name (e.g. "Fireball Pierce Chance And Increased Mana Cost")
    "maxPoints":           int   — max allocatable points (0 = root/connector node)
    "requiredMastery":     int   — 0 = any mastery, otherwise mastery-gated
    "masteryRequirement":  int   — minimum points in mastery tree required
    "requirements":        list  — prerequisite nodes: [{nodeID, requirement}]
  }

  NOTE: There is NO description field in this data source.

─── Output ───────────────────────────────────────────────────────────────────

  db/data/skills.json    — { [treeID]: { name, nodes: { [id]: node } } }
  db/data/passives.json  — { [treeID]: { name, nodes: { [id]: node } } }
                           (5 trees: kn-1, ac-1, mg-1, pr-1, rg-1)

  NOTE: passives.json is keyed by treeID (class tree), NOT by a flat nodeId
  map. This is because the same nodeId can exist in different class trees.
  build-db.js resolves nodes using classId → treeID → nodeId.

─── Usage ───────────────────────────────────────────────────────────────────

  # From project root:
  python extractor/extract.py

  # Custom paths:
  python extractor/extract.py \\
    --input "Global Tree Data.json" \\
    --output db/data

  # With validation against a Maxroll build:
  python extractor/extract.py --validate config/build.example.json
"""

import argparse
import json
import os
import sys
from pathlib import Path

# ─── Defaults ─────────────────────────────────────────────────────────────────

PROJECT_ROOT  = Path(__file__).parent.parent
DEFAULT_INPUT = PROJECT_ROOT / 'Global Tree Data.json'
DEFAULT_OUTPUT = PROJECT_ROOT / 'db' / 'data'

# ─── CLI ──────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        description='Convert "Global Tree Data.json" → db/data/*.json'
    )
    parser.add_argument(
        '--input', '-i',
        default=str(DEFAULT_INPUT),
        help=f'Path to "Global Tree Data.json" (default: {DEFAULT_INPUT})'
    )
    parser.add_argument(
        '--output', '-o',
        default=str(DEFAULT_OUTPUT),
        help=f'Output folder for db/data/ files (default: {DEFAULT_OUTPUT})'
    )
    parser.add_argument(
        '--validate', '-v',
        default=None,
        help='Path to a Maxroll JSON build — verify all nodeIds resolve after extraction'
    )
    return parser.parse_args()

# ─── Extraction ───────────────────────────────────────────────────────────────

def extract_skills(skill_trees: list) -> dict:
    """
    Convert skillTrees[] → { [treeID]: { name, nodes: { [id]: node } } }

    treeID is the same key Maxroll uses (e.g. "es6ai", "fl44", "v01cv").
    Nodes are keyed by string(id) for consistent JSON lookup.
    Root nodes (maxPoints == 0) are included — they appear in history[] too.
    """
    skills = {}
    for tree in skill_trees:
        tree_id = tree.get('treeID', '').strip()
        if not tree_id:
            print(f'  [WARN] Skipping skill tree with no treeID: {tree.get("name")}', file=sys.stderr)
            continue

        nodes = {}
        for node in tree.get('nodes', []):
            node_id = node.get('id')
            if node_id is None:
                continue
            nodes[str(node_id)] = {
                'id':                 node_id,
                'name':               node.get('name', f'Node {node_id}'),
                'maxPoints':          node.get('maxPoints', 1),
                'requiredMastery':    node.get('requiredMastery', 0),
                'masteryRequirement': node.get('masteryRequirement', 0),
                'requirements':       node.get('requirements', []),
            }

        skills[tree_id] = {
            'name':  tree.get('name', tree_id),
            'nodes': nodes,
        }

    return skills


def extract_passives(passive_trees: list) -> dict:
    """
    Convert passiveTrees[] → { [treeID]: { name, nodes: { [id]: node } } }

    The 5 base class trees (kn-1, ac-1, mg-1, pr-1, rg-1) each contain ALL
    passive nodes for that class including all mastery sub-trees.

    Keyed by treeID so build-db.js can look up "which tree does this character use"
    using the classId → treeID mapping in classes.json.
    """
    passives = {}
    for tree in passive_trees:
        tree_id = tree.get('treeID', '').strip()
        if not tree_id:
            print(f'  [WARN] Skipping passive tree with no treeID: {tree.get("name")}', file=sys.stderr)
            continue

        nodes = {}
        for node in tree.get('nodes', []):
            node_id = node.get('id')
            if node_id is None:
                continue
            nodes[str(node_id)] = {
                'id':                 node_id,
                'name':               node.get('name', f'Node {node_id}'),
                'maxPoints':          node.get('maxPoints', 1),
                'requiredMastery':    node.get('requiredMastery', 0),
                'masteryRequirement': node.get('masteryRequirement', 0),
                'requirements':       node.get('requirements', []),
            }

        passives[tree_id] = {
            'name':  tree.get('name', tree_id),
            'nodes': nodes,
        }

    return passives

# ─── Validation ───────────────────────────────────────────────────────────────

# Maps Maxroll classId → passive treeID
# Derived from the passive tree names in this file + known LE class IDs
PASSIVE_TREE_BY_CLASS = {
    1: 'ac-1',  # Acolyte
    2: 'mg-1',  # Mage
    3: 'kn-1',  # Sentinel (Knight)
    4: 'rg-1',  # Rogue
    5: 'pr-1',  # Primalist
}

def validate_build(build_path: str, skills: dict, passives: dict):
    """
    Load a Maxroll JSON build file and verify every nodeId in every history[]
    resolves in the extracted DB. Reports missing IDs clearly.
    """
    print(f'\n[validate] Checking {build_path}')
    try:
        with open(build_path, 'r') as f:
            build = json.load(f)
    except Exception as e:
        print(f'  [ERROR] Could not load build file: {e}')
        return

    class_id = build.get('class')
    passive_tree_id = PASSIVE_TREE_BY_CLASS.get(class_id)
    passive_nodes = passives.get(passive_tree_id, {}).get('nodes', {}) if passive_tree_id else {}

    # Validate passives
    passive_history = build.get('passives', {}).get('history', [])
    missing_passives = [nid for nid in set(passive_history) if str(nid) not in passive_nodes]
    if missing_passives:
        print(f'  [WARN] {len(missing_passives)} passive nodeIds not found '
              f'in tree "{passive_tree_id}": {sorted(missing_passives)}')
    else:
        print(f'  [OK]   All {len(set(passive_history))} unique passive nodeIds resolved '
              f'(tree: {passive_tree_id} — {passives.get(passive_tree_id, {}).get("name", "?")})')

    # Validate skills
    all_ok = True
    for skill_key, tree_data in build.get('skillTrees', {}).items():
        skill = skills.get(skill_key)
        if not skill:
            print(f'  [WARN] Skill key "{skill_key}" not found in skills.json')
            all_ok = False
            continue
        history = tree_data.get('history', [])
        missing = [nid for nid in set(history) if str(nid) not in skill['nodes']]
        if missing:
            print(f'  [WARN] {skill_key} ("{skill["name"]}"): {len(missing)} missing nodeIds: {sorted(missing)}')
            all_ok = False
        else:
            print(f'  [OK]   {skill_key} → "{skill["name"]}" — all {len(set(history))} nodeIds resolved')

    if all_ok:
        print('  All data resolved successfully.')

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    input_path = Path(args.input)
    output_dir = Path(args.output)

    if not input_path.exists():
        print(f'[ERROR] Input file not found: {input_path}', file=sys.stderr)
        print('  Make sure "Global Tree Data.json" is in the project root.', file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f'Reading: {input_path}')
    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Extract
    print()
    skill_trees_raw  = data.get('skillTrees', [])
    passive_trees_raw = data.get('passiveTrees', [])
    weaver_tree_raw  = data.get('weaverTree', None)

    print(f'Found: {len(skill_trees_raw)} skill trees, '
          f'{len(passive_trees_raw)} passive trees, '
          f'{"1 weaver tree" if weaver_tree_raw else "no weaver tree"}')

    skills  = extract_skills(skill_trees_raw)
    passives = extract_passives(passive_trees_raw)

    # Total node counts
    total_skill_nodes   = sum(len(t['nodes']) for t in skills.values())
    total_passive_nodes = sum(len(t['nodes']) for t in passives.values())
    print(f'Extracted: {len(skills)} skill trees ({total_skill_nodes} nodes), '
          f'{len(passives)} passive trees ({total_passive_nodes} nodes)')

    # Write outputs
    print()
    outputs = {
        'skills.json':  skills,
        'passives.json': passives,
    }
    for filename, db_data in outputs.items():
        out_path = output_dir / filename
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(db_data, f, indent=2, ensure_ascii=False)
        print(f'[write] {out_path}')

    # Validate
    if args.validate:
        validate_build(args.validate, skills, passives)

    print('\nDone.')

if __name__ == '__main__':
    main()
