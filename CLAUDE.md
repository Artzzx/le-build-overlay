# LE Build Overlay — Claude Code Context

## What This Project Is

A transparent, always-on-top **Electron overlay** for the game **Last Epoch (LE)** that displays a player's build progression plan (from Maxroll planner) and lets them advance step-by-step using keyboard hotkeys while playing. Think of it as a "co-pilot" for allocating passive and skill tree points in the correct order.

The overlay sits over the game window, is click-through (so it never interferes with gameplay), and responds exclusively to global hotkeys registered via Electron's `globalShortcut`.

---

## Directory Structure

```
le-build-overlay/
├── CLAUDE.md                 ← YOU ARE HERE — full project context
├── package.json
├── electron/
│   ├── main.js               ← Electron main process, window management, hotkeys
│   └── preload.js            ← Secure IPC bridge (contextBridge)
├── overlay/
│   ├── index.html            ← Transparent overlay UI (loaded in renderer)
│   ├── style.css             ← Dark metallic theme matching LE's UI palette
│   └── app.js                ← Renderer logic: track state, rendering, IPC events
├── parser/
│   ├── maxroll.js            ← Parse raw Maxroll planner JSON → normalized build
│   └── build-schema.js       ← Zod-style schema + JS validation for build format
├── db/
│   ├── build-db.js           ← Load and query db/data/*.json files
│   └── data/                 ← Game data extracted per-patch (see extractor/)
│       ├── skill_tree_reconciled.json  ← flat node array, the ONLY file runtime reads
│       ├── classes.json                ← classId/masteryId → names
│       └── items.json                  ← (future) item/affix data
├── extractor/
│   └── extract.py            ← Regenerate db/data/ from game assets (run after patches)
├── config/
│   └── build.json            ← User's active build (written by parser, read by overlay)
└── scripts/
    └── dev.js                ← Dev launcher (opens Electron with DevTools)
```

---

## Core Data Flow

```
[User pastes Maxroll JSON]
         │
         ▼
  parser/maxroll.js           ← validates + normalizes raw Maxroll format
         │
         ▼
  config/build.json           ← persisted normalized build (currentStep per track)
         │
         ▼
  db/build-db.js              ← resolves nodeIds → human-readable data
    + db/data/*.json
         │
         ▼
  overlay/app.js              ← renders the UI, handles hotkey IPC events
         │
         ▼
  overlay/index.html          ← transparent window on top of game
```

---

## Key Domain Concepts

### Tracks
A "track" represents one progression tree the player is following:
- **Passive track**: the big shared passive tree (1 per build)
- **Skill tracks**: each equipped skill has its own tree (up to 5 per build)

Each track has a `history[]` (ordered allocation steps) and a `currentStep` pointer.

### History Array
The `history` array from Maxroll is a flat array of `nodeId` integers:
```
[6, 6, 6, 6, 6, 4, 4, 4, 1, 1, 1, ...]
```
- Each integer is a node ID in the tree
- Consecutive same IDs mean "allocate N points to this node"
- The order is the exact recommended allocation sequence

### Grouped Steps
For UI display, the flat history is grouped into allocation steps:
```js
// [6,6,6,6,6,4,4,4] → [{nodeId:6,count:5,startIdx:0},{nodeId:4,count:3,startIdx:5}]
function groupHistory(history) {
  const groups = [];
  let i = 0;
  while (i < history.length) {
    const nodeId = history[i];
    let count = 0;
    while (i < history.length && history[i] === nodeId) { count++; i++ }
    groups.push({ nodeId, count, startIdx: i - count });
  }
  return groups;
}
```
Each group = one UI "step" the player advances through.

### Skill Keys (es6ai, v01cv, etc.)
Maxroll's skill keys are the `treeID` field from "Global Tree Data.json" verbatim.
No mapping or lookup table is needed — they are the same string.
Examples: `"es6ai"` = Erasing Strike, `"v01cv"` = Void Cleave, `"vr53sl"` = Volatile Reversal.
`skill_tree_reconciled.json` rows are tagged with `treeID` directly.

