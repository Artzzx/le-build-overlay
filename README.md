# LE Build Overlay

A transparent, always-on-top Electron overlay for **Last Epoch** that displays your build plan from [Maxroll](https://maxroll.gg/last-epoch/planner) and lets you advance step-by-step through passive and skill tree allocations using keyboard hotkeys — while playing, without alt-tabbing.

```
┌─────────────────────────────┐
│ [P] Juggernaut     42/113 1 │
│ [S] Erasing Str    14/26  2 │
│ [S] Void Reversal  20/20  3 │
│ [S] Smite          12/18  4 │
│ [S] Shield Rush     8/20  5 │
│ [S] Anomaly         3/16  6 │
│ F1 hide · 1-6 advance       │
└─────────────────────────────┘
```

- **F1** — toggle overlay visibility
- **1–6** — advance that track one step
- **Shift+1–6** — undo one step
- **F5** — open build config window (paste Maxroll JSON here)

---

## Quick Start

```bash
npm install
npm run dev
```

Press F5, paste your Maxroll build JSON, and start playing.

---

## Data Pipeline

The overlay needs enriched game data to show real node names and descriptions. Here's how that data flows:

```
Game files (AssetStudio export)
        │
        ▼
extractor/extract.py
        │
        └─► db/data/skill_tree_reconciled.json   ← only output, read by runtime
                │
                ▼
        build-db.js + app.js
```

**`skill_tree_reconciled.json`** is the single file the runtime reads — a flat array of every node across all skill and passive trees, each tagged with its `treeID`:

```json
[
  {
    "treeID":      "ub5d9",
    "treeName":    "Umbral Blades",
    "nodeID":      5,
    "nodeName":    "Hidden Blades",
    "description": "Umbral Blades deals more damage...",
    "maxPoints":   4,
    "stats":       []
  },
  ...
]
```

**Current state:** `extract.py` produces this file with ~68% of nodes having real display names (matched by root node name). The remaining ~32% fall back to internal names. The reconciliation work (see below) aims to close that gap.

---

## Reconciliation — Active Work

The core challenge: node files from the AssetStudio export need to be matched to the correct `treeID`. The matching works by grouping `SkillTreeNode #*.json` files by their `tree.m_PathID` value, then identifying each group using the root node's display name. This works for most skills but fails for ~20 trees whose root node has a placeholder name (`"Name"`) instead of the real skill name.

**The reconciliation problem in brief:**

- `UmbralBladesTree.json` → `{ treeID: "ub5d9", nodeList: [...] }` — knows the treeID but references nodes by Unity pathID
- `SkillTreeNode #346591.json` → `{ id: 5, nodeName: "Hidden Blades", tree.m_PathID: 387412 }` — has the real data but pathIDs don't match across asset bundles

The goal is to find a strategy that reliably matches every node group to the correct treeID, including the ~20 placeholder-named trees.

---

## Project Structure

```
le-build-overlay/
├── electron/
│   ├── main.js               ← Electron main process, windows, global hotkeys
│   ├── preload.js            ← Secure IPC bridge (contextBridge)
│   ├── config-preload.js
│   └── settings-preload.js
├── overlay/
│   ├── index.html            ← Transparent overlay UI
│   ├── app.js                ← Renderer: state, rendering, IPC
│   ├── config.html/js        ← Build paste UI (F5)
│   ├── settings.html/js      ← Settings window
│   └── style.css             ← Dark metallic theme
├── parser/
│   ├── maxroll.js            ← Parse raw Maxroll JSON → normalized build
│   └── build-schema.js       ← Build format validation
├── db/
│   ├── build-db.js           ← Load/query db/data/ (reads skill_tree_reconciled.json)
│   └── data/
│       ├── skill_tree_reconciled.json  ← RUNTIME DATA — flat node array
│       ├── skills.json                 ← intermediate (nested by treeID)
│       ├── passives.json               ← intermediate (nested by treeID)
│       └── classes.json                ← classId/masteryId → names
├── extractor/
│   └── extract.py            ← Regenerate db/data/ from game assets
├── config/
│   ├── build.json            ← Active build (runtime state, gitignored)
│   └── build.example.json
└── tests/
    ├── db.test.js
    └── parser.test.js
```

---

## Game Data Extraction

Run this once after setup, then again after any game patch that changes skill or passive trees.

### Tools Required

| Tool | Version | Download |
|------|---------|----------|
| **Il2CppDumper** | v6.7.46+ | [github.com/Perfare/Il2CppDumper](https://github.com/Perfare/Il2CppDumper/releases) |
| **AssetStudioMod CLI** | v0.19.0+ | [github.com/aelurum/AssetStudio](https://github.com/aelurum/AssetStudio/releases) |
| **Python** | 3.10+ | [python.org](https://www.python.org/downloads/) |

---

### Step 1 — Il2CppDumper

Generates type definitions AssetStudio needs to deserialize MonoBehaviour assets.

```
"C:\Tools\Il2CppDumper\Il2CppDumper.exe" ^
  "C:\...\Last Epoch\GameAssembly.dll" ^
  "C:\...\Last Epoch\Last Epoch_Data\il2cpp_data\Metadata\global-metadata.dat" ^
  "C:\Tools\le_dump"
```

Output: `C:\Tools\le_dump\DummyDll\` — only needed once per major engine update.

---

### Step 2 — Export "Global Tree Data"

This one file contains every skill and passive tree: node IDs, maxPoints, requirements.

```
"C:\Tools\AssetStudioMod\AssetStudioModCLI.exe" ^
  "C:\...\Last Epoch\Last Epoch_Data" ^
  -t monobehaviour ^
  --filter-by-name "Global Tree Data" ^
  --assembly-folder "C:\Tools\le_dump\DummyDll" ^
  -o "C:\Tools\le_export" ^
  --log-output both
```

Output: `C:\Tools\le_export\MonoBehaviour\Global Tree Data.json` — takes 1–2 minutes.

---

### Step 3 — Export SkillTreeNode files (real names and descriptions)

Exports all MonoBehaviour assets including `SkillTreeNode #*.json` files which contain real in-game display names and descriptions.

```
"C:\Tools\AssetStudioMod\AssetStudioModCLI.exe" ^
  "C:\...\Last Epoch\Last Epoch_Data" ^
  -t monobehaviour ^
  --assembly-folder "C:\Tools\le_dump\DummyDll" ^
  -o "C:\Tools\le_export" ^
  --log-output both
```

Takes 10–15 minutes. You can skip this step to get a working overlay with internal names first.

> Move the `SkillTreeNode #*.json` files into a dedicated subfolder (e.g. `MonoBehaviour\Node\`) to keep them separate from tree definition files. The extractor scans recursively.

---

### Step 4 — Run extract.py

```bash
# Copy Global Tree Data into project root
copy "C:\Tools\le_export\MonoBehaviour\Global Tree Data.json" "Global Tree Data.json"

# Basic run (internal names only):
python extractor/extract.py

# Full run (with real display names):
python extractor/extract.py --nodes C:\Tools\le_export\MonoBehaviour\Node
```

Writes one file to `db/data/`:
- `skill_tree_reconciled.json` — flat node array, the only file the runtime reads

---

### After a Patch

| What changed | Steps to redo |
|---|---|
| Skills or passives rebalanced | Steps 2 → 4 |
| New skills added | Steps 2 → 4 (+ Step 3 for real names) |
| Engine update | Steps 1 → 2 → 3 → 4 |

---

## Troubleshooting

**"Global Tree Data.json not found"**
Copy the file to the project root: `le-build-overlay/Global Tree Data.json`.

**Overlay shows internal names like "Void Cleave Crit Multi And Mana On Crit"**
Run Step 3 (full MonoBehaviour export) then re-run extract.py with `--nodes`.

**extract.py reports unmatched groups**
A skill was renamed in a patch. Add an entry to `DISPLAY_NAME_OVERRIDES` in `extract.py`:
```python
DISPLAY_NAME_OVERRIDES = {
    'new display name': 'internal gdt name',
}
```

---

## No skillKey Mapping Needed

The `treeID` in `Global Tree Data.json` is the exact same key Maxroll uses in build exports. No lookup table required.

| Maxroll export key | treeID | Skill |
|--------------------|--------|-------|
| `es6ai` | es6ai | Erasing Strike |
| `v01cv` | v01cv | Void Cleave |
| `an0my` | an0my | Anomaly |
| `sr31hu` | sr31hu | Shield Rush |
