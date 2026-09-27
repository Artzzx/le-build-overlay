# LE Build Planner

A desktop companion for **Last Epoch**. Load your build from a [Maxroll planner](https://maxroll.gg/last-epoch/planner) link and follow it point by point while you play. Every tree (the class passive tree and all five skills) is in one view, and the node to allocate **next** in each tree is shown big and green.

![LE Build Planner](docs/screenshot.webp)

- **Read it at a glance.** One lane per tree: its progress, the node to take next (and what comes after), and the whole route as a strip of nodes. Green always means "allocate this next".
- **Never leave the game.** Press `F1`–`F6` in game to tick a point off in trees 1–6 (`Shift` undoes). A short sound confirms each press, so you don't have to look.
- **Mini mode.** A small, always-on-top window for a corner of the screen: one line per tree with the next node and its key.
- **Leveling → Endgame.** A build can have up to 5 phases. When you switch phase, the app keeps your progress where the routes overlap and tells you exactly what to respec, and which mastery to pick.
- **Every character.** Your main, your alts and your next-season character each keep their own build and progress.
- **Guides that change.** When the author edits the Maxroll guide, the app shows you what changed and applies it only if you agree, keeping your progress.

---

## Getting started

### Install

There's no installer yet. Until there is, you need [Node.js](https://nodejs.org) 18 or newer:

```bash
git clone https://github.com/Artzzx/le-build-overlay.git
cd le-build-overlay
npm install
npm start
```

To update later: `git pull`, then `npm install`.

### First start

1. **Copy your build's Maxroll link**, e.g. `https://maxroll.gg/last-epoch/planner/sb62zd0e`.
2. In the app, click **Load build** (`Ctrl`+`O`), choose **From a Maxroll link**, paste the link and press **Fetch**. If the link is already on your clipboard, the app offers **Fetch this build** straight away.
3. **Tick the variants you want.** Each one (*Starting Setup*, *Early Setup*, … *Final Setup*) becomes a phase. Then click **Load**.

The game needs to run in **Windowed** or **Borderless** mode for the app to stay visible on top of it. Put the app on a second monitor, or use mini mode (`Ctrl`+`M`) in a corner of the screen.

Just curious? **Try the example build** on the start screen.

---

## Using it while you play

### Allocating points

Put a point in the game, then press that tree's key: `F1` for the first lane, `F2` for the second, and so on (the key is shown on each lane). You don't need to switch windows; the keys work while the game has focus.

- **Undo** with `Shift`+ the same key, or `Ctrl`+`Z` in the app.
- **Sounds**: a tick per point, a chime when a step or a tree is done, and a low buzz when nothing happened (the tree is finished, say).
- **The status bar** shows your last change (`+1 Shadow Rend · Intensity 2/3`) with an **Undo** button.
- **Fill ×N** puts every remaining point of a multi-point node in at once.
- **Holding a key down** never burns through points.

### Already levelled? Catch the app up

Click the node you're actually at in a tree, then **Start from here**. The app marks everything before it as done.

### Phases

The phase tabs at the top switch between *Leveling*, *Endgame*, and so on (also `F9` / `Shift`+`F9` in game, or `PgDn` / `PgUp` in the app).

When you switch, a yellow banner lists what to do in game: points to **unspec**, skills to **take off your bar**, or the **mastery** to choose. Your progress carries over wherever the two phases share the same route. When every tree in a phase is done, the app offers to move to the next one.

### Mini mode

`Ctrl`+`M` switches to a small window that stays on top. It has one line per tree with the next node and its key. Click a line to allocate, right-click to undo. `Ctrl`+`M` again goes back. It remembers its own size and position, and `Esc` never kicks you out of it.

### Characters

The name above the build (top left) opens your **characters**. Each keeps its own build and progress.

- **Switch**: click a character.
- **New character**: starts empty and opens *Load build*.
- **Rename**: give it your in-game character's name.
- **Delete**: removes a character and its progress (the last one can't be deleted).

When you load a build, **Load into** (at the bottom of the window) picks *this character* or a *new character*. It chooses *new character* by itself when the build is a different class, so loading an alt never wipes your main.

### Guide updates

For builds loaded from a Maxroll link, the app checks once a day, when it starts, whether the author edited the guide. If they did, you get a **Review** button:

- It lists, phase by phase, what changed: points added, a route changed after point 8, a skill swapped, a new mastery.
- **Apply update** keeps every point you've allocated on the unchanged part of each route. If something you already took changed, a banner tells you what to respec. There's an **Undo**.
- **Keep my version** leaves your build as it is and stops offering that version.

To check right now, open the characters menu and choose **Check the guide for updates**. To turn the daily check off, go to **Settings › Guide updates**.

### Without a Maxroll link

In **Load build**, choose **Paste export codes**. You can paste codes from Maxroll's *Export* dialog, or the in-game export: the passives code, then one line per skill. Add a phase per stage of the guide.

Click **Save as template** to reuse a set of codes later.

---

## After a major game patch

Big patches rework trees, move nodes and add skills. The first time you play after one:

1. **Update the app first** (`git pull`, then `npm install`). New game data (trees, node names, icons) comes with app updates. Until then, a reworked skill can show **No tree data**, and changed nodes can show their old names.
2. **Your characters and progress are kept.** Nothing is reset by an update.
3. **Check your guide.** Open the characters menu and choose **Check the guide for updates**. Authors usually update their planners within days of a patch. Review the changes, then apply them. The banner lists what to respec in game.
4. **If the patch refunded your points in game**, set each tree back to where you really are: click the node you're at, then **Start from here**. To start a tree over, undo it back to 0.
5. **A skill still shows "No tree data", or Load build warns that points "don't fit the tree"?** Either the guide hasn't been updated for the patch yet, or your app is older than the patch. Check again later.
6. **New season or cycle?** Make a **new character** for it (**Load into › New character**). Your old character keeps its own build and progress.

---

## Controls

| | In game | In the app |
|---|---|---|
| Allocate a point | `F1`–`F6` | `1`–`6` or `F1`–`F6`, **Allocate**, or `Enter` on the focused tree |
| Undo a point | `Shift`+`F1`–`F6` | `Shift`+`1`–`6`, the undo button, or `Backspace` |
| Fill the whole node | — | `Ctrl`+`1`–`6`, `Ctrl`+`Enter`, or **Fill ×N** |
| Undo the last change (any tree) | — | `Ctrl`+`Z` or **Undo** in the status bar |
| Next / previous phase | `F9` / `Shift`+`F9` | the phase tabs, or `PgDn` / `PgUp` |
| Show / hide the window | `F8` | — |
| Mini mode ↔ full window | — | `Ctrl`+`M` |
| Move between trees / nodes | — | `↑` `↓` / `←` `→`, `Esc` to go back |
| Load build · Settings · all shortcuts | — | `Ctrl`+`O` · `Ctrl`+`,` · `?` |
| Interface size | — | `Ctrl`+`=` / `Ctrl`+`-` / `Ctrl`+`0` |

Every in-game key can be changed in **Settings**:

- **Lane keys** can be `F1`–`F6` (the default), `1`–`6`, or numpad `1`–`6`.
- **Arm first** mode: press `` ` `` first, and the lane keys work for 5 seconds. The game keeps those keys the rest of the time.
- Settings refuses to save a key assigned to two actions.

## Settings

`Ctrl`+`,`, or the gear icon:

- **Display**: interface size, keep on top, mini mode opacity.
- **Sound**: hotkey sounds and their volume.
- **Guide updates**: the daily Maxroll check.
- **Global hotkeys**: turn them on or off, choose the lane keys, direct or arm-first mode, the modifiers, and the show/hide and phase keys.

## Your data

Your characters, settings and templates are stored on your computer, in `%APPDATA%\le-build-overlay` on Windows. Nothing is uploaded. The app only contacts Maxroll to fetch a build you asked for, and for the daily guide check, which you can turn off.

---

## Troubleshooting

**A key does nothing in game.** Another program may already use it. The status bar shows *Hotkey unavailable* with the key; open **Settings** and pick another one.

**The F-keys don't work on my laptop.** Your keyboard sends media keys by default. Turn on **Fn Lock** (often `Fn`+`Esc`), or switch the lane keys to numpad or `1`–`6` in Settings.

**My number keys stopped working in game or in chat.** Your lane keys are set to `1`–`6`, so the app takes those keys. Switch to `F1`–`F6` in Settings, or use **Arm first**.

**The app window disappears behind the game.** Run the game in **Windowed** or **Borderless** mode, and turn on **Keep on top** (the pin icon), or use mini mode. `F8` shows or hides the window.

**No sounds.** Open **Settings › Sound** and press **Test**. Sounds only play for keys pressed *in game*; clicks and keys in the app are silent on purpose.

**Mini mode isn't see-through.** Opacity only works on Windows and macOS.

**"Couldn't import this planner".** Check that the link opens in your browser. If Maxroll is down or blocks the request, use **Paste export codes** instead.

**A tree says "No tree data".** That skill isn't in the app's game data yet. It's usually new in a patch: see [After a major game patch](#after-a-major-game-patch).

---

## For developers

`npm run dev` starts the app with DevTools, and `npm test` runs the test suite. The architecture, data formats and conventions are in [CLAUDE.md](CLAUDE.md).
