# LE Build Planner — Claude Code Context

## What This Project Is

A standalone **Electron desktop app** for the game **Last Epoch (LE)**. The player loads a build (Maxroll planner or in-game export codes) and follows it point by point. The main view shows **every tree at once** (the class passive tree and up to 5 skill trees), with the node to allocate **next** in each tree highlighted, what comes after it, and the full allocation path.

Design constraint that drives every UI decision: **the user is playing the game at the same time.** The window sits on a second monitor or next to a windowed game and is read in a half-second glance. That means large readable text, few colours with fixed meanings, and one-key actions. Global hotkeys let the player tick points off without leaving the game.

The app used to be a transparent click-through overlay (`overlay/`). That code is gone; the repo/package name `le-build-overlay` is kept because the user-data folder path derives from it.

---

## Directory Structure

```
le-build-overlay/
├── electron/
│   ├── main.js        ← window, IPC handlers, lifecycle, game-data cache
│   ├── store.js       ← <userData>/build.json, settings.json, saves/ (atomic writes, migration)
│   ├── hotkeys.js     ← global shortcuts: direct / latch ("arm first"), suspend while focused, pause
│   └── preload.js     ← window.api — the ONLY renderer bridge (contextIsolation + sandbox)
├── app/                          ← renderer: vanilla JS ES modules, no framework, no bundler
│   ├── index.html                ← strict CSP; loads shared/*.js (classic) then js/main.js (module)
│   ├── js/main.js                ← state, actions (allocate/undo/setCurrent/gotoPhase), rendering, keyboard, toasts
│   ├── js/lanes.js               ← lane = identity · NEXT UP card · path strip; nodeTile(); laneAccent()
│   ├── js/inspector.js           ← node details + route list
│   ├── js/loadout-dialog.js      ← Load build (Ctrl+O): phases, live preview, templates
│   ├── js/settings-dialog.js     ← Settings (Ctrl+,): UI scale, keep on top, hotkeys (key recorder)
│   ├── js/icons.js               ← node/tree artwork via manifest, glyph fallback, UI svg icons
│   ├── js/keys.js                ← KeyboardEvent → Electron accelerator, keyRecorder()
│   ├── js/dom.js                 ← h(), mount(), svg(), richText()
│   └── styles/                   ← tokens.css, app.css (shell), lanes.css, dialogs.css
├── shared/                       ← PURE logic, UMD: require() in Node, window.* in the renderer
│   ├── tree-utils.js             ← indexNodes/makeDb, groupHistory, lookupNode, stepTrack/setTrackProgress, phase carry-over
│   └── view-model.js             ← buildLane/buildView/colorSlots: what the UI renders
├── parser/                       ← maxroll.js (paste → loadout), build-schema.js (validators)
├── db/
│   ├── build-db.js               ← loads db/data (main process + tests)
│   └── data/                     ← skill_tree_reconciled.json + passives.json (gitignored), *.sample.json (committed), classes.json
├── extractor/                    ← nodes_flat.json (input) → extract.py → db/data/
├── assets/icons/                 ← optional artwork: nodes/<treeID>/<nodeID>.png, trees/<treeID>.png, manifest.json
├── scripts/                      ← dev.js (npm run dev), build-icon-manifest.js (npm run icons)
├── config/                       ← build.example.json, maxroll-paste.example.txt (examples only)
└── tests/                        ← node:test — db, parser, tree-utils, view-model, main-process (store/hotkeys/icons)
```

---

## Data Flow

```
Load build dialog ──api.previewPhase──► main: parseBuild (live validation per phase)
                  ──api.loadLoadout───► main: parseLoadout → store.saveBuild → returns build
app/js/main.js
   ├─ api.init() → { db:{trees,classes}, build, settings, defaultSettings, icons, failedHotkeys, dataSource }
   ├─ ViewModel.buildView(build, db) → lanes[] (steps with done/current/upcoming, now, next, colorSlot)
   ├─ actions → TreeUtils.stepTrack / setTrackProgress / applyCarryOver → commit() → api.saveBuild
   └─ api.onHotkey(): global keys → { action: 'advance'|'undo'|'phase'|'latch' }
```

**Rules**
- Logic needed by more than one side (main, renderer, tests) goes in `shared/`. It must stay pure: no `fs`, no DOM, no Electron. Never re-implement grouping/lookup/stepping in `app/`.
- The renderer never touches the filesystem. Everything goes through `window.api` (preload), and every invoke resolves to `{ ok: true, ... }` or `{ ok: false, error }`.
- `commit(next, { lanes })` is the single path for build changes: it persists, rebuilds the view, and re-renders only the listed lanes (keeps strip scroll positions).
- Render via `h()`/`mount()` only (textContent, never innerHTML with data). CSP forbids inline scripts/styles; set styles through the CSSOM (`h(..., { style: {...} })`).

