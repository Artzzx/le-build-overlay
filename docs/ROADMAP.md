# Roadmap

The Electron upgrade (28 → 44) and packaging (B–E) are done. What's left is **F**: ideas that fit in whenever they're useful.

---

## Done

- **B. Packaging**: electron-builder, NSIS + portable, pinned userData.
- **C. Auto-update**: `electron/updater.js`.
- **D. Game data updated card**: `version.json`.
- **E. Releases**: GitHub Actions on tag `v*`.

See CLAUDE.md → *Packaging and releases*. Still to do by hand: the first real Windows release and an install → update → restart cycle.

Open decision: **code signing** (a yearly certificate). Without it, SmartScreen warns on first run.

---

## F. What the Electron 44 upgrade makes possible

Checked against Electron's docs and the running app (Chromium 152).

| Opportunity | Why it matters here | Where it fits | Effort |
|---|---|---|---|
| ~~**Fuses + ASAR integrity on Windows**~~ | **Done** with packaging (`package.json` → `build.electronFuses`). | — | — |
| **Global shortcuts on Linux Wayland** via the desktop portal | The core feature (F1–F6 while the game has focus) works on Wayland desktops, including Proton/Linux players. It needs `desktopName` in `package.json`, and the user accepts the bindings once. | Anytime; test on a Wayland session | S |
| ~~**No install-time script**~~ | **Done**: both workflows use `npm ci --ignore-scripts`. | — | — |
| **CSS anchor positioning** (Chromium 125+) | The character menu is placed with JS measuring (`getBoundingClientRect`). Anchoring it in CSS removes that code and follows the button when the window resizes. | UI polish | S |
| **`field-sizing: content`** (Chromium 123+) | The export-codes textarea can grow with its content instead of scrolling inside a fixed box. | Load build dialog | XS |
| **`interpolate-size: allow-keywords`** (Chromium 129+) | Smooth open/close for the inspector drawer and the help `<details>` without JS height math. | UI polish | XS |
| **Windows 11 `backgroundMaterial: 'acrylic'`** | Mini mode is see-through by lowering opacity, which also fades the text. Acrylic blurs the game behind a solid, readable panel instead. It needs a transparent page background in mini mode; test on Windows 11 (does nothing elsewhere). | Mini mode | M |

Considered and **not** worth it:
- Native notifications (games in fullscreen suppress them, and the sound cues already cover "did it land").
- `WebContentsView` / `BaseWindow` (one window is enough).
- `utilityProcess` (nothing heavy runs in main).
