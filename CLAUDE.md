# LE Build Overlay — Claude Code Context

## What This Project Is

A transparent, always-on-top **Electron overlay** for the game **Last Epoch (LE)** that shows a player's build progression plan (from the Maxroll planner or in-game export) and lets them advance point-by-point with global hotkeys while playing — a "co-pilot" for allocating passive and skill tree points in the right order.

The overlay is click-through (never interferes with gameplay) and is driven entirely by global hotkeys registered via Electron's `globalShortcut`.

---

## Directory Structure

```
le-build-overlay/
├── CLAUDE.md                         ← YOU ARE HERE
├── README.md                         ← user-facing setup + extraction guide
├── package.json                      ← npm start / npm run dev / npm test
├── electron/
│   ├── main.js                       ← main process: windows, hotkeys, IPC, file I/O
│   ├── preload.js                    ← overlay bridge   → window.electronAPI
│   ├── config-preload.js             ← config bridge    → window.configAPI
│   └── settings-preload.js           ← settings bridge  → window.settingsAPI
├── overlay/
│   ├── index.html / app.js / style.css   ← overlay window (renderer)
│   ├── config.html / config.js           ← F5 "Load Loadout" window (multi-phase paste + templates)
│   └── settings.html / settings.js       ← F2 settings window
├── shared/
│   └── tree-utils.js                 ← PURE logic used by BOTH main (require) and renderer (<script>)
├── parser/
│   ├── maxroll.js                    ← raw Maxroll paste → normalized build / loadout
│   └── build-schema.js               ← validators (validateBuild, validateLoadout, …)
├── db/
│   ├── build-db.js                   ← loads db/data into memory (main process + tests)
│   └── data/
│       ├── skill_tree_reconciled.json         ← FULL node data (gitignored, ~2.5 MB, regenerated per patch)
│       ├── skill_tree_reconciled.sample.json  ← COMMITTED subset; auto-fallback when full file absent
│       └── classes.json                       ← hand-maintained class/mastery/passive-tree mapping
├── extractor/
│   ├── reconcile_skill_trees.py      ← PRODUCES skill_tree_reconciled.json (the real pipeline)
│   └── extract.py                    ← LEGACY: writes skills.json/passives.json, not read by anything
├── config/
│   ├── build.json                    ← live loadout + progress (gitignored runtime state)
│   ├── settings.json                 ← user settings + window bounds (gitignored runtime state)
│   ├── saves/                        ← saved loadout templates (gitignored)
│   ├── build.example.json            ← 2-phase example loadout (resolves against the sample data)
│   └── maxroll-paste.example.txt     ← real multi-line Maxroll paste (Rogue) for manual testing
├── scripts/dev.js                    ← launches Electron with --dev
└── tests/                            ← node:test — db, parser, tree-utils
```

---

## Module Relationships

```
config.js ──configAPI──► main.js ('load-loadout')
                           ├─ db/build-db.js  (load(true) → { skills, classes })
                           │     └─ shared/tree-utils.js makeDb()
                           ├─ parser/maxroll.js parseLoadout → parseBuild → mergeRawLines
                           │     └─ parser/build-schema.js validate* / initializeBuild
                           ├─ writes config/build.json
                           └─ sends 'reload-build' to overlay
app.js (overlay renderer, window.TreeUtils from shared/tree-utils.js)
   ├─ fetch ../config/build.json → normalizeBuild()
   ├─ fetch ../db/data/skill_tree_reconciled.json (else .sample.json) + classes.json → makeDb()
   ├─ 'hotkey' IPC → stepTrack() / switchPhase() (computeTransition + applyCarryOver)
   └─ 'save-build' IPC after every change → main writes config/build.json
settings.js ──settingsAPI──► main.js ('save-settings' → re-register hotkeys, returns failedHotkeys)
```

**Rule:** any logic that both main and the renderer need goes in `shared/tree-utils.js` (UMD: `module.exports` in Node, `window.TreeUtils` in the browser). It must stay pure — no `fs`, DOM or Electron. Don't re-implement grouping/lookup/stepping in `app.js`.

---

## Key Domain Concepts

### Tracks
- **Passive track**: the class passive tree (exactly 1 per build/phase)
- **Skill tracks**: one per equipped skill (up to 5)

Each track has a flat `history[]` (ordered allocation) and `currentStep`.

