# LE Build Planner — Claude Code Context

## What This Project Is

A standalone **Electron desktop app** for the game **Last Epoch (LE)**. The player loads a build (Maxroll planner or in-game export codes) and follows it point by point. The main view shows **every tree at once** (the class passive tree and up to 5 skill trees), with the node to allocate **next** in each tree highlighted, what comes after it, and the full allocation path.

Design constraint that drives every UI decision: **the user is playing the game at the same time.** The window sits on a second monitor or next to a windowed game and is read in a half-second glance. That means large readable text, few colours with fixed meanings, and one-key actions. Global hotkeys (`F1`–`F6` by default) let the player tick points off without leaving the game.

Rules that follow from it:
- **Never take keys the game needs.** Bare digits are only used when the user picks them. Nothing global uses `Esc`, `Ctrl+Z` or letters.
- **Every global key press must be confirmable without looking**: a sound cue plus the status bar's last-action chip.
- **A held key must never repeat an action**: the repeat guard in `hotkeys.js` and the `e.repeat` check in the app.
- **A stray key in the planner must not disrupt the game**: `Esc` never leaves mini mode, and mini mode never steals focus.

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
│   ├── js/lanes.js               ← lane = identity · NEXT UP card (Allocate / Fill ×N / undo) · path strip; nodeTile(); laneAccent()
│   ├── js/mini.js                ← mini mode rows (display.mode 'compact')
│   ├── js/feedback.js            ← WebAudio sound cues for global hotkey events
│   ├── js/inspector.js           ← node details + route list
│   ├── js/loadout-dialog.js      ← Load build (Ctrl+O): phases, live preview, templates
│   ├── js/settings-dialog.js     ← Settings (Ctrl+,): UI scale, keep on top, mini opacity, sound, lane keys, hotkeys (key recorder, conflict check)
│   ├── js/icons.js               ← node/tree artwork from db/data/icons, glyph fallback, UI svg icons
│   ├── js/keys.js                ← KeyboardEvent → Electron accelerator, keyRecorder()
│   ├── js/dom.js                 ← h(), mount(), svg(), richText()
│   └── styles/                   ← tokens.css, app.css (shell), lanes.css, mini.css, dialogs.css
├── shared/                       ← PURE logic, UMD: require() in Node, window.* in the renderer
│   ├── tree-utils.js             ← indexNodes/makeDb, groupHistory, lookupNode, stepTrack/setTrackProgress, phase carry-over
│   ├── view-model.js             ← buildLane/buildView/colorSlots: what the UI renders
│   └── hotkey-scheme.js          ← lane key sets, trackAccelerators, labels, hotkeyConflicts, laneFromCode
├── parser/                       ← maxroll.js (paste → loadout), build-schema.js (validators)
├── db/
│   ├── build-db.js               ← loads db/data (main process + tests)
│   └── data/                     ← skill_tree_reconciled.json + passives.json (generated, committed), classes.json,
│                                    icons/ (node art as WebP, committed, referenced by each row's `icon`)
├── extractor/                    ← nodes_flat.json (input) → convert_icons.py + extract.py → db/data/; requirements.txt (Pillow)
├── scripts/                      ← dev.js (npm run dev)
├── config/                       ← build.example.json, maxroll-paste.example.txt (examples only)
└── tests/                        ← node:test — db, parser, tree-utils, view-model, main-process (store/hotkeys),
                                     extractor + convert-icons (run the Python scripts on fixtures), data-contract (the real data files)
```

---

## Data Flow

```
Load build dialog ──api.previewPhase──► main: parseBuild (live validation per phase)
                  ──api.loadLoadout───► main: parseLoadout → store.saveBuild → returns build
app/js/main.js
   ├─ api.init() → { db:{trees,classes}, build, settings, defaultSettings, failedHotkeys, dataSource }
   ├─ ViewModel.buildView(build, db) → lanes[] (steps with done/current/upcoming, now, next, colorSlot)
   ├─ actions → TreeUtils.stepTrack / setTrackProgress / applyCarryOver → commit() → api.saveBuild
   └─ api.onHotkey(): global keys → { action: 'advance'|'undo'|'phase'|'latch' }
```

**Rules**
- Logic needed by more than one side (main, renderer, tests) goes in `shared/`. It must stay pure: no `fs`, no DOM, no Electron. Never re-implement grouping/lookup/stepping in `app/`.
- The renderer never touches the filesystem. Everything goes through `window.api` (preload), and every invoke resolves to `{ ok: true, ... }` or `{ ok: false, error }`.
- `commit(next, { lanes })` is the single path for build changes: it persists, rebuilds the view, and re-renders only the listed lanes (keeps strip scroll positions).
- Point changes go through `allocate(i, delta, { source, fill })`. It pushes onto `undoStack` (Ctrl+Z), sets `lastAction` (the status bar chip), plays a cue when `source === 'global'`, and fires the milestone toasts (tree done; phase done → "Go to ‹next›").
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
`{ window:{x,y,width,height,maximized}, compactWindow:{x,y,width,height}, display:{uiScale,alwaysOnTop,mode,opacity,sound,volume}, hotkeys:{enabled,hotkeyMode,laneKeys,latchKey,advanceModifier,undoModifier,toggle,phaseNextKey,phasePrevKey} }`. It's always read through `mergeSettings()` (defaults + validation; unknown keys dropped).
- `display.mode` is `'full'` or `'compact'` (mini mode). Only main changes it, via `window:setMode`.
- `opacity` applies to mini mode only.
- `laneKeys` is `'fkeys'`, `'digits'` or `'numpad'`. A saved `hotkeys` block without `laneKeys` predates the setting and becomes `'digits'` (its old `F1` toggle would clash with lane 1). Fresh installs get `'fkeys'`.

### db/data/skill_tree_reconciled.json + passives.json — flat node rows
```json
{ "treeID": "fl44", "treeName": "Flay", "nodeID": 14, "nodeName": "Go For The Throat",
  "description": "Flay has additional critical strike chance…", "maxPoints": 3,
  "stats": [{"statName": "Critical Strike Chance", "value": "+2%"}], "icon": "265676.webp" }
```
`icon` is a path relative to `db/data/icons/` (checked to exist by the extractor) or `null`.
`passives.json` holds the 5 class passive trees (`ac-1 mg-1 kn-1 rg-1 pr-1`, `treeName` = class name). Loaders put passive rows first, then index with `makeDb()`:
```js
{ passives: trees, skills: trees /* same object */, classes, duplicates }
trees = { [treeID]: { name, icon, nodes: { [String(nodeID)]: { id, nodeName, description, maxPoints, stats, icon } } } }
```
Both files are committed (regenerate + commit after each patch). There is no fallback: if either is missing, `build-db.missingFiles()` reports it and the status bar shows **Game data missing**.

### classes.json (hand-maintained)
`{ classes:{"3":"Sentinel"}, masteriesByClass:{"3":{"1":"Forge Guard","2":"Void Knight","3":"Paladin"}}, passiveTreeByClass:{"3":"kn-1"} }`

### Icons — db/data/icons/ + the `icon` field
- **Source of truth is the data row**: `row.icon` is a path relative to `db/data/icons/`. The renderer loads `../db/data/icons/<icon>` (URL-encoded per segment) and never scans the folder.
- **Tree icon** = the root node's icon (`nodeID 0`, `maxPoints 0`). This applies to skill trees only; class passive trees have no root node, so their lane shows a glyph.
- **Fallback**: `icon: null`, or an image that fails to load, draws a glyph (initials, hue from a hash that skips the green band). Partial icon sets are fine.
- **Rendering**: tiles get `.has-art` (thin rim + bottom shade over the image). Visual weight follows the reading order: current (green ring) and next are full brightness, later upcoming steps are dimmed, done steps are desaturated.

### Data pipeline (per game patch)
```bash
pip install -r extractor/requirements.txt       # once (Pillow)
python extractor/convert_icons.py               # db/data/icons: PNG/JPG → 128 px WebP (~6× smaller), idempotent
python extractor/extract.py [--verbose] [--strict]
```
Commit `nodes_flat.json`, `db/data/*.json` and `db/data/icons/` together. `extract.py` warns if non-WebP icons are present; **never commit PNG icons** (git keeps every version forever).

### `extract.py`
Cleans `extractor/nodes_flat.json` → `db/data/skill_tree_reconciled.json` + `passives.json`. It drops orphan and placeholder rows, merges duplicates (keeping an icon from either copy), and derives `treeName` from the root node (or from `TREE_NAME_OVERRIDES`).

- **Icons**: each input row's `iconFile` value (`ICON_INPUT_FIELDS = ('iconFile', 'icon')`, first non-empty wins; e.g. `"265676.png"`, icons are shared between nodes) is resolved against the images in `db/data/icons/` (`--icons-dir` to override), case-insensitively. It tries, in order: the relative path, the longest tail of an absolute/Windows path (both extension-agnostic, so `es6ai/12.png` finds `es6ai/12.webp` after conversion), the file name, then the file name without extension. Rows without a value fall back to `<treeID>/<nodeID>.<ext>`. A bare name that exists in several folders is ambiguous and is never guessed. Unresolved values become `null` and are reported (`--verbose` lists them); `--strict` makes them fail the run. Input fields that look icon-related (`/icon|sprite/i`) but aren't in `ICON_INPUT_FIELDS` trigger a warning, since that's the usual cause of "0 icons".
- **Output contract**: `validate_output()` checks the exact field set, types, unique `(treeID, nodeID)`, all 5 passive trees present, no passive rows in the skill file, and that icon files exist. On any violation it writes **nothing** and exits 1. `tests/data-contract.test.js` checks the same things from the app's side.

### Known data-quality issues
- **~86 `(treeID, nodeID)` collisions** in `nodes_flat.json`: stale nodes from older tree versions exported next to live ones (e.g. `es6ai` 12 = "Rythm of the Void" *and* "Void Lens"). `extract.py` keeps the first named row, **which may be the stale one**. The fix is upstream: export only nodes referenced by the live tree. Don't write tests that assert names of collided nodes.

---

## Electron Architecture

- **One window**: normal frame, resizable (min 420×480), `sandbox`, `contextIsolation`, no `nodeIntegration`, no app menu, navigation and `window.open` blocked. Bounds, maximized state, zoom (UI scale) and always-on-top persist. Saved bounds are only reused if they're still on a connected display.
- **Mini mode** (`window:setMode`) is the same window: bounds are saved into the outgoing mode's slot and the incoming slot is restored (first use goes to the top-right of the display). It has min 260×180, is always on top, and uses `setOpacity(display.opacity)`, which does nothing on Linux. The frame stays native, because Electron can't switch frames at runtime.
- **Single instance**: a second launch focuses the existing window.
- **userData**: `app.getPath('userData')`, overridable with env `LE_USER_DATA` (tests/screenshots). Old `config/build.json`, the hotkeys from `config/settings.json`, and `config/saves/` are migrated once.
- **Game data** is loaded once and cached in main; `app:init` refreshes it (so a window reload picks up re-extracted data).

### Hotkeys (`electron/hotkeys.js`)
| Default | Action | While the app window is focused |
|---|---|---|
| `F1`–`F6` / `Shift`+`F1`–`F6` | allocate / undo (direct mode; lane keys from `shared/hotkey-scheme.js`) | **released** (the app handles keys itself; typing works) |
| `` ` `` | arm the lane keys for 5 s, re-armed by each use (latch mode) | **released** |
| `F8` | show / hide window (`showInactive`, never steals focus) | active |
| `F9` / `Shift`+`F9` | next / previous phase (`F7` left free as a buffer) | active |

- `safeRegister()` never throws. Failures are returned to Settings and shown in the status bar.
- `pause(true)` releases everything while the Settings key recorder is listening.
- Every handler goes through `repeatGuard()`. OS auto-repeat re-fires global shortcuts, so an event within `REPEAT_GUARD_MS` (110 ms) of the same accelerator's previous event is dropped. A held key yields at most 2 events (the press plus the first repeat after the OS delay); taps count normally.
- The Settings dialog refuses to save when `hotkeyConflicts()` finds a clash.

### IPC (`window.api` → main, all `invoke`)
`init`, `saveBuild`, `previewPhase(json)`, `loadLoadout(phases, name)`, `loadExample`, `saveSettings`, `pauseHotkeys(bool)`, `listTemplates`, `saveTemplate`, `loadTemplate`, `deleteTemplate`. Main → renderer: `hotkey` events via `onHotkey(cb)`.

### In-app keyboard (renderer, ignored while typing or a dialog is open)
- Lanes: `1`–`6` and the configured lane keys (`F1`–`F6` / numpad), `Shift` = undo. `Ctrl`+`1`–`6` / `Ctrl+Enter` fill the step.
- Navigation: `↑↓` focus a tree, `←→` browse steps (pins the inspector), `Enter`/`Space` allocate in the focused tree, `Backspace` undo.
- `Ctrl+Z` undoes the last change in any tree (phase-scoped stack, capped at 50).
- `Esc` unpins the inspector or dismisses the banner. It never leaves mini mode.
- Everything else: `PgUp`/`PgDn` phase, `Ctrl+M` mini mode, `?` shortcut sheet (also `F1` when F-keys aren't the lane keys), `Ctrl+O` load, `Ctrl+,` settings, `Ctrl+=/-/0` UI scale.
- Toasts: an identical message refreshes the existing toast instead of stacking another. Toasts with an action (Undo, "Go to Endgame") are evicted last.

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
python extractor/convert_icons.py && python extractor/extract.py   # regenerate db/data (see Data pipeline)
```

- Tests run against the committed game data. The Python-backed tests skip themselves when python3 / Pillow are missing.
- UI changes must be checked in the real app at several window sizes (e.g. 1920, 1440, 1100, 760, 460 px wide). Run it under `xvfb-run` with `LE_USER_DATA` pointing at a temp dir, and drive it via `webContents.executeJavaScript` / `sendInputEvent` + `capturePage`.
- `.gitignore` policy: game data we produce is committed (`nodes_flat.json`, `db/data/**`); raw game dumps, runtime state, build output and tooling noise are ignored.

## Known Open Issues / Decisions
1. **Duplicate nodes in data**: see above; needs an upstream exporter fix.
2. **Global keys swallow the key for every app** (Windows `RegisterHotKey`). The lane keys therefore default to `F1`–`F6`. Users migrated from older settings stay on digits until they switch. The repeat guard and the sounds are defensive against Windows behaviour that can't be exercised in Linux CI: check them by hand on Windows after changes to `hotkeys.js`.
3. **No installer/packaging yet** (electron-builder etc.). Paths are already packaging-safe (userData for state, read-only app dir).
4. **Committed `nodes_flat.json` predates `iconFile`**: the 1,027 icons are committed, but the committed export doesn't have `iconFile` yet, so the committed outputs have `icon: null`. Commit the new `nodes_flat.json` together with the regenerated `db/data/*.json`.
