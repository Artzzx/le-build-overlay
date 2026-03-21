#!/usr/bin/env python3
"""
extractor/extract.py
─────────────────────
Processes the bulk JSON export from AssetStudio (MonoBehaviour assets) into
clean, normalized JSON files in db/data/.

This script is run ONCE PER PATCH, not at runtime.

─── Prerequisites ────────────────────────────────────────────────────────────

1. Run Il2CppDumper to generate DummyDll from the game's binaries:

     Il2CppDumper.exe "Last Epoch/GameAssembly.dll"
       "Last Epoch/Last Epoch_Data/il2cpp_data/Metadata/global-metadata.dat"
       D:\\le_dump\\

2. Open AssetStudio:
   - File > Load Folder > "Last Epoch/Last Epoch_Data/"
   - When prompted, point DummyDll folder to D:\\le_dump\\DummyDll
   - Filter by Type: MonoBehaviour
   - Export > Filtered Assets (exports ~160k+ JSON files to a folder)

3. Run this script:

     python extractor/extract.py --input D:\\le_export --output db/data

─── Output ───────────────────────────────────────────────────────────────────

  db/data/passives.json   — { [nodeId]: PassiveNode }
  db/data/skills.json     — { [skillKey]: { name, nodes: { [nodeId]: SkillNode } } }
  db/data/classes.json    — { classes: { [id]: name }, masteries: { [id]: { name, classId } } }

─── Schema ───────────────────────────────────────────────────────────────────

PassiveNode:
  nodeId:      int
  name:        str
  description: str
  maxPoints:   int
  treeId:      str    # e.g. "sentinel_base"
  treeName:    str    # e.g. "Sentinel"
  requires:    list[int]  # prerequisite nodeIds

SkillNode:
  nodeId:      int
  name:        str
  description: str
  maxPoints:   int

─── IMPORTANT: skillKey mapping ─────────────────────────────────────────────

Maxroll uses opaque keys like "fl44", "fl22" for skill trees.
The mapping from these keys to actual skill MonoBehaviours is NOT YET KNOWN.

Investigation approach:
  1. Export a known build (e.g. Void Knight with Erasing Strike as fl44)
  2. The fl44 history contains node IDs → find a SkillTree MonoBehaviour
     whose nodes contain ALL those IDs
  3. That MonoBehaviour is the Erasing Strike skill tree
  4. Reverse-engineer the fl prefix + number → MonoBehaviour name pattern

Until this is solved, skills.json will be keyed by asset name and a
manual mapping file (map-ids.py output) will bridge to Maxroll keys.

─── Asset name patterns to look for ─────────────────────────────────────────

  PassiveTreeData*, PassiveNodeData*  → passives
  SkillTreeData*, SkillNodeData*      → skills
  CharacterClass*, ClassMastery*      → classes
  UniqueList*, AffixList*             → items (future)
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# ─── CLI ──────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        description='Convert AssetStudio MonoBehaviour exports into db/data JSON files'
    )
    parser.add_argument(
        '--input', '-i',
        required=True,
        help='Folder containing exported MonoBehaviour JSON files from AssetStudio'
    )
    parser.add_argument(
        '--output', '-o',
        default=os.path.join(os.path.dirname(__file__), '..', 'db', 'data'),
        help='Output folder for db/data/*.json files (default: db/data/)'
    )
    parser.add_argument(
        '--validate', '-v',
        default=None,
        help='Path to a Maxroll JSON build file — runs validation after extraction'
    )
    return parser.parse_args()

# ─── File scanning ────────────────────────────────────────────────────────────

def find_assets(input_dir: str, pattern: str) -> list[Path]:
    """
    Find all JSON files in input_dir whose filename matches pattern (case-insensitive regex).
    AssetStudio exports files with names like: "MonoBehaviour - PassiveTreeData_Sentinel.json"
    """
    root = Path(input_dir)
    compiled = re.compile(pattern, re.IGNORECASE)
    matches = []
    for f in root.rglob('*.json'):
        if compiled.search(f.stem):
            matches.append(f)
    return sorted(matches)

def load_json(path: Path) -> dict | None:
    """Load a JSON file, returning None on parse error."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f'  [WARN] Failed to parse {path.name}: {e}', file=sys.stderr)
        return None