---

## Key Domain Concepts

### Tracks → lanes
- **Passive track**: the class passive tree (exactly 1 per phase). **Skill tracks**: one per skill (up to 5).
- Each track: flat `history[]` (ordered node ids, one entry per point) + `currentStep`.
- Lane `hotkey` = position + 1. Lane **colour** = `colorSlot` (passive 0, skills 1–5 by first appearance across *all* phases), so a skill keeps its colour when phases reorder or drop skills.

### currentStep is a FLAT point count
`0` = nothing allocated, `history.length` = complete. One press = one point. **Not** a group index.

### Steps (grouped history, derived, never stored)
`groupHistory([6,6,6,4,4])` → `[{nodeId:6,count:3,startIdx:0},{nodeId:4,count:2,startIdx:3}]`.
View-model step states: `done` / `current` (the NEXT UP step, may be partly allocated) / `upcoming`. `nodeTotalAfter` = points in that node once the step is done (a node can appear in several steps).

### Skill keys = treeIDs
Maxroll `skillTrees` keys are the game's `treeID` verbatim (`es6ai` = Erasing Strike, `fl44` = Flay). No mapping table.

### Mastery IDs are per-class relative (1–3)
`classes.json → masteriesByClass[classId][masteryId]` (Sentinel 2 = Void Knight).

### Phases
A loadout has 1–5 phases, all with the same class and mastery. `gotoPhase`: `applyCarryOver` sets each target track to `min(fromProgress, commonPrefixLength(histories))`, and `computeTransition` lists points to unspec and skills to remove. That list is shown as a banner until the user dismisses it. Phase switches, loads and *Start from here* offer an Undo toast.

---

## Data Formats

### Raw Maxroll paste
One JSON object per line (passives/class/mastery line + one line per skill); `mergeRawLines` merges them. A single combined object also works. See `config/maxroll-paste.example.txt`.

### <userData>/build.json — multi-phase loadout
```json
{ "name": "Void Knight Erasing Strike", "classId": 3, "masteryId": 2, "currentPhase": 0,
  "phases": [ { "name": "Leveling", "tracks": [
    { "type": "passive", "label": "Sentinel — Void Knight Passives", "history": [0,0,1], "totalSteps": 3, "currentStep": 0 },
    { "type": "skill", "skillKey": "v01cv", "label": "Void Cleave", "history": [2,2,4], "totalSteps": 3, "currentStep": 0 } ] } ] }
```
Legacy single-phase `{ name, classId, masteryId, tracks }` is wrapped by `normalizeBuild()`. `label` is baked at import time; the UI prefers live DB names (view-model titles).

### <userData>/settings.json
`{ window:{x,y,width,height,maximized}, display:{uiScale,alwaysOnTop}, hotkeys:{enabled,hotkeyMode,latchKey,advanceModifier,undoModifier,toggle,phaseNextKey,phasePrevKey} }`. It's always read through `mergeSettings()` (defaults + validation; unknown keys dropped).

### db/data/skill_tree_reconciled.json + passives.json — flat node rows
```json
{ "treeID": "fl44", "treeName": "Flay", "nodeID": 14, "nodeName": "Go For The Throat",
  "description": "Flay has additional critical strike chance…", "maxPoints": 3,
  "stats": [{"statName": "Critical Strike Chance", "value": "+2%"}] }
```
`passives.json` holds the 5 class passive trees (`ac-1 mg-1 kn-1 rg-1 pr-1`, `treeName` = class name). Loaders put passive rows first, then index with `makeDb()`:
```js
{ passives: trees, skills: trees /* same object */, classes, duplicates }
trees = { [treeID]: { name, nodes: { [String(nodeID)]: { id, nodeName, description, maxPoints, stats } } } }
```
The committed `skill_tree_reconciled.sample.json` contains both passive rows and 12 skill trees, copied unchanged from the extractor output. It's the fallback for fresh clones/tests.

### classes.json (hand-maintained)
`{ classes:{"3":"Sentinel"}, masteriesByClass:{"3":{"1":"Forge Guard","2":"Void Knight","3":"Paladin"}}, passiveTreeByClass:{"3":"kn-1"} }`

### Icons — assets/icons/manifest.json
`{ nodes: { "es6ai/12": "nodes/es6ai/12.png" }, trees: { "es6ai": "trees/es6ai.png" } }`, generated by `npm run icons`. The UI loads only files that are listed; anything missing or broken falls back to a glyph (initials, hue from a hash that skips the green band).