### currentStep is a FLAT point count
`currentStep` = number of history entries allocated. `0` = nothing, `history.length` = complete. One hotkey press = one point. It is **not** a group index.

### Grouped steps (derived, never stored)
```js
groupHistory([6,6,6,4,4]) → [{nodeId:6,count:3,startIdx:0},{nodeId:4,count:2,startIdx:3}]
findCurrentGroup(groups, currentStep) // group where startIdx <= step < startIdx+count, or null if complete
```

### Skill keys = treeIDs
Maxroll's `skillTrees` keys are the game's `treeID` verbatim — no mapping table. e.g. `es6ai` = Erasing Strike, `v01cv` = Void Cleave, `fl44` = Flay, `fi9` = Fireball.

### Mastery IDs are per-class relative (1–3)
Maxroll `mastery` is 1–3 within the class, **not** a global id. Look up via `classes.json → masteriesByClass[classId][masteryId]` (Sentinel 2 = Void Knight).

### Phases (loadouts)
A loadout has several phases (e.g. Leveling → Endgame), all the same class/mastery. On phase switch (F6/Shift+F6):
- `applyCarryOver`: each target track starts at `min(fromProgress, commonPrefixLength(fromHistory, toHistory))`; trees not in the source phase start at 0.
- `computeTransition`: lists points to unspec (progress beyond the shared prefix) and skills to remove from the bar. Shown as a panel for 3 s (15 s if unspec needed).

---

## Data Formats

### Raw Maxroll paste (config window input)
Maxroll/in-game export gives one JSON object per section; users paste them as separate lines. `mergeRawLines` merges them:
```
{"passives":{"history":[6,6,6,...],"position":113},"class":4,"mastery":2}
{"skillTrees":{"htsk5":{"history":[9,10,1,...],"position":26}}}
{"skillTrees":{"smbmb":{"history":[17,17,18,...],"position":22}}}
```
A single combined object is also accepted. See `config/maxroll-paste.example.txt`.

### config/build.json — multi-phase LOADOUT (what is actually stored)
```json
{
  "name": "Void Knight Erasing Strike",
  "classId": 3,
  "masteryId": 2,
  "currentPhase": 0,
  "phases": [
    { "name": "Leveling", "tracks": [
      { "type": "passive", "label": "Sentinel — Void Knight Passives", "history": [0,0,1], "totalSteps": 3, "currentStep": 0 },
      { "type": "skill", "skillKey": "v01cv", "label": "Void Cleave", "history": [2,2,4], "totalSteps": 3, "currentStep": 0 }
    ]}
  ]
}
```
The legacy single-phase shape (`{ name, classId, masteryId, tracks }`) is still accepted on load and wrapped by `normalizeBuild()`.

### db/data/skill_tree_reconciled.json — flat node rows
```json
{ "treeFile": "FlayTree.json", "treeID": "fl44", "treeName": "Flay", "nodeID": 4,
  "nodeName": "Scent of Death", "description": "Enemies hit by Flay are…",
  "maxPoints": 4, "stats": [{"statName": "Kill Threshold", "value": "3%"}],
  "nodePathID": 823569, "treeRef": 482579 }
```
Passive trees are in the same file (`kn-1`, `rg-1`, …). Indexed by `makeDb()` into:
```js
{ passives: trees, skills: trees /* same object */, classes, duplicates }
trees = { [treeID]: { name, nodes: { [String(nodeID)]: { id, nodeName, description, maxPoints, stats } } } }
```
Display name: `node.nodeName`. There is **no** internal `name` field any more.

<<<<<<< HEAD
Same flat row shape as `skill_tree_reconciled.json`
(`treeID, treeName, nodeID, nodeName, description, maxPoints, stats`), containing only
the 5 class passive trees. `treeName` is the class name. The runtime loaders merge both
files into one map keyed by `treeID` (shape below). Lookup requires classId → treeID first.
=======
### classes.json
>>>>>>> a503f72b204c3e4da2b72132de8f9f0128760329
```json
{
  "classes": { "3": "Sentinel" },
  "masteriesByClass": { "3": { "1": "Forge Guard", "2": "Void Knight", "3": "Paladin" } },
  "passiveTreeByClass": { "1": "ac-1", "2": "mg-1", "3": "kn-1", "4": "rg-1", "5": "pr-1" }
}
```

