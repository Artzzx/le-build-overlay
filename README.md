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
                  extractor/nodes_flat.json  (flat node rows tagged with treeID)
                                    │
                                    ▼
                  extractor/extract.py  (cleanup)
                                    │
                                    ▼
   db/data/skill_tree_reconciled.json + db/data/passives.json   ← gitignored
                                    │   (falls back to skill_tree_reconciled.sample.json)
                                    ▼
          db/build-db.js (main) + overlay/app.js (renderer)
                    both index it via shared/tree-utils.js
```

**`skill_tree_reconciled.json`** (all skill trees) and **`passives.json`** (the 5 class passive trees) are flat arrays of nodes with the same row shape, each tagged with its `treeID`:

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
│       ├── skill_tree_reconciled.json         ← full skill data (gitignored, you generate it)
│       ├── passives.json                      ← class passive trees (gitignored, you generate it)
│       ├── skill_tree_reconciled.sample.json  ← committed subset / fallback
│       └── classes.json                       ← classId / masteryId → names, passive tree ids
├── extractor/
│   ├── nodes_flat.json           ← input: flat node export
│   └── extract.py                ← cleans nodes_flat.json → db/data/ files
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

> Not used by the current pipeline. Kept for reference / cross-checking node ids.

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

### Step 4 — Clean the flat node export

Build `extractor/nodes_flat.json` from the Step 3 export — a flat array of node rows
(`nodeID, nodeName, description, maxPoints, treeID, stats, …`). Then:

```bash
python extractor/extract.py            # add --verbose to list (treeID, nodeID) collisions
```

Writes to `db/data/`:
- `skill_tree_reconciled.json` — every skill tree (+ weaver tree)
- `passives.json` — the 5 class passive trees (`ac-1 mg-1 kn-1 rg-1 pr-1`)

Trees without a root node get their name from `TREE_NAME_OVERRIDES` in `extract.py`.

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
Likely a `(treeID, nodeID)` collision in `nodes_flat.json` — the stale node won. Run `python extractor/extract.py --verbose` to list them; the fix belongs in the exporter that produces `nodes_flat.json`.

**A skill shows its treeID instead of a name**
Its tree has no root node in the export. Add it to `TREE_NAME_OVERRIDES` in `extract.py`.

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
