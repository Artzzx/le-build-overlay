#!/usr/bin/env python3
"""
extractor/extract.py
─────────────────────
Produces db/data/skills.json and db/data/passives.json by combining two sources:

  Source 1 — "Global Tree Data.json" (project root)
    → tree structure: treeID, node ids, maxPoints, requirements
    → one file, extracted once

  Source 2 — AssetStudio full MonoBehaviour export (C:\\Tools\\le_export\\)
    → real display names (nodeName) and descriptions
    → requires: SkillTree #*.json  +  SkillTreeNode #*.json files

─── Why two sources? ────────────────────────────────────────────────────────

  Global Tree Data contains internal names ("Void Cleave Crit Multi And Mana On
  Crit") that are not player-facing. The individual SkillTreeNode MonoBehaviours
  have the real names ("Champion of the Void") and descriptions shown in-game.

  nodeId alone is NOT a unique key — every skill tree has a node with id=0, 12,
  etc. The composite key (treeID, nodeId) is required.

─── Join chain ──────────────────────────────────────────────────────────────

  SkillTreeNode files are grouped by tree.m_PathID (shared by all nodes in
  the same skill tree). The root node (id=0) in each group has:
    .nodeName = "Void Cleave"   ← matches Global Tree Data tree.name exactly
  → treeID = "v01cv"
  → (treeID="v01cv", nodeId=12) → nodeName + description

  Parent SkillTree #*.json files are NOT used — AssetStudio does not export
  them as standalone files (they live inside prefabs).

  Passive trees have no root name match, but each of the 5 passive trees has
  a distinct node count (103/107/109/110/111), so they match by group size.

─── Usage ───────────────────────────────────────────────────────────────────

  # Minimum (Global Tree Data only — no display names):
  python extractor/extract.py

  # Full (Global Tree Data + display names from export):
  python extractor/extract.py --nodes C:\\Tools\\le_export

  # With validation:
  python extractor/extract.py --nodes C:\\Tools\\le_export --validate config/my-build.json

─── Output node shape ───────────────────────────────────────────────────────

  {
    "id":          12,
    "nodeName":    "Champion of the Void",      ← real display name (from nodes export)
    "name":        "Void Cleave Crit Multi...", ← internal name (from Global Tree Data)
    "description": "Void Cleave critical...",   ← description (from nodes export)
    "maxPoints":   4,
    "requiredMastery":    0,
    "masteryRequirement": 0,
    "requirements": [...]
  }

  When --nodes is not provided, nodeName falls back to name, description = "".
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# ─── Defaults ─────────────────────────────────────────────────────────────────

PROJECT_ROOT   = Path(__file__).parent.parent
DEFAULT_INPUT  = PROJECT_ROOT / 'Global Tree Data.json'
DEFAULT_OUTPUT = PROJECT_ROOT / 'db' / 'data'

# ─── CLI ──────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        description='Build db/data/*.json from Global Tree Data + optional node exports'
    )
    parser.add_argument(
        '--input', '-i',
        default=str(DEFAULT_INPUT),
        help='Path to "Global Tree Data.json" (default: project root)'
    )
    parser.add_argument(
        '--nodes', '-n',
        default=None,
        help='Path to AssetStudio MonoBehaviour export folder (e.g. C:\\Tools\\le_export). '
             'Enables real display names and descriptions. Optional.'
    )
    parser.add_argument(
        '--output', '-o',
        default=str(DEFAULT_OUTPUT),
        help='Output folder for db/data/ files (default: db/data/)'
    )
    parser.add_argument(
        '--validate', '-v',
        default=None,
        help='Path to raw Maxroll JSON build — verify all nodeIds resolve after extraction'
    )
    return parser.parse_args()

# ─── Description lookup builder ───────────────────────────────────────────────

def build_description_lookup(nodes_dir: str, skill_trees: list, passive_trees: list) -> dict:
    """
    Build a composite-key lookup from AssetStudio-exported SkillTreeNode files:

        { (treeID, nodeId): { nodeName, description } }

    ─── Why parent tree files are NOT used ─────────────────────────────────────
    AssetStudio exports SkillTreeNode / PassiveTreeNode MonoBehaviours correctly
    because their m_Name is empty → filename becomes "SkillTreeNode #<pathID>.json".
    The parent SkillTree / PassiveTree MonoBehaviours are likely attached to
    prefab GameObjects and are never exported as standalone files.
    Attempting to join through parent files always yields 0 matches.

    ─── Matching strategy ───────────────────────────────────────────────────────
    Instead of needing parent files, we match using Global Tree Data directly:

      1. Read ALL SkillTreeNode + PassiveTreeNode files.
         Group them by tree.m_PathID (all nodes in the same tree share one value).

      2. Skill trees: each group's root node (id=0) has nodeName == tree.name
         in Global Tree Data. Build name→treeID index and match.

      3. Passive trees: the 5 passive trees have DISTINCT node counts (103, 107,
         109, 110, 111). Match each PassiveTreeNode group by group size.

    Returns empty dict if nodes_dir is None or no files are found.
    """
    if not nodes_dir:
        return {}

    root = Path(nodes_dir)
    if not root.exists():
        print(f'[warn] --nodes path not found: {root}', file=sys.stderr)
        return {}

    descriptions = {}  # { (treeID, nodeId): { nodeName, description } }
    PROGRESS_INTERVAL = 500

    # ── Build lookup indexes from Global Tree Data ─────────────────────────────
    def _norm(s: str) -> str:
        """Normalize a name for fuzzy matching: lowercase, strip all non-alphanumeric.
        Handles spacing differences like "Ghost Flame" → "Ghostflame" → "ghostflame".
        """
        return re.sub(r'[^a-z0-9]', '', s.lower())

    # Skill trees: exact lowercase name → treeID, AND normalized name → treeID
    skill_name_to_id: dict[str, str] = {}
    skill_name_norm_to_id: dict[str, str] = {}
    for t in skill_trees:
        name = t.get('name', '').strip()
        tid  = t.get('treeID', '')
        if name and tid:
            skill_name_to_id[name.lower()] = tid
            skill_name_norm_to_id[_norm(name)] = tid

    # Passive trees: node count → treeID (all 5 base-class trees have distinct counts)
    passive_count_to_id = {
        len(t.get('nodes', [])): t['treeID']
        for t in passive_trees
        if t.get('treeID')
    }

    # Node names that are Unity's default placeholder — skip silently
    PLACEHOLDER_NAMES = {'name', ''}

    # Mastery passive tree node counts (SkillTreeNode files, NOT in Global Tree Data)
    # These are mastery specialization passive branches stored as skill-type MonoBehaviours.
    # We can't resolve their treeIDs — they're not in Global Tree Data — so skip quietly.
    passive_node_counts = set(passive_count_to_id.keys())

    # ── Scan all node files ────────────────────────────────────────────────────
    node_pattern  = re.compile(r'^SkillTreeNode\s+#\d+$',  re.IGNORECASE)
    pnode_pattern = re.compile(r'^PassiveTreeNode\s+#\d+$', re.IGNORECASE)

    node_files = []
    print('  Scanning directory...', end='', flush=True)
    for f in root.rglob('*.json'):
        stem = f.stem
        if node_pattern.match(stem) or pnode_pattern.match(stem):
            node_files.append(f)
    print(f'\r  Found {len(node_files):,} node files')

    if not node_files:
        print('[warn] No SkillTreeNode / PassiveTreeNode files found in export folder.')
        print('       Make sure the full MonoBehaviour export (Step 3) is complete.')
        return {}

    # ── Step 1: Read all node files, group by tree.m_PathID ───────────────────
    print(f'  Step 1/2: reading {len(node_files):,} node files...', flush=True)

    # groups[pathID] = { 'is_passive': bool, 'nodes': [{id, nodeName, description}] }
    groups = {}

    for i, f in enumerate(node_files):
        if i > 0 and i % PROGRESS_INTERVAL == 0:
            pct = i * 100 // len(node_files)
            print(f'\r  Step 1/2: {i:,}/{len(node_files):,} ({pct}%)  '
                  f'— {len(groups):,} groups so far   ', end='', flush=True)

        data = load_json(f)
        if not data:
            continue

        tree_path_id = data.get('tree', {}).get('m_PathID')
        node_id = data.get('id')
        if tree_path_id is None or node_id is None:
            continue

        is_passive = bool(pnode_pattern.match(f.stem))

        if tree_path_id not in groups:
            groups[tree_path_id] = {'is_passive': is_passive, 'nodes': []}

        groups[tree_path_id]['nodes'].append({
            'id':          node_id,
            'nodeName':    data.get('nodeName', '').strip(),
            'description': data.get('description', '').strip(),
        })

    print(f'\r  Step 1/2: done — {len(groups):,} distinct trees found' + ' ' * 30)

    # ── Step 2: Match each group to a treeID ──────────────────────────────────
    print(f'  Step 2/2: matching {len(groups):,} groups to tree IDs...', flush=True)

    matched_groups   = 0
    skipped_mastery  = 0   # mastery passive extensions — not in Global Tree Data
    skipped_null     = 0   # pathID=0 (Unity null reference)
    skipped_placeholder = 0  # root nodeName is Unity default ("Name" / empty)
    unmatched_groups = []  # genuine mismatches worth reporting

    for path_id, group in groups.items():
        nodes      = group['nodes']
        is_passive = group['is_passive']

        # ── Pre-flight skips ──────────────────────────────────────────────────
        if path_id == 0:
            skipped_null += 1
            continue

        root_node = next((n for n in nodes if n['id'] == 0), None)
        root_name = root_node['nodeName'] if root_node else ''

        if root_name.lower() in PLACEHOLDER_NAMES:
            skipped_placeholder += 1
            continue

        # SkillTreeNode groups sized like passive trees are mastery specialization
        # branches (e.g. "Bone Aura" 110 nodes, "Arcanist" 108 nodes).
        # They are NOT in Global Tree Data — skip quietly.
        if not is_passive and len(nodes) in passive_node_counts:
            skipped_mastery += 1
            continue

        # ── Matching ─────────────────────────────────────────────────────────
        tree_id = None

        if not is_passive:
            # Pass 1: exact lowercase name  (e.g. "fireball" → "fi9")
            tree_id = skill_name_to_id.get(root_name.lower())
            # Pass 2: normalized name — handles "Ghost Flame" → "Ghostflame"
            if not tree_id:
                tree_id = skill_name_norm_to_id.get(_norm(root_name))
        else:
            # Passive tree: match by node count (5 base-class trees, all distinct)
            tree_id = passive_count_to_id.get(len(nodes))

        if tree_id:
            for n in nodes:
                descriptions[(tree_id, n['id'])] = {
                    'nodeName':    n['nodeName'],
                    'description': n['description'],
                }
            matched_groups += 1
        else:
            unmatched_groups.append((path_id, len(nodes), is_passive, root_name))

    skipped_total = skipped_null + skipped_placeholder + skipped_mastery
    print(f'\r[descriptions] Matched {matched_groups}/{len(groups)} groups'
          f' ({skipped_total} skipped: {skipped_mastery} mastery extensions,'
          f' {skipped_placeholder} placeholders, {skipped_null} null refs)'
          + ' ' * 20)

    if unmatched_groups:
        print(f'  [warn] {len(unmatched_groups)} group(s) could not be matched:')
        for path_id, count, is_passive, root_name in unmatched_groups[:8]:
            kind = 'passive' if is_passive else 'skill'
            print(f'    pathID={path_id}, {count} nodes, type={kind}, '
                  f'root nodeName={root_name!r}')

    return descriptions


def load_json(path: Path) -> dict | None:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        return None

# ─── Extraction ───────────────────────────────────────────────────────────────

def build_node(node: dict, tree_id: str, descriptions: dict) -> dict:
    """
    Build a single output node dict, merging Global Tree Data fields
    with display name + description from the SkillTreeNode lookup.

    Field priority:
      nodeName    → from SkillTreeNode (real display name)  fallback: internal name
      description → from SkillTreeNode                      fallback: ""
      name        → internal name from Global Tree Data (always kept for reference)
    """
    node_id = node['id']
    internal_name = node.get('name', f'Node {node_id}')

    desc_info = descriptions.get((tree_id, node_id), {})
    node_name = desc_info.get('nodeName') or internal_name

    return {
        'id':                  node_id,
        'nodeName':            node_name,
        'name':                internal_name,      # internal name, kept for reference
        'description':         desc_info.get('description', ''),
        'maxPoints':           node.get('maxPoints', 1),
        'requiredMastery':     node.get('requiredMastery', 0),
        'masteryRequirement':  node.get('masteryRequirement', 0),
        'requirements':        node.get('requirements', []),
    }


def extract_skills(skill_trees: list, descriptions: dict) -> dict:
    """
    Convert skillTrees[] → { [treeID]: { name, nodes: { [id]: node } } }
    Augments each node with nodeName + description from the lookup.
    """
    skills = {}
    for tree in skill_trees:
        tree_id = tree.get('treeID', '').strip()
        if not tree_id:
            print(f'  [warn] Skipping skill tree with no treeID: {tree.get("name")}',
                  file=sys.stderr)
            continue

        nodes = {
            str(n['id']): build_node(n, tree_id, descriptions)
            for n in tree.get('nodes', [])
            if n.get('id') is not None
        }

        skills[tree_id] = {
            'name':  tree.get('name', tree_id),
            'nodes': nodes,
        }

    return skills


def extract_passives(passive_trees: list, descriptions: dict) -> dict:
    """
    Convert passiveTrees[] → { [treeID]: { name, nodes: { [id]: node } } }
    Augments each node with nodeName + description from the lookup.
    """
    passives = {}
    for tree in passive_trees:
        tree_id = tree.get('treeID', '').strip()
        if not tree_id:
            print(f'  [warn] Skipping passive tree with no treeID: {tree.get("name")}',
                  file=sys.stderr)
            continue

        nodes = {
            str(n['id']): build_node(n, tree_id, descriptions)
            for n in tree.get('nodes', [])
            if n.get('id') is not None
        }

        passives[tree_id] = {
            'name':  tree.get('name', tree_id),
            'nodes': nodes,
        }

    return passives

# ─── Validation ───────────────────────────────────────────────────────────────

PASSIVE_TREE_BY_CLASS = {
    1: 'ac-1',
    2: 'mg-1',
    3: 'kn-1',
    4: 'rg-1',
    5: 'pr-1',
}

def validate_build(build_path: str, skills: dict, passives: dict):
    print(f'\n[validate] Checking {build_path}')
    try:
        with open(build_path, 'r') as f:
            build = json.load(f)
    except Exception as e:
        print(f'  [error] Could not load build file: {e}')
        return

    class_id = build.get('class')
    passive_tree_id = PASSIVE_TREE_BY_CLASS.get(class_id)
    passive_nodes = passives.get(passive_tree_id, {}).get('nodes', {}) if passive_tree_id else {}

    passive_history = build.get('passives', {}).get('history', [])
    missing_passives = [nid for nid in set(passive_history) if str(nid) not in passive_nodes]
    if missing_passives:
        print(f'  [warn] {len(missing_passives)} passive nodeIds missing in tree "{passive_tree_id}": {sorted(missing_passives)}')
    else:
        print(f'  [ok]   All {len(set(passive_history))} passive nodeIds resolved (tree: {passive_tree_id})')

    all_ok = True
    for skill_key, tree_data in build.get('skillTrees', {}).items():
        skill = skills.get(skill_key)
        if not skill:
            print(f'  [warn] Skill key "{skill_key}" not found in skills.json')
            all_ok = False
            continue
        history = tree_data.get('history', [])
        missing = [nid for nid in set(history) if str(nid) not in skill['nodes']]
        if missing:
            print(f'  [warn] {skill_key} ("{skill["name"]}"): {len(missing)} missing nodeIds: {sorted(missing)}')
            all_ok = False
        else:
            # Check how many nodes have real display names
            with_names = sum(
                1 for nid in set(history)
                if skill['nodes'].get(str(nid), {}).get('nodeName') !=
                   skill['nodes'].get(str(nid), {}).get('name')
            )
            print(f'  [ok]   {skill_key} → "{skill["name"]}" — all nodeIds resolved '
                  f'({with_names}/{len(set(history))} with real display names)')

    if all_ok:
        print('  All data resolved successfully.')

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    input_path = Path(args.input)
    output_dir = Path(args.output)

    if not input_path.exists():
        print(f'[error] Global Tree Data file not found: {input_path}', file=sys.stderr)
        print('  Make sure "Global Tree Data.json" is in the project root.', file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Load source data ──────────────────────────────────────────────────────
    print(f'Reading: {input_path}')
    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    skill_trees_raw  = data.get('skillTrees', [])
    passive_trees_raw = data.get('passiveTrees', [])
    print(f'Found: {len(skill_trees_raw)} skill trees, {len(passive_trees_raw)} passive trees')

    # ── Build description lookup (optional) ───────────────────────────────────
    print()
    if args.nodes:
        print(f'Building description lookup from: {args.nodes}')
        descriptions = build_description_lookup(args.nodes, skill_trees_raw, passive_trees_raw)
        coverage = len(descriptions)
        print(f'Description lookup: {coverage} (treeID, nodeId) entries')
    else:
        print('[info] No --nodes path provided. Display names will use internal names.')
        print('       Re-run with --nodes C:\\Tools\\le_export to get real names + descriptions.')
        descriptions = {}

    # ── Extract ───────────────────────────────────────────────────────────────
    print()
    skills  = extract_skills(skill_trees_raw, descriptions)
    passives = extract_passives(passive_trees_raw, descriptions)

    total_skill_nodes   = sum(len(t['nodes']) for t in skills.values())
    total_passive_nodes = sum(len(t['nodes']) for t in passives.values())
    print(f'Extracted: {len(skills)} skill trees ({total_skill_nodes} nodes), '
          f'{len(passives)} passive trees ({total_passive_nodes} nodes)')

    # Coverage report when descriptions were loaded
    if descriptions:
        desc_count = sum(
            1 for tree in skills.values()
            for node in tree['nodes'].values()
            if node.get('description')
        )
        desc_count += sum(
            1 for tree in passives.values()
            for node in tree['nodes'].values()
            if node.get('description')
        )
        total_nodes = total_skill_nodes + total_passive_nodes
        print(f'Description coverage: {desc_count}/{total_nodes} nodes '
              f'({100*desc_count//total_nodes}%)')

    # ── Write outputs ─────────────────────────────────────────────────────────
    print()
    for filename, db_data in [('skills.json', skills), ('passives.json', passives)]:
        out_path = output_dir / filename
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(db_data, f, indent=2, ensure_ascii=False)
        print(f'[write] {out_path}')

    # ── Validate ──────────────────────────────────────────────────────────────
    if args.validate:
        validate_build(args.validate, skills, passives)

    print('\nDone.')

if __name__ == '__main__':
    main()