### Known data-quality issues (reconciler output)
- **Duplicate `(treeID, nodeID)` rows** (~137 in the full file): stale/removed node assets exported next to live ones, e.g. `es6ai` node 12 = "Rythm of the Void" *and* "Void Lens". `indexNodes` resolves deterministically (real name beats blank/`"Name"` placeholder, else first row wins) and reports the count, but **the winner may be the stale node**. Proper fix belongs in `reconcile_skill_trees.py` (cross-check with Global Tree Data maxPoints/requirements).
- Blank / `"Name"` placeholder `nodeName` on ~94 nodes.
- Passive `treeName` is the root node's name (e.g. `kn-1` → "Juggernaut"), not the class. The overlay ignores it and builds the passive label from `classes.json`.

---

## Electron Architecture

### Windows
| Window | Opened by | Preload | Notes |
|---|---|---|---|
| Overlay | startup | `preload.js` | transparent, frameless, `focusable:false`, click-through |
| Config ("Load Loadout") | F5 | `config-preload.js` | multi-phase paste, templates |
| Settings | F2 | `settings-preload.js` | display + hotkeys |

Overlay bounds come from `config/settings.json` (`window.x/y/width/height`); `null` x/y = bottom-right default. F3 toggles **position mode** (overlay becomes focusable/clickable, drag bar + resize grips, bounds saved on exit).

