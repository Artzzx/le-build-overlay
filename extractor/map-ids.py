#!/usr/bin/env python3
"""
extractor/map-ids.py
─────────────────────
⚠️  THIS SCRIPT IS OBSOLETE ⚠️

The skillKey mapping problem it was designed to solve no longer exists.

"Global Tree Data.json" contains a `treeID` field on every skill tree
that is exactly the same key Maxroll uses in its JSON export.

Examples:
  treeID "es6ai"  → Erasing Strike   (Maxroll: skillTrees.es6ai)
  treeID "v01cv"  → Void Cleave      (Maxroll: skillTrees.v01cv)
  treeID "vr53sl" → Volatile Reversal(Maxroll: skillTrees.vr53sl)
  treeID "fl44"   → Flay             (Maxroll: skillTrees.fl44)

extract.py reads treeID directly as the key for skills.json.
No intermediate mapping file is needed.

This file is kept for reference only and is safe to delete.
"""

print('This script is obsolete. See extractor/extract.py instead.')
print('The treeID field in "Global Tree Data.json" is the Maxroll skill key directly.')