# ─── Passive extraction ───────────────────────────────────────────────────────

def extract_passives(input_dir: str) -> dict:
    """
    Scan for PassiveTree/PassiveNode MonoBehaviours and build passives.json.

    TODO: Inspect actual AssetStudio exports to determine exact field names.
    The field names below (nodeId, nodeName, description, maxPoints, etc.)
    are guesses based on typical Unity MonoBehaviour naming — adjust after
    examining real exports.

    Returns: { str(nodeId): PassiveNode }
    """
    passives = {}
    asset_files = find_assets(input_dir, r'(PassiveTree|PassiveNode)')
    print(f'[passives] Found {len(asset_files)} candidate files')

    for path in asset_files:
        data = load_json(path)
        if not data:
            continue

        # TODO: Determine actual structure from AssetStudio export
        # Possible structure (adjust to match real exports):
        #
        # Option A — tree file containing array of nodes:
        # {
        #   "m_Name": "PassiveTreeData_Sentinel",
        #   "nodes": [
        #     { "nodeID": 6, "nodeName": "Juggernaut", "description": "...", "maxPoints": 5 }
        #   ]
        # }
        #
        # Option B — individual node files:
        # {
        #   "m_Name": "PassiveNode_Juggernaut",
        #   "nodeID": 6,
        #   "nodeName": "Juggernaut",
        #   "description": "...",
        #   "maxPoints": 5
        # }

        tree_id = extract_tree_id(data.get('m_Name', ''))
        tree_name = extract_tree_name(data.get('m_Name', ''))

        nodes = data.get('nodes', [])
        if not nodes and 'nodeID' in data:
            # Single-node file
            nodes = [data]

        for node in nodes:
            node_id = node.get('nodeID') or node.get('nodeId')
            if node_id is None:
                continue
            passives[str(node_id)] = {
                'nodeId': node_id,
                'name': node.get('nodeName') or node.get('name', f'Node {node_id}'),
                'description': node.get('description', ''),
                'maxPoints': node.get('maxPoints', 1),
                'treeId': tree_id,
                'treeName': tree_name,
                'requires': node.get('requires', []),
            }

    print(f'[passives] Extracted {len(passives)} nodes')
    return passives

# ─── Skill extraction ─────────────────────────────────────────────────────────

def extract_skills(input_dir: str) -> dict:
    """
    Scan for SkillTree/SkillNode MonoBehaviours and build skills.json.

    CRITICAL UNKNOWN: The skillKey (fl44, fl22, etc.) used by Maxroll must be
    mapped to actual MonoBehaviour asset names. This is currently unknown.
    Until solved, keys will be the asset name (e.g. "SkillTreeData_ErasingStrike").
    Use map-ids.py to create the final Maxroll-key → asset mapping.

    Returns: { skillKey: { name, nodes: { str(nodeId): SkillNode } } }
    """
    skills = {}
    asset_files = find_assets(input_dir, r'(SkillTree|SkillNode)')
    print(f'[skills] Found {len(asset_files)} candidate files')

    for path in asset_files:
        data = load_json(path)
        if not data:
            continue

        asset_name = data.get('m_Name', path.stem)
        skill_name = extract_skill_name(asset_name)

        # Use asset name as temporary key until skillKey mapping is resolved
        skill_key = asset_name

        nodes = {}
        node_list = data.get('nodes', [])
        if not node_list and 'nodeID' in data:
            node_list = [data]

        for node in node_list:
            node_id = node.get('nodeID') or node.get('nodeId')
            if node_id is None:
                continue
            nodes[str(node_id)] = {
                'nodeId': node_id,
                'name': node.get('nodeName') or node.get('name', f'Node {node_id}'),
                'description': node.get('description', ''),
                'maxPoints': node.get('maxPoints', 1),
            }

        if nodes:
            skills[skill_key] = { 'name': skill_name, 'nodes': nodes }

    print(f'[skills] Extracted {len(skills)} skill trees')
    return skills

# ─── Class extraction ─────────────────────────────────────────────────────────

