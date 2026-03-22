#!/usr/bin/env python3
"""
Skill Tree Reconciler for Last Epoch Unity Exports
===================================================
Matches tree definition files (*Tree.json) to node files (SkillTreeNode #XXXXX.json)
across different Unity asset bundles where PathIDs don't match.

Strategy (4 phases):
  1. Exact name match: tree filename vs root node (id=0) nodeName
  2. Known name variants: manual mappings for renamed/alternate skill names
  3. Content-based matching: search node descriptions/stats for skill name mentions
  4. Class tree mapping: match 5 base class trees to large mastery node groups

Usage:
  python reconcile_skill_trees.py <path_to_MonoBehaviour_folder> [output_folder]

Output:
  - skill_tree_reconciled.json  (every node tagged with its treeID)
  - tree_summary.json           (one row per tree with node counts)
  - reconciliation_report.txt   (human-readable match log)
"""

import json
import os
import sys
import glob
import re
import difflib
from collections import defaultdict


# =============================================================================
# CONFIGURATION — Update these when game patches change names
# =============================================================================

# Phase 2: Known name variants where tree filename != root node name.
# Format: { "TreeFileName.json": "expected root node name (lowercase)" }
NAME_VARIANTS = {
    "NovaSkillTree.json": "elemental nova",
    "ThornTotemTree.json": "summon thorn totem",
    "SummonStormCrowTree.json": "summon storm crows",
    "SummonVolatileZombieTree.json": "volatile zombie",
    "EarthquakeSlamTree.json": "earthquake",
    "SwarmbladeTree.json": "swarmblade form",
    "SummonSkeletonMageTree.json": "summon skeletal mage",
    "GhostflameTree.json": "ghost flame",
    "RuneBoltSkillTree.json": "runebolt",
}

# Phase 4: Class trees don't have matching skill names in node groups.
# They map to large mastery groups identified by root node name.
# Format: { "TreeFileName.json": "expected root node name (lowercase)" }
CLASS_TREE_HINTS = {
    "RogueTree.json": "steady hand",
    "MageTree.json": "arcanist",
    "AcolyteTree.json": "bone aura",
    "KnightTree.json": "juggernaut",
    "PrimalistTree.json": "primal strength",
}


# =============================================================================
# HELPERS
# =============================================================================

def normalize_tree_name(fname):
    """Convert tree filename to comparable lowercase words.
    e.g. 'UmbralBladesTree.json' -> 'umbral blades'
    """
    s = re.sub(r"(Skill)?Tree\.json$", "", fname)
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    return s.strip().lower()


def get_root_name(nodes):
    """Get the nodeName of the root node (id=0) in a group."""
    root = [n for n in nodes if n["id"] == 0]
    return root[0]["nodeName"] if root else ""


def get_group_text(nodes):
    """Concatenate all searchable text in a node group (names, descriptions, stats)."""
    parts = []
    for n in nodes:
        parts.append(n["nodeName"].lower())
        parts.append(n["description"].lower())
        for s in n["stats"]:
            parts.append(s["statName"].lower())
    return " ".join(parts)


# =============================================================================
# DATA LOADING
# =============================================================================

def load_tree_files(base_dir):
    """Load all *Tree.json definition files."""
    patterns = [
        os.path.join(base_dir, "*Tree.json"),
        os.path.join(base_dir, "*Tree *.json"),
    ]
    tree_files = sorted(set(f for p in patterns for f in glob.glob(p)))
    trees = {}
    for f in tree_files:
        with open(f) as fh:
            d = json.load(fh)
        fname = os.path.basename(f)
        trees[fname] = {
            "treeID": d.get("treeID"),
            "nodeCount": len(d.get("nodeList", [])),
            "hasAbility": "ability" in d,
            "isClass": "characterClass" in d,
        }
    return trees


def load_skill_tree_nodes(base_dir):
    """Load all SkillTreeNode files from the Node/ subdirectory."""
    node_dir = os.path.join(base_dir, "Node")
    if not os.path.isdir(node_dir):
        print(f"WARNING: Node directory not found at {node_dir}")
        return {}

    node_files = sorted(glob.glob(os.path.join(node_dir, "SkillTreeNode *.json")))
    node_groups = defaultdict(list)

    for f in node_files:
        m = re.search(r"#(\d+)", os.path.basename(f))
        pathid = int(m.group(1)) if m else 0
        with open(f) as fh:
            d = json.load(fh)
        tree_ref = d["tree"]["m_PathID"]
        node_groups[tree_ref].append({
            "pathid": pathid,
            "id": d["id"],
            "nodeName": d["nodeName"],
            "description": d.get("description", ""),
            "maxPoints": d.get("maxPoints", 0),
            "stats": [
                {"statName": s.get("statName", ""), "value": s.get("value", "")}
                for s in d.get("stats", [])
            ],
        })

    return dict(node_groups)


