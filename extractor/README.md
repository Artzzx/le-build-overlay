# Extractor — Game Asset Extraction Guide

Run these steps **once per game patch** to regenerate `db/data/*.json`.

## Tools Required

| Tool | Purpose | Download |
|------|---------|----------|
| Il2CppDumper | Generate DummyDll from `GameAssembly.dll` + `global-metadata.dat` | [github.com/Perfare/Il2CppDumper](https://github.com/Perfare/Il2CppDumper) |
| AssetStudio | Browse & export Unity assets as JSON | [github.com/Perfare/AssetStudio](https://github.com/Perfare/AssetStudio) |
| Python 3.10+ | Run extract.py and map-ids.py | python.org |

---

## Step 1 — Il2CppDumper (once per major patch)

```
Il2CppDumper.exe "C:\...\Last Epoch\GameAssembly.dll"
  "C:\...\Last Epoch\Last Epoch_Data\il2cpp_data\Metadata\global-metadata.dat"
  D:\le_dump\
```

Output: `D:\le_dump\DummyDll\` — needed by AssetStudio to deserialize MonoBehaviour types.

---

## Step 2 — AssetStudio Export

1. Open AssetStudio
2. `File > Load Folder` → point to `Last Epoch\Last Epoch_Data\`
3. When prompted for DummyDll: `D:\le_dump\DummyDll`
4. Wait for assets to load (~1-2 min)
5. Filter panel: `Type > MonoBehaviour`
6. `Export > Filtered Assets` → choose output folder, e.g. `D:\le_export\`

This exports ~160k+ JSON files. Takes several minutes.

---

## Step 3 — Run extract.py

```bash
cd le-build-overlay

python extractor/extract.py \
  --input D:\le_export \
  --output db/data

# Optional: validate against a known build
python extractor/extract.py \
  --input D:\le_export \
  --output db/data \
  --validate config/my-known-build.json
```

Output: `db/data/passives.json`, `db/data/skills.json`, `db/data/classes.json`

---

## Step 4 — Map Maxroll Skill Keys (first time only)

Maxroll uses opaque keys like `fl44` for skill trees. These must be mapped to
extracted asset names. You need a known build where you can identify which skill
is `fl44` (e.g. you know it's Erasing Strike because you exported your own build).

```bash
# Find the mapping (requires a known Maxroll JSON build)
python extractor/map-ids.py find \
  --build config/my-known-build.json \
  --skills db/data/skills.json \
  --output extractor/skillkey-map.json

# Review skillkey-map.json — verify the matches look correct
# Then apply:
python extractor/map-ids.py apply \
  --map extractor/skillkey-map.json \
  --skills db/data/skills.json
```

After applying, `db/data/skills.json` will use `fl44`, `fl22`, etc. as keys,
matching what the parser expects.

---

## Troubleshooting

**"Missing data file — run extractor/extract.py"**
The db/data/ files don't exist yet. Follow steps 1–3.

**"0 passives extracted"**
AssetStudio exported a different JSON structure than expected. Open one of the
`PassiveTreeData_*.json` exports manually and check the field names, then update
`extract.py`'s `extract_passives()` function accordingly.

**Missing nodeIds after validation**
The game was patched and some node IDs changed. Re-run extraction after patching.

**skillKey mapping wrong**
The node intersection score was low. Check `skillkey-map.json` for low-confidence
matches and manually correct them. Score should ideally be >80% node overlap.
