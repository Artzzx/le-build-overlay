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
│   ├── main.js        ← window, IPC handlers, lifecycle, game-data cache, game-data version check
│   ├── updater.js     ← app updates: installer (electron-updater) / portable (GitHub API) / off
│   ├── store.js       ← <userData>/profiles/<id>.json, settings.json, saves/ (atomic writes, build.json → profile migration)
│   ├── hotkeys.js     ← global shortcuts: direct / latch ("arm first"), suspend while focused, pause
│   ├── maxroll.js     ← fetch a Maxroll planner by id (net.fetch → hidden-window fallback; LE_MAXROLL_FIXTURES for tests)
│   └── preload.js     ← window.api — the ONLY renderer bridge (contextIsolation + sandbox)
├── app/                          ← renderer: vanilla JS ES modules, no framework, no bundler
│   ├── index.html                ← strict CSP; loads shared/*.js (classic) then js/main.js (module)
│   ├── js/main.js                ← state, actions (allocate/undo/setCurrent/gotoPhase), rendering, keyboard, toasts
│   ├── js/lanes.js               ← lane = identity · NEXT UP card (Allocate / Fill ×N / undo) · path strip; nodeTile(); laneAccent()
│   ├── js/mini.js                ← mini mode rows (display.mode 'compact')
│   ├── js/feedback.js            ← WebAudio sound cues for global hotkey events
│   ├── js/inspector.js           ← node details + route list
│   ├── js/loadout-dialog.js      ← Load build (Ctrl+O): choose screen (Maxroll link | export codes | templates) → Maxroll / phases workspaces (mix guides + codes)
│   ├── js/settings-dialog.js     ← Settings (Ctrl+,): UI scale, keep on top, mini opacity, sound, lane keys, hotkeys (key recorder, conflict check)
│   ├── js/help-dialog.js         ← shortcut sheet (?), built from the current key settings
│   ├── js/profile-menu.js        ← character menu (top bar name): switch / new / rename / delete / check guide
│   ├── js/update-dialog.js       ← "Guide updated" review: diff per phase, Apply (keeps progress) / Keep mine
│   ├── js/toast.js               ← createToaster(): dedupe identical messages, max 3, action toasts evicted last
│   ├── js/icons.js               ← node/tree artwork from db/data/icons, glyph fallback, UI svg icons
│   ├── js/keys.js                ← KeyboardEvent → Electron accelerator, keyRecorder()
│   ├── js/dom.js                 ← h(), mount(), svg(), richText()
│   └── styles/                   ← tokens.css, app.css (shell), lanes.css, mini.css, dialogs.css
├── shared/                       ← PURE logic, UMD: require() in Node, window.* in the renderer
│   ├── tree-utils.js             ← indexNodes/makeDb, groupHistory, lookupNode, stepTrack/setTrackProgress, passiveFit,
│   │                               character state + switchPhase/rebaseTrack/slotsAt, diffLoadout/mergeProgress (guide updates)
│   ├── view-model.js             ← buildLane/buildView/colorSlots: what the UI renders
│   ├── hotkey-scheme.js          ← lane key sets, trackAccelerators, labels, hotkeyConflicts, laneFromCode
│   └── maxroll-import.js         ← parseMaxrollLink, decodePlanner (variants → Export-shaped builds), matchSkillTree, mapPhasesToVariants,
│                                   per-phase sources: guideSources/makeSource/mapGuidePhases/guideSignature (also loaded in the renderer)
├── parser/                       ← maxroll.js (paste → loadout), build-schema.js (validators)
├── db/
│   ├── build-db.js               ← loads db/data (main process + tests)
│   └── data/                     ← skill_tree_reconciled.json + passives.json (generated, committed), classes.json,
│                                    icons/ (node art as WebP, committed, referenced by each row's `icon`)
├── extractor/                    ← nodes_flat.json (input) → convert_icons.py + extract.py → db/data/; requirements.txt (Pillow)
├── scripts/                      ← dev.js (npm run dev), update-data.js (npm run data: convert → extract → test)
├── build/                        ← icon.png (app icon, electron-builder buildResources)
├── .github/workflows/            ← test.yml (every push, Linux + Windows), release.yml (tag v* → Windows build → GitHub Release)
├── config/                       ← build.example.json ("Try the example build"); anything else in config/ is git-ignored
├── docs/                         ← screenshot.webp (README), ROADMAP.md (planned work, not built yet)
└── tests/                        ← node:test — db, parser, tree-utils, view-model, main-process (store/hotkeys),
                                     extractor + convert-icons (run the Python scripts on fixtures), data-contract (the real data files)
```

---

## Data Flow

```
Load build dialog ──api.previewPhase──► main: parseBuild (live validation per phase)
                  ──api.loadLoadout───► main: parseLoadout → active or new profile → returns { build, profiles, activeProfile }
app/js/main.js
   ├─ api.init() → { db:{trees,classes}, build, profiles, activeProfile, settings, defaultSettings, failedHotkeys, missingData }
   ├─ ViewModel.buildView(build, db) → lanes[] (steps with done/current/upcoming, now, next, colorSlot)
   ├─ actions → TreeUtils.stepTrack / setTrackProgress / switchPhase → commit() → api.saveBuild
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

### Class ids are the game's enum; mastery ids are per class (1–3), 0 = no mastery yet
- **Class ids**: 0 Primalist, 1 Mage, 2 Sentinel, 3 Acolyte, 4 Rogue. Maxroll uses the game's enum, so it's not alphabetical and 0 is a real class. Never test class ids for truthiness.
  - Proven by the planners in `tests/fixtures`: each build's passive history fits **only** its own class's tree (`passiveFit()`).
  - An earlier table numbered them 1–5 alphabetically. Rogue happened to be 4 in both, which hid the bug until a Sentinel and a Mage planner were imported.
- **Masteries** follow the in-game order (Sentinel: 1 Void Knight, 2 Forge Guard, 3 Paladin …). Lookup: `classes.json → masteriesByClass[classId][masteryId]`.
  - Proven: Rogue 1 = Bladedancer, 2 = Marksman; Mage 2 = Spellblade; Sentinel 3 = Paladin.
  - `unverifiedMasteries` lists the `class:mastery` pairs never seen in a real export.
- **Mastery `0`** is the plain class, used while leveling before the mastery quest. Labels are just the class name ("Rogue").
- **Safety net**: `summarizeBuild()` reports `passiveMismatch` when a passive history doesn't fit its class's tree, and the Load build dialog shows it. `tests/data-contract.test.js` runs the same check on every planner fixture. **Add a fixture for each new class/mastery you import.**

### Phases and the character state
A loadout has 1–6 phases (`MAX_PHASES` in `loadout-dialog.js`), all with the same **class**. Each phase has its own `masteryId` (e.g. Leveling = 0, Endgame = Bladedancer), and `loadout.masteryId` = the highest one. Maxroll phases also carry `level` (the character level the variant is planned for).

**The character state** (`build.held`, `build.mastery`) is what the character has in game, whatever the phase:
- `held` = `{ passive: {node: points}, [skillKey]: {…} }`, including skills the current phase doesn't use but that are still specialized.
- `mastery` = the chosen mastery (0 = none yet).
- `setTrackProgress`/`stepTrack` keep it in step on every allocate or undo.
- Builds without it get it from their current phase (`ensureHeld`, run by `normalizeBuild`). A fresh load has mastery 0.

**Entering a phase** (`switchPhase` → `enterPhase` in `shared/tree-utils.js`) compares what's held with the new routes, **per node, never by order**; the game only cares how many points a node has. `rebaseTrack` moves the held points to the front of the route (guide order kept in `track.guide`), so progress stays a flat prefix and the rest of the app is unchanged.
- **Nothing changes until the player confirms.** A forward switch (or a guide update) stores its instructions as `build.pending` and leaves `held`/`mastery` alone. **Done** runs `applyPending()`, which takes the points off (never below what the current phase counts as allocated), drops despecialized skills and sets the mastery. **×** dismisses without changing anything. A backward switch keeps the pending instructions, so a misclicked switch loses nothing. A forward switch *from the phase the instructions were for* applies them first: the player played that phase, so they did them, even without pressing Done. Otherwise, e.g. after a misclick forward and back, the new instructions are recomputed from the unchanged state and replace the old ones. The banner is `build.pending`, so it survives phase switches, profile switches and restarts. Allocating and `Esc` never close it.
- **Forward**:
  - **Respec**: only points a route doesn't want at all, **node by node** (`nodes: [{ nodeId, remove, from, to }]`) in a safe order: the reverse of the order they were taken in the phase being left (`removalOrder`), since a node taken later can depend on an earlier one.
  - **Skills** the phase doesn't use: keep them specialized when a slot is free and they come back later. Slots unlock at levels 4, 8, 20, 35 and 50 (`slotsAt(phase.level)`; 5 when the level is unknown). Otherwise despecialize: all points lost, and the skill comes back from 0. Skills never used again are also despecialized.
  - **Mastery**: "choose" (from 0) or "change" when the phase's mastery differs from `build.mastery`.
  - The state assumes the player does it.
- **Backward**: nothing to do in game, and the state is untouched, so going forward again loses nothing.
- The banner ("Switching to …") groups Respec (numbered node chips: icon, name, −N, from → to/max) / Skills / Mastery. It notes when the player is in another phase than the instructions are for.
- A switch's Undo restores the whole build, but only while nothing has changed since; an older toast can't restore a stale build.

Proven on the three fixtures (`tests/maxroll-import.test.js`): the old prefix rule asked the Rogue build to unspec 15 of 20 passives it still needed. Phase switches, loads and *Start from here* offer an Undo toast.

---

## Data Formats

### Maxroll planner import (link → phases)
- **Endpoint** (undocumented, public): `GET https://planners.maxroll.gg/profiles/le/<id>` → `{ id, name, game:'le', user:{username}, data:"<JSON string>" }`, with `data` = `{ profiles:[variant…], activeProfile }`. A real response is committed as `tests/fixtures/maxroll-profile-le.json`.
- **Variant**: `{ name, class, mastery, level, hidden?, passives:{history,position}, skillTrees:{<treeID>:{history,position}}, specializedSkills:[ability names] }`.
- **Traps** handled by `decodePlanner()`:
  - `skillTrees` keeps every tree ever touched (stale Falconer trees in a Bladedancer planner). The build's skills are `specializedSkills`, which are ability names (`"Bladestorm Throw"`, `"Umbral Blades 1"`, `"ShadowRend"`), matched to the variant's trees by `matchSkillTree()` (normalized name, exact then prefix).
  - `position` is the planner cursor: `history.slice(0, position)`.
- **Links**: `maxroll.gg/last-epoch/planner/<id>`, with `#N` = the N-th *visible* variant (1-based), which pre-selects only that variant. The API URL or a bare id also works.
- **Flow**:
  1. `api.fetchMaxroll(link)` → main `maxroll:fetch` → `electron/maxroll.js`.
     - It uses `net.fetch` with an identifying User-Agent, a 10 s timeout, 1 retry and a 10 min cache.
     - A non-JSON answer (bot check) falls back to a hidden sandboxed window.
     - `public:false` still imports, since it only means unlisted.
  2. Each variant is summarized with `summarizeBuild()`, the same helper as `build:preview`.
  3. **The Load build dialog** (`loadout-dialog.js`, one wide fixed-size modal, three views that keep their state while it's open):
     - **Choose**: two cards (`1` Maxroll link, `2` export codes), saved templates, and "re-import the current build".
       - A Maxroll link on the clipboard adds a one-click **Fetch this build**.
     - **Maxroll workspace**: variant rail (tick up to 6) plus a pane for the focused variant (stats, skill cards with tree icons, phase name).
       - Load uses the ticked variants' `json` directly.
       - **Add another guide or codes** (rail) / "Edit the chosen variants as codes" (pane) move them into the phases workspace, each phase keeping its **origin** (`{ maxroll, variant, name }`).
     - **Phases workspace** (`view === 'codes'`): phase rail (guide chip or "codes"), codes editor, live preview.
       - The editor head has move earlier / later / remove for the selected phase (`Alt+↑/↓`). The rail stays text-only so long variant names stay readable.
       - **Codes** adds an empty phase. **Maxroll link** opens the Maxroll view in *adding* mode (`mx.adding`): no pre-ticked variants, the tick limit is what's left of the 6 phases, the class must match the phases already there, the footer reads "Add N phases", and Back / `Alt+←` returns to the phases. The chosen variants are appended after the filled phases (empty ones dropped).
       - Editing a phase's codes clears its origin (it's no longer the guide's variant); other phases keep theirs.
     - **Keys**: `Ctrl+Enter` loads and `Alt+←` goes back. Shortcuts listen on the document while the dialog is open, and re-renders restore focus.
  4. Loadouts from Maxroll carry `source`, **per phase**: `{ maxroll, date, dates: { [id]: date }, phases: [{ maxroll, variant, name } | null] }`.
     - Each entry is the planner and variant (index + name at import) that phase came from; `null` = pasted codes. So one build can mix a leveling guide, an endgame guide and codes.
     - `maxroll` / `date` are the first planner's, so `source.maxroll` still means "from Maxroll".
     - Older sources (`{ maxroll, date, phases?: [{ variant, name }] }`, one planner) read the same through `MaxrollImport.guideSources()`.
     - `makeSource()` writes the stored shape; main's `cleanSource()` is `makeSource(guideSources(...))`, so anything invalid reads as codes.
- Requests happen only on the user's click (a clipboard link is only pre-filled), **except** the guide-update check below: once a day at start, for Maxroll builds, and it can be turned off in Settings. Export paste stays the fallback for every error, and errors can offer **Open in browser**.

### Guide updates (Maxroll builds)
Guides get edited every patch; re-importing used to reset progress.
- **Check** (`maxroll:checkUpdate` → `checkGuideUpdate()` in main): fetches **every planner** the phases came from. Every date equal to the stored one means up to date, with no diffing.
  - Otherwise `mapGuidePhases()` pairs each phase with a variant **in its own planner** (`mapPhasesToVariants`): stored name first (reordered), then stored index (renamed), then, for builds imported before the map existed, the phase's own name. A phase whose variant is gone stays as is and is listed as `missing`. Codes phases are never touched.
  - The update lists only the planners saved since (`update.planners`). *Keep my version* stores `update.signature` (`guideSignature()`: one planner = its date, as before; several = `id@date …`).
  - The matched variants are parsed, and `diffLoadout()` lists what changed per phase: trees added / removed, routes changed (`common` prefix), mastery. A new date with no real change just updates `source.date` quietly.
- **Automatic** checks run at start and after a profile switch: at most once a day per character (`profile.updateCheck.at`), off with `settings.updates.checkMaxroll`, and silent unless there's an update (a toast with **Review**). A version dismissed with *Keep my version* (`updateCheck.dismissed`) isn't offered automatically again. The character menu's *Check the guide for updates* always fetches fresh and always answers.
- **Apply** is renderer-side `mergeProgress(old, new)`: the phase being played is re-entered from the character state (`enterPhase`), so every held point the new routes still want is kept, in any order. What's left becomes the banner ("Guide updated — in …"). It resets the undo stack and offers an Undo toast. Nothing is ever applied without the player's click. `diffLoadout` compares guide routes (`track.guide ?? history`).

### Character profiles
Each character has its own build and progress: `<userData>/profiles/<id>.json` = `{ version, id, name, createdAt, updatedAt, build, updateCheck? }`.
- `settings.activeProfile` is owned by main, like the window bounds.
- `store.migrateProfiles()` turns the pre-profiles `build.json` into the first profile once, and keeps the old file as `build.json.migrated`.
- **Names**:
  - A new profile is named after its class ("Rogue", "Rogue 2", unique).
  - An empty, never-renamed "Character N" takes the class name with its first load.
  - The player renames it in the character menu.
- **Loading**: the Load build footer's **Load into** picks this character or a new one. It defaults to a new character when the incoming class differs from the current build's.
- **Switching** resets per-build UI state (undo stack, pins, banner). Hotkeys always act on the active profile.
- The last profile can't be deleted. Ids are `p-<time36><rand>`, validated before any path is built.

### Raw Maxroll paste
One JSON object per line (passives/class/mastery line + one line per skill); `mergeRawLines` merges them. A single combined object also works. A real 6-line paste is in `tests/parser.test.js`.

### A profile's `build` — multi-phase loadout (was <userData>/build.json)
```json
{ "name": "Void Knight Erasing Strike", "classId": 2, "masteryId": 1, "currentPhase": 0,
  "phases": [ { "name": "Leveling", "masteryId": 1, "tracks": [
    { "type": "passive", "label": "Sentinel — Void Knight Passives", "history": [0,0,1], "totalSteps": 3, "currentStep": 0 },
    { "type": "skill", "skillKey": "v01cv", "label": "Void Cleave", "history": [2,2,4], "totalSteps": 3, "currentStep": 0 } ] } ] }
```
Also stored: `held` / `mastery` (the character state, see *Phases*), optional `phase.level`, and `track.guide` (the guide's order when entering the phase reordered `history`). Legacy single-phase `{ name, classId, masteryId, tracks }` is wrapped by `normalizeBuild()`, which also backfills a missing `phase.masteryId` from `loadout.masteryId` and derives the character state. `label` is baked at import time; the UI prefers live DB names (view-model titles).

### <userData>/settings.json
`{ window:{x,y,width,height,maximized}, compactWindow:{x,y,width,height}, display:{uiScale,alwaysOnTop,mode,opacity,sound,volume}, hotkeys:{enabled,hotkeyMode,laneKeys,latchKey,advanceModifier,undoModifier,toggle,phaseNextKey,phasePrevKey}, updates:{checkMaxroll,checkApp}, activeProfile, lastDataVersion }`. `activeProfile` and `lastDataVersion` are owned by main. It's always read through `mergeSettings()` (defaults + validation; unknown keys dropped).
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
Both files are committed (regenerate + commit after each patch). They're written as **one compact row per line**, which is 23 % smaller than indented JSON, and git diffs still show exactly which nodes changed. There is no fallback: if either is missing, `build-db.missingFiles()` reports it and the status bar shows **Game data missing**.

### version.json (written by extract.py)
`{ version, label, generated, nodes, trees }`. `version` is a 12-char hash of the extracted content: it changes exactly when the data does, and a re-run on the same export changes nothing. `label` is set with `--label "Season 4"` and kept on later runs.
- Main compares it with `settings.lastDataVersion` on `app:init`. The first start with a new version returns `dataUpdate`, and the renderer shows the one-time **Game data updated** card: the README's after-a-patch steps, plus "Check my guide now".
- A fresh install only records the version, so no card is shown.
- `tests/data-contract.test.js` fails when `version.json` doesn't match the committed rows.

### classes.json (hand-maintained)
`{ classes:{"2":"Sentinel"}, masteriesByClass:{"2":{"1":"Void Knight","2":"Forge Guard","3":"Paladin"}}, passiveTreeByClass:{"2":"kn-1"}, unverifiedMasteries:["2:1",…] }`

### Icons — db/data/icons/ + the `icon` field
- **Source of truth is the data row**: `row.icon` is a path relative to `db/data/icons/`. The renderer loads `../db/data/icons/<icon>` (URL-encoded per segment) and never scans the folder.
- **Tree icon** = the root node's icon (`nodeID 0`, `maxPoints 0`), drawn as a bare `<img>` in `.tree-art`, so it needs its own size rule in `lanes.css`. Without that rule the 128 px art shows only its dark top-left corner. This applies to skill trees only; class passive trees have no root node, so their lane shows a glyph.
- **Fallback**: `icon: null`, or an image that fails to load, draws a glyph (initials, hue from a hash that skips the green band). Partial icon sets are fine.
- **Rendering**: tiles get `.has-art` (thin rim + bottom shade over the image). Visual weight follows the reading order: current (green ring) and next are full brightness, later upcoming steps are dimmed, done steps are desaturated.

### Data pipeline (per game patch or season): maintainer only, never players
Your exporter writes `extractor/nodes_flat.json` and the node images into `db/data/icons/`. Then:
```bash
pip install -r extractor/requirements.txt       # once (Pillow)
npm run data -- --label "Season 4 (1.4)"        # convert_icons.py → extract.py (args passed on) → npm test
```
`scripts/update-data.js` runs `convert_icons.py` (PNG/JPG → 128 px WebP), then `extract.py --prune-icons` (validates, writes `db/data/*.json` + `version.json`, deletes icons no node uses any more), then the whole test suite, and prints the commit + release commands. Any failure stops it with nothing to release. Commit `nodes_flat.json`, `db/data/*.json` and `db/data/icons/` together, then release (see *Packaging and releases*). `extract.py` warns if non-WebP icons are present; **never commit PNG icons** (git keeps every version forever).
- **Icons on a re-export**: the exporter overwrites every image, and that's fine.
  - Any PNG present is new input, so it always replaces its WebP. File dates are never trusted, because an exporter may keep the asset's old date. Only `--keep-originals` falls back to "skip when the WebP is newer".
  - Unchanged images re-encode to identical bytes (WebP at a fixed quality is deterministic), so git records only real changes.
  - Icons the game dropped are deleted by `--prune-icons` once the output is valid. It refuses (warns, deletes nothing) when no node resolved an icon or when more than half the files would go (`PRUNE_MAX_SHARE`): that's a broken export, not a patch.

### `extract.py`
Cleans `extractor/nodes_flat.json` → `db/data/skill_tree_reconciled.json` + `passives.json`. It drops orphan and placeholder rows, merges duplicates (keeping an icon from either copy), and derives `treeName` from the root node (or from `TREE_NAME_OVERRIDES`).

- **Icons**: each input row's `iconFile` value (`ICON_INPUT_FIELDS = ('iconFile', 'icon')`, first non-empty wins; e.g. `"265676.png"`, icons are shared between nodes) is resolved against the images in `db/data/icons/` (`--icons-dir` to override), case-insensitively. It tries, in order: the relative path, the longest tail of an absolute/Windows path (both extension-agnostic, so `es6ai/12.png` finds `es6ai/12.webp` after conversion), the file name, then the file name without extension. Rows without a value fall back to `<treeID>/<nodeID>.<ext>`. A bare name that exists in several folders is ambiguous and is never guessed. Unresolved values become `null` and are reported (`--verbose` lists them); `--strict` makes them fail the run. Input fields that look icon-related (`/icon|sprite/i`) but aren't in `ICON_INPUT_FIELDS` trigger a warning, since that's the usual cause of "0 icons".
- **Copied root rows**: the export sometimes gives a tree another tree's root *name*. For example, `bl5st` Bladestorm and `sh4re` Shadow Rend both have a root named "Flay". Their `iconFile` is their own, correct icon.
  - `suspect_roots()` flags a root when another tree with the same root name mentions that name more in its descriptions ('shared'), or when the tree's own nodes never mention it ('unmentioned'; `Summon X` counts as mentioned when X is).
  - A 'shared' root, or any root named in `TREE_NAME_OVERRIDES`, is renamed by `fix_roots()`. The name comes from the override, else from `infer_tree_name()` over the node descriptions, else the treeID.
  - The root's icon is kept, unless it's the same file as the name owner's root icon (a full copy).
  - An 'unmentioned' root is only reported, because the inference is a guess (Falconry's nodes say "Falcon").
- **Output contract**: `validate_output()` checks the exact field set, types, unique `(treeID, nodeID)`, unique skill tree names, all 5 passive trees present, no passive rows in the skill file, and that icon files exist. On any violation it writes **nothing** and exits 1. `tests/data-contract.test.js` checks the same things from the app's side.

### Troubleshooting the data (maintainer)
- **Wrong node name**: a `(treeID, nodeID)` collision, where the stale node won. `extract.py --verbose` lists them.
- **Glyph instead of an icon**: the row has no `iconFile`, or the value matches no file. `--verbose` lists both. "0 icons" across the board plus a *WARNING: input has icon-like fields that are not read* means the export renamed the field: add it to `ICON_INPUT_FIELDS`.
- **A skill shows its treeID, or another skill's name**: the tree has no root row, or a copied root name. Pin the name in `TREE_NAME_OVERRIDES`.
- **Class or mastery shown wrong / "passive points don't fit the tree"**: save that planner as a fixture in `tests/fixtures/` and check `classes.json`.

### Known data-quality issues
- **~86 `(treeID, nodeID)` collisions** in `nodes_flat.json`: stale nodes from older tree versions exported next to live ones (e.g. `es6ai` 12 = "Rythm of the Void" *and* "Void Lens"). `extract.py` keeps the first named row, **which may be the stale one**. The fix is upstream: export only nodes referenced by the live tree. Don't write tests that assert names of collided nodes.

---

## Packaging and releases

- **electron-builder** config lives in `package.json` → `build`:
  - Windows NSIS installer (one-click, per user) and portable exe, x64.
  - `files` includes only `electron/`, `app/`, `shared/`, `parser/`, `db/build-db.js`, `db/data/**`, `config/build.example.json`.
  - **Fuses**: RunAsNode off, NODE_OPTIONS and `--inspect` off, cookie encryption on, `onlyLoadAppFromAsar`, and **embedded ASAR integrity** (electron-builder writes the hash into the Windows exe).
  - `npm run dist` builds locally (Windows); `npm run dist:dir` gives an unpacked smoke test on any OS.
- **userData is pinned** to `%APPDATA%/le-build-overlay` (`store.userDataDir`). `productName` "LE Build Planner" would otherwise move it and hide every existing character; a test guards it.
- **Updates** (`electron/updater.js`, injected like `hotkeys.js`):
  - **installer**: `electron-updater` from GitHub Releases. It checks 10 s after start and then every 6 h, downloads in the background, and installs on quit (`autoInstallOnAppQuit`). *Restart now* is only ever the player's click.
  - **portable** (`PORTABLE_EXECUTABLE_DIR`, or not Windows): the GitHub API latest release is compared with `compareVersions`, and the app offers its download page.
  - **off**: `!app.isPackaged` or `LE_USER_DATA`, so dev runs and tests never touch GitHub.
  - The Settings toggle is `updates.checkApp`.
  - State reaches the renderer through the `app-update` event. The renderer shows a status bar chip and a toast.
  - Background errors are silent; a manual *Check now* reports them.
- **Release flow**: `npm run data` (when there's new game data) → commit → `npm version minor` (bumps and tags `vX.Y.0`) → `git push --follow-tags`. `.github/workflows/release.yml` (windows-latest) checks that the tag matches `package.json`, runs `npm ci --ignore-scripts` and `npm test`, then `electron-builder --win --publish always`. It publishes the installer, the portable exe and `latest.yml` (what installed apps read).
- **Unsigned**: SmartScreen warns on first run until there's a code-signing certificate.

## Electron Architecture

**Electron 44** (Chromium 152, Node 24). Things that changed on the way from 28 and matter here:
- `clipboard.readText()` returns a **Promise** (44+), so always `await` it. The renderer has no `clipboard` module; use `navigator.clipboard` there if ever needed.
- `npm install` no longer downloads the Electron binary. The first `electron` run does it (42+). `npm ci --ignore-scripts` is therefore safe in CI. The Electron package needs Node ≥ 22.12 (`engines`).
- `webContents` `console-message` gets one event object (`e.level` is `'debug'|'info'|'warning'|'error'`, plus `e.message`, `e.lineNumber`, `e.sourceId`); the positional arguments are deprecated.
- Before the next major, read Electron's `docs/breaking-changes.md`. 45 removes Node shims and `Buffer` from sandboxed preloads; `preload.js` only uses `contextBridge` and `ipcRenderer`, so keep it that way.

- **One window**: normal frame, resizable (min 420×480), `sandbox`, `contextIsolation`, no `nodeIntegration`, no app menu, navigation and `window.open` blocked. Bounds, maximized state, zoom (UI scale) and always-on-top persist. Saved bounds are only reused if they're still on a connected display.
- **Mini mode** (`window:setMode`) is the same window: bounds are saved into the outgoing mode's slot and the incoming slot is restored (first use goes to the top-right of the display). It has min 260×180, is always on top, and uses `setOpacity(display.opacity)`, which does nothing on Linux. The frame stays native, because Electron can't switch frames at runtime.
- **Single instance**: a second launch focuses the existing window.
- **userData**: `app.getPath('userData')`, overridable with env `LE_USER_DATA` (tests/screenshots). A pre-profiles `build.json` there becomes the first character profile.
- **Game data** is loaded once and cached in main. `app:init` re-checks `build-db.dataStamp()` (the size and mtime of each file) and re-reads only if a file changed. A window reload picks up re-extracted data without re-parsing ~2 MB on every load.

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
`init` (also returns `appUpdate`, `dataUpdate`, `version`), `saveBuild` (active profile), `previewPhase(json)`, `loadLoadout(phases, name, source?, target?)`, `fetchMaxroll(link)`, `maxrollClipboardLink`, `openMaxroll(link)`, `checkGuideUpdate(manual)`, `dismissGuideUpdate(date)`, `createProfile(name?)`, `switchProfile(id)`, `renameProfile(id, name)`, `deleteProfile(id)`, `loadExample`, `saveSettings`, `pauseHotkeys(bool)`, `listTemplates`, `saveTemplate`, `loadTemplate`, `deleteTemplate`, `checkAppUpdate`, `installAppUpdate` (installer: restart into the update; portable: open the release page). Main → renderer: `hotkey` events via `onHotkey(cb)`, `app-update` via `onAppUpdate(cb)`.

### In-app keyboard (renderer, ignored while typing or a dialog is open)
- Lanes: `1`–`6` and the configured lane keys (`F1`–`F6` / numpad), `Shift` = undo. `Ctrl`+`1`–`6` / `Ctrl+Enter` fill the step.
- Navigation: `↑↓` focus a tree, `←→` browse steps (pins the inspector), `Enter`/`Space` allocate in the focused tree, `Backspace` undo.
- `Ctrl+Z` undoes the last change in any tree (phase-scoped stack, capped at 50).
- `Ctrl+Shift+Delete` = full clear (`clearProgress`): every phase back to 0, empty character state, first phase. It's also in the character menu. It's in-app only (never global: destructive), always goes through `confirm()`, then offers an Undo toast that's valid while nothing has changed since.
- `Esc` unpins the inspector. It never leaves mini mode and never closes the phase instructions.
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
- The Python scripts force UTF-8 output (`stream.reconfigure`): Windows pipes default to cp1252, which crashes on `→ ≈ — ×`. Reproduce Windows failures locally with `PYTHONIOENCODING=cp1252 npm test`.
- UI changes must be checked in the real app at several window sizes (e.g. 1920, 1440, 1100, 760, 460 px wide). Run it under `xvfb-run` with `LE_USER_DATA` pointing at a temp dir, and drive it via `webContents.executeJavaScript` / `sendInputEvent` + `capturePage`.
- **Docs split**: `README.md` is the player's guide (install, using the app, after a patch, troubleshooting). No data-extraction or code internals there: those live in this file.
- `.gitignore` policy: game data we produce is committed (`nodes_flat.json`, `db/data/**`); raw game dumps, runtime state, build output and tooling noise are ignored.

## Known Open Issues / Decisions
1. **Duplicate nodes in data**: see above; needs an upstream exporter fix.
2. **Global keys swallow the key for every app** (Windows `RegisterHotKey`). The lane keys therefore default to `F1`–`F6`. Users migrated from older settings stay on digits until they switch. The repeat guard and the sounds are defensive against Windows behaviour that can't be exercised in Linux CI: check them by hand on Windows after changes to `hotkeys.js`.
3. **Packaging is set up but only verified on Linux here** (unpacked build: data and icons load from the asar, userData stays `le-build-overlay`). The first Windows release, and the install → update → restart cycle, must be checked by hand on Windows (release 0.1.x, then 0.2.0 to see the update land). Remaining ideas are in `docs/ROADMAP.md`.
4. **16 committed icon files are unused** (4,583 of 4,598 nodes have an icon). They're probably the art of the stale collided rows. The next `npm run data` deletes them (`--prune-icons`).
