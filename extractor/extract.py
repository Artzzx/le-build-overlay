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
    "stats":       [{ "statName": "...", "value": "+8%" }],
    "icon":        "es6ai/12.png"      ← path relative to db/data/icons/, or null
  }

─── Icons ───────────────────────────────────────────────────────────────────

  Icon files live in db/data/icons/ (any layout, .png/.webp/.jpg). Each input
  row's `icon` value is resolved against those files, case-insensitively:
    1. as a relative path          "es6ai/12.png" (any extension: finds es6ai/12.webp)
    2. by its longest path tail    "C:\\export\\icons\\es6ai\\12.png" → "es6ai/12.png"
    3. by file name                "Sprite_VoidLens.png"
    4. by file name w/o extension  "Sprite_VoidLens"
  Rows without an `icon` value fall back to the convention <treeID>/<nodeID>.*
  Unresolved icons become null (the app draws a placeholder) and are reported;
  --strict turns them into a failure.

─── Input ───────────────────────────────────────────────────────────────────

  nodes_flat.json is a flat array of node rows already tagged with treeID:
    { sourceType, nodeID, nodeName, description, maxPoints, treeID,
      treeFile, treeRawFields, stats, icon? }

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
  python extractor/extract.py --icons-dir path/to/icons --strict
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

OUTPUT_FIELDS = ('treeID', 'treeName', 'nodeID', 'nodeName', 'description', 'maxPoints', 'stats', 'icon')

DEFAULT_ICONS_DIR = DATA_DIR / 'icons'
ICON_EXTENSIONS = ('.webp', '.png', '.jpg', '.jpeg')  # earlier wins when a stem has several


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
            'icon':        (r.get('icon') or '').strip() or None,  # raw value; resolved later
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
            r = dict(r, icon=r['icon'] or same['icon'])
            groups[key][groups[key].index(same)] = r
        elif not same['icon'] and r['icon']:
            same['icon'] = r['icon']

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


# ─── Icons ────────────────────────────────────────────────────────────────────

class IconIndex:
    """Every image under icons_dir, looked up by relative path, file name or stem."""

    def __init__(self, icons_dir):
        self.dir = icons_dir
        self.by_path, self.by_path_stem, self.by_name, self.by_stem = {}, {}, {}, {}
        self.unconverted = []  # non-WebP files (run convert_icons.py before committing)
        self.ambiguous = set()
        if not icons_dir.is_dir():
            return
        files = sorted(p for p in icons_dir.rglob('*') if p.is_file() and p.suffix.lower() in ICON_EXTENSIONS)
        files.sort(key=lambda p: ICON_EXTENSIONS.index(p.suffix.lower()))  # stable: preferred extension first
        for f in files:
            rel = f.relative_to(icons_dir).as_posix()
            self.by_path.setdefault(rel.lower(), rel)
            # Extension-agnostic path: "es6ai/12.png" still finds "es6ai/12.webp" after conversion.
            self.by_path_stem.setdefault(rel.rsplit('.', 1)[0].lower(), rel)
            if f.suffix.lower() != '.webp':
                self.unconverted.append(rel)
            for table, key in ((self.by_name, f.name.lower()), (self.by_stem, f.stem.lower())):
                # Same key in another folder → ambiguous. (Same folder = same stem, other
                # extension: the preferred extension, sorted first, wins.)
                if key in table and Path(table[key]).parent != Path(rel).parent:
                    self.ambiguous.add(key)
                table.setdefault(key, rel)
        # A bare name/stem shared by files in different folders can't be resolved safely.
        for key in self.ambiguous:
            self.by_name.pop(key, None)
            self.by_stem.pop(key, None)

    def __len__(self):
        return len(self.by_path)

    def resolve(self, value):
        """Raw icon value → relative path under icons_dir, or None."""
        parts = [p for p in value.replace('\\', '/').split('/') if p not in ('', '.')]
        if not parts:
            return None
        for i in range(len(parts)):                      # longest tail first
            tail = '/'.join(parts[i:]).lower()
            hit = self.by_path.get(tail) or self.by_path_stem.get(tail.rsplit('.', 1)[0] if '.' in parts[-1] else tail)
            if hit:
                return hit
        name = parts[-1].lower()
        return self.by_name.get(name) or self.by_stem.get(name) or self.by_stem.get(Path(name).stem.lower())

    def convention(self, tree_id, node_id):
        """<treeID>/<nodeID>.<ext> — used when a row has no icon value."""
        for ext in ICON_EXTENSIONS:
            hit = self.by_path.get(f'{tree_id}/{node_id}{ext}'.lower())
            if hit:
                return hit
        return None


def resolve_icons(rows, index):
    """Replace each row's raw icon value with a resolved relative path (or None)."""
    report = {'from value': 0, 'from convention': 0, 'unresolved': [], 'no value': 0}
    for r in rows:
        raw = r['icon']
        if raw:
            r['icon'] = index.resolve(raw)
            if r['icon']:
                report['from value'] += 1
            else:
                report['unresolved'].append((r['treeID'], r['nodeID'], raw))
        else:
            r['icon'] = index.convention(r['treeID'], r['nodeID'])
            if r['icon']:
                report['from convention'] += 1
            else:
                report['no value'] += 1
    used = {r['icon'].lower() for r in rows if r['icon']}
    report['unused files'] = sorted(p for k, p in index.by_path.items() if k not in used)
    return report


# ─── Output contract ──────────────────────────────────────────────────────────