### Node Display Names vs Internal Names
- `nodeName` — real player-facing display name from SkillTreeNode MonoBehaviour export.
  Populated by running `python extractor/extract.py --nodes <path>`. Falls back to internal name when not run.
- `description` — in-game tooltip text. Empty string when `--nodes` not used.

`extract.py` matches node files to tree IDs by grouping `SkillTreeNode #*.json` files by `tree.m_PathID`,
then matching each group's root node (id=0) display name to a GDT tree name (~68% coverage).
See README.md → Reconciliation for the active work to close that gap.

---

## Input/Output Formats

### Raw Maxroll JSON (user pastes this)
```json
{
  "passives": {
    "history": [1,1,1,1,1,6,6,6,6,6],
    "position": 113
  },
  "class": 3,
  "mastery": 2,
  "skillTrees": {
    "fl44": {"history": [4,4,14,11,12], "position": 26},
    "fl22": {"history": [3,3,7], "position": 20}
  }
}
```

### Normalized Build (config/build.json)
```json
{
  "name": "Void Knight Erasing Strike",
  "classId": 3,
  "masteryId": 2,
  "tracks": [
    {
      "type": "passive",
      "label": "Passives",
      "history": [1,1,1,1,1,6,6,6,6,6],
      "totalSteps": 113,
      "currentStep": 0
    },
    {
      "type": "skill",
      "skillKey": "fl44",
      "label": "Erasing Strike",
      "history": [4,4,14,11,12],
      "totalSteps": 26,
      "currentStep": 0
    }
  ]
}
```

### passives.json (db/data/)

Keyed by `treeID` (one per base class). Lookup requires classId → treeID first.
```json
{
  "kn-1": {
    "name": "Knight",
    "nodes": {
      "49": {
        "id": 49,
        "nodeName": "Vitality and Health",
        "name": "Knight Vitality And Health",
        "description": "Gain Vitality and Health...",
        "maxPoints": 8,
        "requiredMastery": 0,
        "masteryRequirement": 0,
        "requirements": []
      }
    }
  }
}
```

classId → treeID mapping (in classes.json `passiveTreeByClass`):
- 1 (Acolyte) → "ac-1", 2 (Mage) → "mg-1", 3 (Sentinel) → "kn-1"
- 4 (Rogue) → "rg-1", 5 (Primalist) → "pr-1"

### skills.json (db/data/)

**Key insight: `treeID` in "Global Tree Data.json" = Maxroll's skillKey directly.**
No mapping step needed.

```json
{
  "es6ai": {
    "name": "Erasing Strike",
    "nodes": {
      "2": {
        "id": 2,
        "nodeName": "Erasing Strike",
        "name": "Erasing Strike Skill Tree Root Node",
        "description": "",
        "maxPoints": 0,
        "requiredMastery": 0,
        "masteryRequirement": 0,
        "requirements": []
      }
    }
  }
}
```

**Node field priority:**
- `nodeName` — real player-facing display name from SkillTreeNode MonoBehaviour (e.g. "Champion of the Void"). Populated by `extract.py --nodes`. Falls back to `name` when `--nodes` was not run.
- `name` — internal name from "Global Tree Data.json" (e.g. "Void Cleave Crit Multi And Mana On Crit"). Always present.
- `description` — in-game description from SkillTreeNode MonoBehaviour. Empty string when `--nodes` was not run.

The overlay renderer (`app.js`) uses `node.nodeName || node.name` for display.

### classes.json (db/data/)
```json
{
  "classes": {
    "3": "Sentinel"
  },
  "masteries": {
    "2": { "name": "Void Knight", "classId": 3 }
  }
}
```

---

## Electron Architecture

### main.js responsibilities
1. Create the transparent overlay `BrowserWindow` (right side of screen, above action bar)
2. Create a separate focusable config `BrowserWindow` (shown on F5)
3. Register global hotkeys:
   - `F1` → toggle overlay visibility
   - `1`–`6` → send `advance:N` IPC to renderer (only when overlay visible)
   - `Shift+1`–`Shift+6` → send `undo:N` IPC to renderer
   - `F5` → open/focus config window
4. Handle IPC from renderer: `save-build` (persist build.json to disk)