def extract_classes(input_dir: str) -> dict:
    """
    Scan for CharacterClass/Mastery MonoBehaviours and build classes.json.

    Returns: { classes: { str(id): name }, masteries: { str(id): { name, classId } } }
    """
    classes = {}
    masteries = {}
    asset_files = find_assets(input_dir, r'(CharacterClass|Mastery|ClassData)')
    print(f'[classes] Found {len(asset_files)} candidate files')

    for path in asset_files:
        data = load_json(path)
        if not data:
            continue

        # TODO: Determine actual structure from real AssetStudio exports
        class_id = data.get('classID') or data.get('classId')
        class_name = data.get('className') or data.get('name', '')

        if class_id is not None and class_name:
            classes[str(class_id)] = class_name

        mastery_list = data.get('masteries', [])
        for m in mastery_list:
            mastery_id = m.get('masteryID') or m.get('masteryId')
            mastery_name = m.get('masteryName') or m.get('name', '')
            if mastery_id is not None and mastery_name:
                masteries[str(mastery_id)] = { 'name': mastery_name, 'classId': class_id }

    print(f'[classes] Extracted {len(classes)} classes, {len(masteries)} masteries')
    return { 'classes': classes, 'masteries': masteries }

# ─── Helper functions ─────────────────────────────────────────────────────────

def extract_tree_id(asset_name: str) -> str:
    """e.g. "PassiveTreeData_SentinelBase" → "sentinel_base" """
    suffix = re.sub(r'^.*?_', '', asset_name)
    return re.sub(r'(?<!^)(?=[A-Z])', '_', suffix).lower()

def extract_tree_name(asset_name: str) -> str:
    """e.g. "PassiveTreeData_VoidKnight" → "Void Knight" """
    suffix = re.sub(r'^.*?_', '', asset_name)
    return re.sub(r'(?<!^)(?=[A-Z])', ' ', suffix).strip()

def extract_skill_name(asset_name: str) -> str:
    """e.g. "SkillTreeData_ErasingStrike" → "Erasing Strike" """
    suffix = re.sub(r'^.*?_', '', asset_name)
    return re.sub(r'(?<!^)(?=[A-Z])', ' ', suffix).strip()

# ─── Validation ───────────────────────────────────────────────────────────────

def validate_build(build_path: str, passives: dict, skills: dict):
    """
    Load a Maxroll JSON build and verify every nodeId in history[] exists
    in the extracted DB. Reports any missing IDs (indicates extraction gap
    or version mismatch between game patch and DB).
    """
    print(f'\n[validate] Checking {build_path}')
    with open(build_path, 'r') as f:
        build = json.load(f)

    missing_passives = set()
    for nid in build.get('passives', {}).get('history', []):
        if str(nid) not in passives:
            missing_passives.add(nid)

    missing_skills = {}
    for skill_key, tree in build.get('skillTrees', {}).items():
        skill_data = skills.get(skill_key)
        if not skill_data:
            missing_skills[skill_key] = 'SKILL KEY NOT FOUND'
            continue
        missing_nodes = [nid for nid in tree.get('history', [])
                         if str(nid) not in skill_data['nodes']]
        if missing_nodes:
            missing_skills[skill_key] = missing_nodes

    if missing_passives:
        print(f'  [WARN] Missing passive nodeIds: {sorted(missing_passives)}')
    else:
        print(f'  [OK] All passive nodeIds resolved')

    if missing_skills:
        for key, issue in missing_skills.items():
            print(f'  [WARN] Skill {key}: {issue}')
    else:
        print(f'  [OK] All skill nodeIds resolved')

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()

    input_dir = args.input
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not os.path.isdir(input_dir):
        print(f'[ERROR] Input directory not found: {input_dir}', file=sys.stderr)
        sys.exit(1)

    print(f'Processing exports from: {input_dir}')
    print(f'Output to: {output_dir}\n')

    # Extract
    passives = extract_passives(input_dir)
    skills = extract_skills(input_dir)
    classes = extract_classes(input_dir)

    # Write outputs
    files = {
        'passives.json': passives,
        'skills.json': skills,
        'classes.json': classes,
    }
    for filename, data in files.items():
        out_path = output_dir / filename
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f'[write] {out_path} ({len(data)} entries)')

    # Validate
    if args.validate:
        validate_build(args.validate, passives, skills)

    print('\nDone.')

if __name__ == '__main__':
    main()