def load_weaver_tree_nodes(base_dir):
    """Load all WeaverTreeNode files (separate node type)."""
    weaver_files = sorted(glob.glob(os.path.join(base_dir, "WeaverTreeNode *.json")))
    nodes = []
    for f in weaver_files:
        m = re.search(r"#(\d+)", os.path.basename(f))
        pathid = int(m.group(1)) if m else 0
        with open(f) as fh:
            d = json.load(fh)
        nodes.append({
            "pathid": pathid,
            "id": d["id"],
            "nodeName": d["nodeName"],
            "description": d.get("description", ""),
            "maxPoints": d.get("maxPoints", 0),
            "stats": [
                {"statName": s.get("statName", ""), "value": s.get("value", "")}
                for s in d.get("stats", [])
            ],
        })
    return nodes


# =============================================================================
# MATCHING ENGINE
# =============================================================================

def reconcile(trees, node_groups, report_lines):
    """Run all matching phases. Returns dict: { tree_filename -> tree_ref }"""
    matched = {}
    used_refs = set()

    def log(msg):
        report_lines.append(msg)

    # ---- Phase 1: Exact name match ----
    log("=" * 60)
    log("PHASE 1: Exact name match (filename vs root node name)")
    log("=" * 60)

    for fname in sorted(trees.keys()):
        tn = normalize_tree_name(fname)
        for tree_ref in node_groups:
            if tree_ref in used_refs:
                continue
            rn = get_root_name(node_groups[tree_ref]).strip().lower()
            if tn == rn:
                matched[fname] = tree_ref
                used_refs.add(tree_ref)
                log(f"  MATCH  {fname:45s} -> ref={tree_ref} root='{rn}'")
                break

    log(f"\nPhase 1 total: {len(matched)} matched\n")

    # ---- Phase 2: Known name variants ----
    log("=" * 60)
    log("PHASE 2: Known name variants")
    log("=" * 60)

    for fname, target_name in NAME_VARIANTS.items():
        if fname in matched:
            continue
        if fname not in trees:
            log(f"  SKIP   {fname} (not found in tree files)")
            continue
        for tree_ref in node_groups:
            if tree_ref in used_refs:
                continue
            rn = get_root_name(node_groups[tree_ref]).strip().lower()
            if rn == target_name:
                matched[fname] = tree_ref
                used_refs.add(tree_ref)
                log(f"  MATCH  {fname:45s} -> ref={tree_ref} root='{rn}'")
                break
        else:
            log(f"  MISS   {fname} (target '{target_name}' not found in any group)")

    log(f"\nPhase 2 total: {len(matched)} matched\n")

    # ---- Phase 3: Content-based matching (skill trees only, not class trees) ----
    log("=" * 60)
    log("PHASE 3: Content-based matching (node text search)")
    log("=" * 60)

    class_tree_names = {f for f, t in trees.items() if t["isClass"]}
    large_groups = {ref for ref in node_groups if len(node_groups[ref]) >= 100}

    remaining_skill = [
        f for f in trees
        if f not in matched
        and f not in class_tree_names
        and trees[f]["treeID"] is not None
        and trees[f]["nodeCount"] > 0
    ]
    remaining_refs = [
        r for r in node_groups
        if r not in used_refs and r not in large_groups
    ]

    group_texts = {ref: get_group_text(node_groups[ref]) for ref in remaining_refs}

    for fname in sorted(remaining_skill):
        tn = normalize_tree_name(fname)
        words = [w for w in tn.split() if len(w) >= 4]
        if not words:
            words = tn.split()

        best_ref = None
        best_score = 0
        for ref in remaining_refs:
            if ref in used_refs:
                continue
            score = sum(group_texts[ref].count(w) for w in words)
            if score > best_score:
                best_score = score
                best_ref = ref

        if best_ref and best_score >= 15:
            matched[fname] = best_ref
            used_refs.add(best_ref)
            remaining_refs.remove(best_ref)
            root = get_root_name(node_groups[best_ref])
            log(f"  MATCH  {fname:45s} -> ref={best_ref} root='{root}' (score={best_score})")
        else:
            log(f"  MISS   {fname:45s} (best score={best_score}, threshold=15)")

    log(f"\nPhase 3 total: {len(matched)} matched\n")

    # ---- Phase 4: Class trees -> large mastery node groups ----
    log("=" * 60)
    log("PHASE 4: Class tree mapping")
    log("=" * 60)

    for fname, target_root in CLASS_TREE_HINTS.items():
        if fname in matched:
            continue
        if fname not in trees:
            log(f"  SKIP   {fname} (not found in tree files)")
            continue
        for tree_ref in node_groups:
            if tree_ref in used_refs:
                continue
            rn = get_root_name(node_groups[tree_ref]).strip().lower()
            if rn == target_root:
                matched[fname] = tree_ref
                used_refs.add(tree_ref)
                log(f"  MATCH  {fname:45s} -> ref={tree_ref} root='{rn}' ({len(node_groups[tree_ref])} nodes)")
                break
        else:
            log(f"  MISS   {fname} (target '{target_root}' not found)")

    log(f"\nPhase 4 total: {len(matched)} matched\n")

    # ---- Summary ----
    log("=" * 60)
    log("UNMATCHED TREES")
    log("=" * 60)
    for f in sorted(trees.keys()):
        if f not in matched and f != "WeaverTree.json":
            t = trees[f]
            log(f"  {f} (treeID={t['treeID']}, nodes={t['nodeCount']})")

    log("")
    log("=" * 60)
    log("UNMATCHED NODE GROUPS")
    log("=" * 60)
    for ref in sorted(node_groups.keys()):
        if ref not in used_refs:
            rn = get_root_name(node_groups[ref])
            log(f"  ref={ref} root='{rn}' nodes={len(node_groups[ref])}")

    return matched