### Data pipeline — `python extractor/extract.py [--verbose]`
Cleans `extractor/nodes_flat.json` → `db/data/skill_tree_reconciled.json` + `passives.json`. It drops orphan and placeholder rows, merges duplicates, and derives `treeName` from the root node (or from `TREE_NAME_OVERRIDES`).

### Known data-quality issues
- **~86 `(treeID, nodeID)` collisions** in `nodes_flat.json`: stale nodes from older tree versions exported next to live ones (e.g. `es6ai` 12 = "Rythm of the Void" *and* "Void Lens"). `extract.py` keeps the first named row, **which may be the stale one**. The fix is upstream: export only nodes referenced by the live tree. Don't write tests that assert names of collided nodes.

---

## Electron Architecture

- **One window**: normal frame, resizable (min 420×480), `sandbox`, `contextIsolation`, no `nodeIntegration`, no app menu, navigation and `window.open` blocked. Bounds, maximized state, zoom (UI scale) and always-on-top persist. Saved bounds are only reused if they're still on a connected display.
- **Single instance**: a second launch focuses the existing window.
- **userData**: `app.getPath('userData')`, overridable with env `LE_USER_DATA` (tests/screenshots). Old `config/build.json`, the hotkeys from `config/settings.json`, and `config/saves/` are migrated once.
- **Game data** is loaded once and cached in main; `app:init` refreshes it (so a window reload picks up re-extracted data).

### Hotkeys (`electron/hotkeys.js`)
| Default | Action | While the app window is focused |
|---|---|---|
| `1`–`6` / `Shift`+`1`–`6` | allocate / undo (direct mode) | **released** (the app handles keys itself; typing works) |
| `` ` `` | arm `1`–`6` for 5 s, re-armed by each use (latch mode) | **released** |
| `F1` | show / hide window (`showInactive`, never steals focus) | active |
| `F6` / `Shift`+`F6` | next / previous phase | active |

`safeRegister()` never throws. Failures are returned to Settings and shown in the status bar. `pause(true)` releases everything while the Settings key recorder is listening.

### IPC (`window.api` → main, all `invoke`)
`init`, `saveBuild`, `previewPhase(json)`, `loadLoadout(phases, name)`, `loadExample`, `saveSettings`, `pauseHotkeys(bool)`, `listTemplates`, `saveTemplate`, `loadTemplate`, `deleteTemplate`. Main → renderer: `hotkey` events via `onHotkey(cb)`.

### In-app keyboard (renderer, ignored while typing or a dialog is open)
`1`–`6` / `Shift`+`1`–`6`, `↑↓` focus tree, `←→` browse steps (pins inspector), `Enter`/`Space` allocate focused tree, `Backspace` undo, `Esc` unpin / dismiss banner, `PgUp`/`PgDn` phase, `Ctrl+O` load, `Ctrl+,` settings, `Ctrl+=/-/0` UI scale.

### Responsive layout
- ≥1180 px: lanes plus an inspector column.
- <1180 px: the inspector becomes a drawer, opened by clicking a node.
- Lane container <780 px: the path strip is hidden (identity + NEXT UP only), so all trees still fit.
- <560 px: lanes stack into a single column.

---

## Development

```bash
npm install
npm start / npm run dev     # dev opens detached DevTools
npm test                    # node --test tests/*.test.js
npm run icons               # rebuild assets/icons/manifest.json
python extractor/extract.py # regenerate db/data from extractor/nodes_flat.json
```

- Tests run against the full data if present, otherwise the sample. Assertions must hold for both.
- UI changes must be checked in the real app at several window sizes (e.g. 1920, 1440, 1100, 760, 460 px wide). Run it under `xvfb-run` with `LE_USER_DATA` pointing at a temp dir, and drive it via `webContents.executeJavaScript` / `sendInputEvent` + `capturePage`.
- Regenerating the committed sample: all rows of `passives.json` + the skill trees `fl44 fi9 es6ai v01cv vr53sl an0my sr31hu htsk5 smbmb pun22 dqv5 srk21` from `skill_tree_reconciled.json`, copied unchanged, one row per line.

## Known Open Issues / Decisions
1. **Duplicate nodes in data**: see above; needs an upstream exporter fix.
2. **Direct hotkey mode is the default** and captures `1`–`6` system-wide while the game has focus (game chat digits). *Arm first* avoids that; consider making it the default.
3. **No installer/packaging yet** (electron-builder etc.). Paths are already packaging-safe (userData for state, read-only app dir).
4. **No real node icons yet**. The glyph placeholders are designed to be replaced via `assets/icons/`.
