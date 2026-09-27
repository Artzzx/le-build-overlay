# Roadmap: planned, not built yet

The Electron upgrade (28 → 44) is done. Everything below is agreed direction, kept here so it isn't lost. Suggested order: **B → C + D → E**. Items in **F** fit in whenever they're useful.

---

## B. Packaging (installer + portable)

- **Tool:** `electron-builder` (dev dependency). Move `electron` itself to `devDependencies`, which electron-builder requires.
- **Targets:** Windows NSIS installer + portable exe. Config lives in `package.json` → `build`.
- **What goes in:** `electron/`, `app/`, `shared/`, `parser/`, `db/build-db.js`, `db/data/**`, `config/build.example.json`. Leave out `extractor/`, `tests/`, `docs/` and `scripts/`.
- **⚠ userData trap:** setting `productName` ("LE Build Planner") changes `app.getName()`, and with it the user-data folder, so every user would silently lose their characters.
  - Pin the folder in `electron/main.js`: `app.setPath('userData', path.join(app.getPath('appData'), 'le-build-overlay'))`, before anything reads it and after the `LE_USER_DATA` override.
  - Add a test for it.
- **Verify** that `db/data` (read with `fs`) and the icons (`../db/data/icons/…` over `file://`) load from inside the asar.
  - Electron 45 restricts file descriptors *inside* ASAR to `fs`. Plain `fs.readFileSync` is fine, but don't hand asar paths to native code.
- **Unsigned for now**, so SmartScreen will warn on first run. Code signing (a yearly certificate) is a later decision.

## C. Auto-update (`electron/updater.js`)

- **Library:** `electron-updater`, published to GitHub Releases (`Artzzx/le-build-overlay`).
- **Structure:** built like `hotkeys.js` / `maxroll.js`. It takes `createUpdater({ autoUpdater, app, settings, emit })` as injected dependencies, so it's unit-tested with a fake `autoUpdater`.
- **Behaviour:**
  - States: `idle → checking → available → downloading → ready | error`.
  - Check at start and every 6 h, and download in the background.
  - **Never restart mid-game.** The status bar shows *Update ready: restart*, and it otherwise installs on quit.
- **Portable build:** it can't self-update. Show *New version x.y available* with a link to the release.
- **Off** in dev, when `LE_USER_DATA` is set, and with a Settings toggle (`updates.checkApp`).
- **IPC:**
  - `update:state` (main → renderer);
  - `update:check`, `update:install` (renderer → main).
- **Decision still open:** install on quit (recommended) or ask every time.

## D. "Game data updated" notice (first launch after a patch)

- `extract.py` writes `db/data/version.json` = `{ patch: "1.4", generated: "<date>" }`, and the output contract checks it.
- Main remembers the last data version it showed (`settings.lastDataVersion`). The first time the app starts with newer data, the renderer shows a one-time card:
  - *"Game data updated for patch 1.4"*;
  - the short version of README's *After a major game patch* steps;
  - a guide-update check for every Maxroll-sourced character, or at least the active one.
- Game data only reaches players through app updates (C), so this card is the one moment a player needs that guidance.

## E. Releases (CI)

- A GitHub Actions workflow on tag `v*`, running on `windows-latest`:
  1. `npm ci --ignore-scripts` (safe since Electron 42 no longer needs its install script);
  2. `npm test`;
  3. `electron-builder --publish always` with `GITHUB_TOKEN`.
- Scripts: `npm run dist` (local build) and `npm run release`.

---

## F. What the Electron 44 upgrade makes possible

Checked against Electron's docs and the running app (Chromium 152).

| Opportunity | Why it matters here | Where it fits | Effort |
|---|---|---|---|
| **Fuses + ASAR integrity on Windows** (Electron ≥ 30): `RunAsNode` off, `OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation` | A packaged app can't be turned into a generic Node runner or have its code swapped on disk: real hardening for an unsigned app on players' PCs. | With **B** (`@electron/fuses` in the build step) | S |
| **Global shortcuts on Linux Wayland** via the desktop portal | The core feature (F1–F6 while the game has focus) works on Wayland desktops, including Proton/Linux players. It needs `desktopName` in `package.json`, and the user accepts the bindings once. | Anytime; test on a Wayland session | S |
| **No install-time script** (Electron 42+) | CI and contributors can use `npm ci --ignore-scripts`, which closes the common npm supply-chain attack path. | **E** | XS |
| **CSS anchor positioning** (Chromium 125+) | The character menu is placed with JS measuring (`getBoundingClientRect`). Anchoring it in CSS removes that code and follows the button when the window resizes. | UI polish | S |
| **`field-sizing: content`** (Chromium 123+) | The export-codes textarea can grow with its content instead of scrolling inside a fixed box. | Load build dialog | XS |
| **`interpolate-size: allow-keywords`** (Chromium 129+) | Smooth open/close for the inspector drawer and the help `<details>` without JS height math. | UI polish | XS |
| **Windows 11 `backgroundMaterial: 'acrylic'`** | Mini mode is see-through by lowering opacity, which also fades the text. Acrylic blurs the game behind a solid, readable panel instead. It needs a transparent page background in mini mode; test on Windows 11 (does nothing elsewhere). | Mini mode | M |

Considered and **not** worth it:
- Native notifications (games in fullscreen suppress them, and the sound cues already cover "did it land").
- `WebContentsView` / `BaseWindow` (one window is enough).
- `utilityProcess` (nothing heavy runs in main).