### Overlay BrowserWindow settings
```js
{
  width: 260,
  height: 400,
  x: screenWidth - 270,   // right edge, 10px margin
  y: screenHeight - 620,  // above typical action bar position
  transparent: true,
  frame: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  focusable: false,        // NEVER steal focus from game
  webPreferences: { preload: path.join(__dirname, 'preload.js') }
}
win.setIgnoreMouseEvents(true, { forward: true }); // full click-through
```

### preload.js responsibilities
- Expose a safe `window.electronAPI` object via `contextBridge.exposeInMainWorld`
- Methods to expose: `onHotkey(callback)`, `saveBuild(buildJson)`
- Never expose `ipcRenderer` directly (security)

### IPC channel names
| Channel | Direction | Payload |
|---------|-----------|---------|
| `hotkey` | main → renderer | `{ action: 'toggle' | 'advance' | 'undo', trackIndex?: number }` |
| `save-build` | renderer → main | Full build JSON object |

---

## Overlay UI

### Visual Layout
```
┌─────────────────────────────┐
│ [P] Juggernaut     42/113 1 │  ← expanded: shows dots + effect text
│ [S] Erasing Str    14/26  2 │  ← collapsed: one line
│ [S] Void Reversal  20/20  3 │  ← completed: dimmed
│ [S] Smite          12/18  4 │
│ [S] Shield Rush     8/20  5 │
│ [S] Anomaly         3/16  6 │
│ F1 hide · 1-6 advance       │
└─────────────────────────────┘
```
- `[P]` = passive track, `[S]` = skill track
- Numbers on the right (1-6) = hotkey to advance that track
- Progress shown as `currentStep/totalSteps`
- Expanded track shows: node name, description, point dots (●●●○○)
- Completed tracks are dimmed with ✓ prefix
- 200ms green border flash animation on advance

### CSS Design Tokens
```css
/* Match Last Epoch's dark metallic UI */
--bg: rgba(6, 8, 14, 0.85);       /* near-black with slight transparency */
--border: rgba(80, 70, 50, 0.6);  /* metallic gold border */
--gold: #c9a84c;                   /* passive node accent */
--blue: #60a5fa;                   /* skill node accent */
--text: #d0c8b0;                   /* warm off-white text */
--dim: rgba(255,255,255,0.3);      /* completed/inactive */
--flash: rgba(100, 200, 100, 0.4); /* advance flash */

/* Fonts (load from Google Fonts or bundle locally) */
--font-mono: 'Share Tech Mono', monospace;  /* numbers */
--font-label: 'Rajdhani', sans-serif;       /* labels */

/* Geometry */
--row-height: 28px;     /* collapsed track row */
--expanded-h: 80px;     /* expanded track with dots */
--radius: 3px;          /* minimal rounding — match game's angular UI */
--width: 240px;
```

---

## app.js State Model

```js
// Global state in overlay/app.js
const state = {
  build: null,         // loaded from config/build.json
  db: null,            // loaded from db/data/*.json
  expandedTrack: 0,    // index of currently expanded track row
  visible: true,       // overlay visibility
};

// Per-track derived data (recomputed on each render)
function resolveTrack(track, db) {
  const groups = groupHistory(track.history);
  const currentGroup = groups[track.currentStep] ?? null;
  const node = currentGroup ? lookupNode(currentGroup.nodeId, track, db) : null;
  const pointsInNode = track.history
    .slice(currentGroup?.startIdx ?? 0, track.currentStep)
    .length;
  return { groups, currentGroup, node, pointsInNode };
}
```

---

## Phases and What's Done

| Phase | Name | Status |
|-------|------|--------|
| 1 | Config Parser (maxroll.js) | 🔲 TODO |
| 2 | Game Asset Extraction (extract.py) | ✅ Done — `db/data/skill_tree_reconciled.json` generated (~68% name coverage) |
| 3 | Local DB Build (build-db.js) | 🔲 TODO — depends on Phase 2 |
| 4 | Overlay UI | 🔲 TODO |

**Phase 2 is complete.** `extract.py` generates `db/data/skill_tree_reconciled.json` from the game export.
Reconciliation work to improve name coverage (currently ~68%) is ongoing — see README.md.

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