### Hotkeys (defaults, all configurable)
| Key | Action |
|---|---|
| F1 | toggle overlay |
| 1–6 | advance track N (direct mode) |
| Shift+1–6 | undo track N |
| `` ` `` | arm 1–6 for 5 s of inactivity (latch mode only) |
| F2 / F5 / F3 | settings / config / position mode |
| F6 / Shift+F6 | next / previous phase |

`hotkeyMode`: `'direct'` (default — 1–6 always captured system-wide, including chat) or `'latch'` (only the latch key is global; each advance/undo re-arms the 5 s timer). All registration goes through `safeRegister()`, so one invalid/taken key never blocks the others; failures are returned to the settings window.

### IPC channels
| Channel | Direction | Payload |
|---|---|---|
| `hotkey` | main → overlay | `{ action: 'toggle'\|'advance'\|'undo'\|'phase', trackIndex?, visible?, direction? }` |
| `reload-build` | main → overlay | — (re-read build.json) |
| `settings-changed` | main → overlay | full settings |
| `advance-mode` | main → overlay | `{ active }` (latch indicator) |
| `enter-/exit-position-mode` | main → overlay | — |
| `save-build` | overlay → main | full loadout (after every change) |
| `move-window` / `resize-window` / `end-position-mode` | overlay → main | position mode |
| `get-settings` / `save-settings` | invoke | settings / `{ success, failedHotkeys? }` |
| `load-loadout` / `load-build` | invoke (config) | `{ phases, loadoutName }` / `{ jsonString, buildName }` |
| `save-/list-/load-/delete-template` | invoke (config) | templates in `config/saves/` |

---

## Development

```bash
npm install
npm run dev      # Electron with --dev
npm test         # node --test tests/*.test.js
```

- Tests run against the full data file if present, else the committed sample — assertions must hold for both (the sample is a verbatim subset).
- To try the overlay without pasting a build: `cp config/build.example.json config/build.json`.
- **contextIsolation must stay ON**, nodeIntegration OFF. Never expose `ipcRenderer` directly.
- **Click-through is critical**: `setIgnoreMouseEvents(true, { forward: true })` after window creation and after leaving position mode.
- **Unresolved tracks** (no tree in the loaded data) render as "no data" and cannot be advanced — so a real build whose skills aren't in the sample needs the full data file.
- **db/data/*.json are generated** (except `classes.json`). Never hand-edit; regenerate the sample from the full file if the schema changes.
- Renderer is vanilla JS, no bundler. Shared code reaches it via `<script src="../shared/tree-utils.js">` before `app.js`.

### Regenerating the committed sample
Keep it to the 5 passive trees + the skills used by tests/examples (`fl44 fi9 es6ai v01cv vr53sl an0my sr31hu htsk5 smbmb pun22 dqv5 srk21`), rows copied verbatim, one row per line.

---

## Status

| Area | Status |
|---|---|
| Parser (multi-line paste, multi-phase loadouts) | ✅ Done |
| Data extraction (`reconcile_skill_trees.py`) | ✅ Works; data-quality issues above |
| Overlay (tracks, dots, descriptions, phases, transition panel) | ✅ Done |
| Electron shell (hotkeys, direct/latch, position mode, settings, config, templates) | ✅ Done |
| Tests (db, parser, shared logic) | ✅ Green on sample and full data |

<<<<<<< HEAD
**Phase 2 is complete.** Input is `extractor/nodes_flat.json` (flat node rows tagged with `treeID`).
`python extractor/extract.py` cleans it (drops orphan/placeholder rows, dedupes, derives `treeName`
from the root node) and writes `db/data/skill_tree_reconciled.json` + `db/data/passives.json`.
Run with `--verbose` to list `(treeID, nodeID)` collisions (stale nodes in the export).

---

## Execution Order (from project plan)

| # | Task | Estimated effort | Depends on |
|---|------|-----------------|------------|
| 1 | Il2CppDumper + AssetStudio export | 1h (manual) | Game installed | ✅ Done |
| 2 | Write extract.py | 3-4h | Task 1 | ✅ Done |
| 3 | Write maxroll.js + build-schema.js | 2h | None | 🔲 TODO |
| 4 | Electron shell (window + hotkeys) | 2h | None | 🔲 TODO |
| 5 | Overlay UI (track rendering + advance logic) | 3-4h | Tasks 3+4 | 🔲 TODO |
| 6 | Wire DB → parser → UI | 2h | Tasks 2+5 | 🔲 TODO |
| 7 | Config window (JSON paste UI) | 1h | Task 4 | 🔲 TODO |
| 8 | Test with real build + polish | 2h | All | 🔲 TODO |

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Desktop shell | Electron 28+ | Handles transparent window, global hotkeys |
| Renderer | Vanilla JS | No framework — keep renderer lightweight |
| Data | Flat JSON files | Start here; migrate to better-sqlite3 if performance needed |
| Extractor | Python 3.x | One-time script per patch, not in runtime path |

---

## Development Notes

- **No framework in renderer**: Keep overlay/app.js plain DOM manipulation for minimal overhead.
- **contextIsolation must be ON**: The preload.js uses `contextBridge` — never disable contextIsolation.
- **click-through is critical**: `setIgnoreMouseEvents(true, { forward: true })` must be set after window creation. If this breaks, the overlay will block game input.
- **Global hotkeys conflict**: If a hotkey like `1`–`6` interferes with game input, consider only registering them when overlay is visible, or use a modifier (e.g. Alt+1).
- **db/data/*.json are generated files**: Never edit them by hand. They are output of `extractor/extract.py`. Commit a sample/test version to unblock UI development before real extraction is done.
- **build.json is runtime state**: It should be in `.gitignore` (or at least not committed with real user data). A `build.example.json` can be committed for testing.

---

## Known Unknowns / Investigation Needed

1. **Hotkey conflict with game**: Keys `1`–`6` are game ability hotkeys. Strategy: only activate when overlay is visible + user is actively navigating (F1 mode). May need per-game testing.

2. **Multi-monitor position**: The overlay x/y calculation assumes a single primary screen. Multi-monitor support may need `screen.getAllDisplays()`.

3. **Node display names and descriptions**: **Resolved.** Real display names (`nodeName`) and descriptions come from individual `SkillTreeNode #*.json` MonoBehaviour files exported by AssetStudio. Run `python extractor/extract.py --nodes <path_to_node_files>` to populate both fields. The join: SkillTreeNode files are grouped by `tree.m_PathID`; each group's root node (id=0) display name matches the GDT tree name → `(treeID, nodeId)` composite key.
=======
## Known Open Issues / Decisions
1. **Duplicate nodes in data** — see above; fix in the reconciler.
2. **Direct hotkey mode captures 1–6 globally** (breaks typing digits in game chat). Latch mode exists; consider making it the default.
3. **Multi-monitor**: positioning uses `screen.getPrimaryDisplay()` only.
4. **Fonts load from Google Fonts**; offline falls back to system fonts.
5. **`extractor/extract.py` is legacy** — its outputs aren't consumed. Decide whether to delete it or fold its Global Tree Data cross-check into the reconciler.
>>>>>>> a503f72b204c3e4da2b72132de8f9f0128760329