def validate_output(skills, passives, icons_dir):
    """What the app relies on. Returns a list of problems (empty = OK)."""
    problems = []
    types = {'treeID': str, 'treeName': str, 'nodeID': int, 'nodeName': str,
             'description': str, 'maxPoints': int, 'stats': list}
    seen = set()
    for label, rows in (('skills', skills), ('passives', passives)):
        for r in rows:
            where = f'{label} {r.get("treeID")}:{r.get("nodeID")}'
            if set(r) != set(OUTPUT_FIELDS):
                problems.append(f'{where}: fields {sorted(r)} != {sorted(OUTPUT_FIELDS)}')
                continue
            for field, typ in types.items():
                if not isinstance(r[field], typ) or (typ is int and isinstance(r[field], bool)):
                    problems.append(f'{where}: {field} should be {typ.__name__}, got {r[field]!r}')
            if isinstance(r['nodeID'], int) and r['nodeID'] < 0:
                problems.append(f'{where}: negative nodeID')
            if any(not isinstance(st, dict) or not isinstance(st.get('statName'), str) for st in r['stats']):
                problems.append(f'{where}: malformed stats')
            if r['icon'] is not None and not (icons_dir / r['icon']).is_file():
                problems.append(f'{where}: icon file missing: {r["icon"]}')
            key = (r['treeID'], r['nodeID'])
            if key in seen:
                problems.append(f'{where}: duplicate (treeID, nodeID)')
            seen.add(key)
    for t in PASSIVE_TREE_IDS:
        if not any(r['treeID'] == t for r in passives):
            problems.append(f'passives: no nodes for passive tree {t}')
    if any(r['treeID'] in PASSIVE_TREE_IDS for r in skills):
        problems.append('skills: contains passive tree rows')
    return problems


def main():
    ap = argparse.ArgumentParser(description='Clean nodes_flat.json into db/data runtime files.')
    ap.add_argument('--input', type=Path, default=DEFAULT_INPUT)
    ap.add_argument('--out-dir', type=Path, default=DATA_DIR)
    ap.add_argument('--icons-dir', type=Path, default=DEFAULT_ICONS_DIR, help='folder holding node icon images')
    ap.add_argument('--verbose', action='store_true', help='list every unresolved collision / icon')
    ap.add_argument('--strict', action='store_true', help='fail when any icon value cannot be resolved')
    args = ap.parse_args()

    raw = load_json(args.input)
    rows, stats = clean_rows(raw)
    rows, collisions = resolve_collisions(rows, stats)
    icon_index = IconIndex(args.icons_dir)
    icon_report = resolve_icons(rows, icon_index)

    passive_names = passive_tree_names()
    missing = [t for t in PASSIVE_TREE_IDS if t not in passive_names]
    if missing:
        sys.exit(f'classes.json passiveTreeByClass is missing: {missing}')

    names = tree_names(rows, passive_names)
    out = to_output(rows, names)

    passives = [r for r in out if r['treeID'] in PASSIVE_TREE_IDS]
    skills   = [r for r in out if r['treeID'] not in PASSIVE_TREE_IDS]

    problems = validate_output(skills, passives, args.icons_dir)
    if problems:
        print(f'ERROR: output breaks the app data contract ({len(problems)} problems) — nothing written:', file=sys.stderr)
        for p in problems[:50]:
            print(f'  {p}', file=sys.stderr)
        sys.exit(1)

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

    total = len(skills) + len(passives)
    with_icon = icon_report['from value'] + icon_report['from convention']
    if not len(icon_index):
        print(f'icons: none — {args.icons_dir} has no images (the app will draw placeholders)')
    else:
        print(f'icons: {with_icon}/{total} nodes have an icon '
              f'({icon_report["from value"]} from icon values, {icon_report["from convention"]} by <treeID>/<nodeID> convention); '
              f'{len(icon_index)} files in {args.icons_dir}')
        if icon_report['no value']:
            print(f'  {icon_report["no value"]} nodes have no icon value and no conventional file')
        if icon_index.unconverted:
            print(f'  WARNING: {len(icon_index.unconverted)} icons are not WebP — run '
                  f'python extractor/convert_icons.py before committing (≈6× smaller)')
        if icon_index.ambiguous:
            print(f'  WARNING: {len(icon_index.ambiguous)} file names exist in several folders — '
                  f'those only resolve by relative path: {sorted(icon_index.ambiguous)[:5]}')
        if icon_report['unused files']:
            print(f'  {len(icon_report["unused files"])} icon files are not referenced by any node'
                  + ('' if args.verbose else ' (use --verbose to list)'))
            if args.verbose:
                for f in icon_report['unused files']:
                    print(f'    {f}')
    unresolved = icon_report['unresolved']
    if unresolved:
        print(f'WARNING: {len(unresolved)} icon values match no file in {args.icons_dir}'
              + ('' if args.verbose else ' (use --verbose to list)'))
        if args.verbose:
            for tree_id, node_id, value in unresolved:
                print(f'  {tree_id}:{node_id} -> {value!r}')

    if collisions:
        print(f'WARNING: {len(collisions)} (treeID, nodeID) collisions resolved by keeping the first row'
              + ('' if args.verbose else ' (use --verbose to list)'))
        if args.verbose:
            for tree_id, node_id, group in collisions:
                alts = ', '.join(f'"{g["nodeName"]}" ({g["maxPoints"]}pt)' for g in group)
                print(f'  {tree_id}:{node_id} -> {alts}')

    if args.strict and unresolved:
        sys.exit(f'--strict: {len(unresolved)} unresolved icon values')


if __name__ == '__main__':
    main()
