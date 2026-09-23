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
- **1–6** — advance that track one point
- **Shift+1–6** — undo one point
- **F5** — open the loadout window (paste Maxroll / in-game export codes, one or more phases)
- **F6 / Shift+F6** — next / previous phase
- **F2** — settings (font, opacity, hotkeys, direct vs. latch mode)
- **F3** — position mode (drag / resize the overlay)

---

## Quick Start

```bash
npm install
npm run dev
```

Press F5, paste your export codes, and start playing.

Out of the box the overlay uses `db/data/skill_tree_reconciled.sample.json` — a small committed subset (all 5 passive trees + a handful of skills). Skills outside the sample show **"no data"** and can't be advanced until you generate the full data file (see below). To try it immediately:

```bash
cp config/build.example.json config/build.json
npm run dev
```

Run tests with `npm test`.

---

## Data Pipeline

```
Game files ──AssetStudio──► MonoBehaviour export (*Tree.json + SkillTreeNode #*.json)
                                    │
                                    ▼
                  extractor/reconcile_skill_trees.py
                                    │
                                    ▼
             db/data/skill_tree_reconciled.json   ← gitignored, ~2.5 MB
                                    │   (falls back to skill_tree_reconciled.sample.json)
                                    ▼
          db/build-db.js (main) + overlay/app.js (renderer)
                    both index it via shared/tree-utils.js
```

**`skill_tree_reconciled.json`** is a flat array of every node across all skill and passive trees, each tagged with its `treeID`:

```json
{
  "treeID":      "fl44",
  "treeName":    "Flay",
  "nodeID":      4,
  "nodeName":    "Scent of Death",
  "description": "Enemies hit by Flay are inflicted with Marked for Death…",
  "maxPoints":   4,
  "stats":       [{ "statName": "Kill Threshold", "value": "3%" }]
}
```

**Known data issues:** some `(treeID, nodeID)` pairs appear twice (a stale node asset exported next to the live one), and ~94 nodes have a blank or placeholder name. The app picks one deterministically (a real name beats a placeholder, otherwise the first row wins) and logs the count — but the pick can be the stale node. See CLAUDE.md → Known data-quality issues.

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
│   ├── main.js               ← main process: windows, global hotkeys, IPC, file I/O
│   ├── preload.js            ← overlay IPC bridge (contextBridge)
│   ├── config-preload.js     ← loadout window bridge
│   └── settings-preload.js   ← settings window bridge
├── overlay/
│   ├── index.html / app.js / style.css   ← transparent overlay
│   ├── config.html / config.js           ← loadout paste UI (F5)
│   └── settings.html / settings.js       ← settings (F2)
├── shared/
│   └── tree-utils.js         ← pure logic shared by main + renderer (grouping, lookup, stepping, phases)
├── parser/
│   ├── maxroll.js            ← raw Maxroll paste → normalized build / multi-phase loadout
│   └── build-schema.js       ← validation
├── db/
│   ├── build-db.js           ← loads db/data/
│   └── data/
│       ├── skill_tree_reconciled.json         ← full data (gitignored, you generate it)
│       ├── skill_tree_reconciled.sample.json  ← committed subset / fallback
│       └── classes.json                       ← classId / masteryId → names, passive tree ids
├── extractor/
│   ├── reconcile_skill_trees.py  ← generates skill_tree_reconciled.json
│   └── extract.py                ← legacy (outputs not used by the app)
├── config/
│   ├── build.example.json        ← example 2-phase loadout
│   └── maxroll-paste.example.txt ← example multi-line paste
│   (build.json, settings.json, saves/ are runtime state — gitignored)
└── tests/
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

### Step 2 — Export "Global Tree Data" (optional)

> Only used by the legacy `extract.py`. The app's data comes from Steps 3–4; skip this unless you're working on the extractor.

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

### Step 4 — Run the reconciler

`reconcile_skill_trees.py` needs the MonoBehaviour folder containing both the `*Tree.json` tree definitions and the `SkillTreeNode #*.json` files (Step 3):

```bash
python extractor/reconcile_skill_trees.py C:\Tools\le_export\MonoBehaviour db/data
```

Writes to `db/data/`:
- `skill_tree_reconciled.json` — the file the app reads
- `tree_summary.json`, `reconciliation_report.txt` — diagnostics (check the report for unmatched trees)

> `extractor/extract.py` (Global Tree Data → `skills.json`/`passives.json`) is legacy: nothing reads its output.

---

### After a Patch

| What changed | Steps to redo |
|---|---|
| Skills or passives rebalanced | Steps 3 → 4 |
| New skills added | Steps 3 → 4 |
| Engine update | Steps 1 → 3 → 4 |

---

## Troubleshooting

**Tracks show "no data"**
That skill (or passive tree) isn't in the loaded data. You're probably running on the committed sample — generate the full `db/data/skill_tree_reconciled.json` (Steps 3–4).

**A node shows the wrong name**
Likely a duplicate `(treeID, nodeID)` in the reconciled data — the stale node won. Check `reconciliation_report.txt`; the fix belongs in `reconcile_skill_trees.py`.

**Reconciler reports unmatched trees**
A skill was renamed in a patch. Add an entry to `NAME_VARIANTS` in `reconcile_skill_trees.py`:
```python
NAME_VARIANTS = {
    "SomeSkillTree.json": "root node display name (lowercase)",
}
```

**A hotkey doesn't work**
Saving settings reports any key that couldn't be registered (invalid, or already taken by another app). Pick a different key.

---

## No skillKey Mapping Needed

The `treeID` in `Global Tree Data.json` is the exact same key Maxroll uses in build exports. No lookup table required.

| Maxroll export key | treeID | Skill |
|--------------------|--------|-------|
| `es6ai` | es6ai | Erasing Strike |
| `v01cv` | v01cv | Void Cleave |
| `an0my` | an0my | Anomaly |
| `sr31hu` | sr31hu | Shield Rush |