# =============================================================================
# OUTPUT GENERATION
# =============================================================================

def build_output(matched, trees, node_groups, weaver_nodes):
    """Build the final reconciled node list."""
    results = []

    for fname, tree_ref in sorted(matched.items()):
        t = trees[fname]
        nodes = node_groups[tree_ref]
        root_name = get_root_name(nodes)
        display_name = (
            root_name
            if root_name and root_name != "Name" and root_name != ""
            else normalize_tree_name(fname).title()
        )

        for n in sorted(nodes, key=lambda x: x["id"]):
            results.append({
                "treeFile": fname,
                "treeID": t["treeID"],
                "treeName": display_name,
                "nodeID": n["id"],
                "nodeName": n["nodeName"],
                "description": n["description"],
                "maxPoints": n["maxPoints"],
                "stats": n["stats"],
                "nodePathID": n["pathid"],
                "treeRef": tree_ref,
            })

    # WeaverTree nodes (separate node type)
    if weaver_nodes:
        for n in sorted(weaver_nodes, key=lambda x: x["id"]):
            results.append({
                "treeFile": "WeaverTree.json",
                "treeID": "weaver",
                "treeName": "Weaver",
                "nodeID": n["id"],
                "nodeName": n["nodeName"],
                "description": n["description"],
                "maxPoints": n["maxPoints"],
                "stats": n["stats"],
                "nodePathID": n["pathid"],
                "treeRef": 433109,
            })

    return results


def build_summary(results):
    """Build one-row-per-tree summary."""
    seen = set()
    summary = []
    for r in results:
        key = (r["treeFile"], r["treeID"])
        if key not in seen:
            seen.add(key)
            count = sum(1 for x in results if x["treeFile"] == r["treeFile"])
            summary.append({
                "treeFile": r["treeFile"],
                "treeID": r["treeID"],
                "treeName": r["treeName"],
                "nodeCount": count,
                "treeRef": r["treeRef"],
            })
    return summary


# =============================================================================
# MAIN
# =============================================================================

def main():
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <MonoBehaviour_folder> [output_folder]")
        sys.exit(1)

    base_dir = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(base_dir, "reconciled_output")
    os.makedirs(out_dir, exist_ok=True)

    print(f"Input:  {base_dir}")
    print(f"Output: {out_dir}")
    print()

    # Load data
    print("Loading tree definition files...")
    trees = load_tree_files(base_dir)
    print(f"  Found {len(trees)} tree files")

    print("Loading SkillTreeNode files...")
    node_groups = load_skill_tree_nodes(base_dir)
    print(f"  Found {len(node_groups)} node groups ({sum(len(v) for v in node_groups.values())} nodes)")

    print("Loading WeaverTreeNode files...")
    weaver_nodes = load_weaver_tree_nodes(base_dir)
    print(f"  Found {len(weaver_nodes)} weaver nodes")
    print()

    # Run matching
    report_lines = []
    matched = reconcile(trees, node_groups, report_lines)

    # Build output
    results = build_output(matched, trees, node_groups, weaver_nodes)
    summary = build_summary(results)

    # Print summary
    print(f"\n{'='*60}")
    print(f"RESULTS")
    print(f"{'='*60}")
    print(f"  Trees matched:     {len(matched)} + WeaverTree = {len(matched) + (1 if weaver_nodes else 0)}")
    print(f"  Total nodes:       {len(results)}")
    print(f"  Unique treeIDs:    {len(set(r['treeID'] for r in results if r['treeID']))}")
    unmatched = [f for f in trees if f not in matched and f != "WeaverTree.json"]
    print(f"  Unmatched trees:   {len(unmatched)} (all empty placeholders with 0 nodes)")
    unmatched_g = [r for r in node_groups if r not in {matched[f] for f in matched}]
    print(f"  Orphan groups:     {len(unmatched_g)}")

    # Write files
    reconciled_path = os.path.join(out_dir, "skill_tree_reconciled.json")
    with open(reconciled_path, "w") as fh:
        json.dump(results, fh, indent=2)
    print(f"\n  -> {reconciled_path}")

    summary_path = os.path.join(out_dir, "tree_summary.json")
    with open(summary_path, "w") as fh:
        json.dump(summary, fh, indent=2)
    print(f"  -> {summary_path}")

    report_path = os.path.join(out_dir, "reconciliation_report.txt")
    with open(report_path, "w") as fh:
        fh.write("\n".join(report_lines))
    print(f"  -> {report_path}")

    print("\nDone!")


if __name__ == "__main__":
    main()
