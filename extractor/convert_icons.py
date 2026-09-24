"""
extractor/convert_icons.py
───────────────────────────
Converts the node icons in db/data/icons/ to WebP before they are committed.

Why: the exported icons are 128×128 PNGs averaging ~31 KB. WebP at quality 85
averages ~5 KB with no visible difference at the sizes the app draws (≤ 76 px
× UI scale). Across ~4,600 nodes that is ~140 MB vs ~24 MB, and git keeps
every committed version forever — so convert *before* the first commit and
after every re-export.

Run it before extract.py (order is forgiving: the extractor resolves icon
values extension-agnostically, so "es6ai/12.png" finds "es6ai/12.webp").

    pip install pillow
    python extractor/convert_icons.py              # convert, delete originals
    python extractor/convert_icons.py --dry-run    # show what would happen
    python extractor/convert_icons.py --keep-originals

Behaviour
  - .png / .jpg / .jpeg → .webp next to the source (same name, new extension)
  - Images larger than --size (default 128) are downscaled to fit; smaller
    ones are left as is. Transparency is preserved.
  - Idempotent: a source whose .webp is newer is skipped.
  - An original is deleted only after its .webp was written and re-opened
    successfully. Unreadable files are reported and make the exit code 1.
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ICONS_DIR = ROOT / 'db' / 'data' / 'icons'
SOURCE_EXTENSIONS = ('.png', '.jpg', '.jpeg')


def human(n):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.0f} {unit}' if unit == 'B' else f'{n:.1f} {unit}'
        n /= 1024


def convert_one(src, dst, size, quality, Image):
    """Write dst (WebP) from src. Returns (old_bytes, new_bytes, note)."""
    with Image.open(src) as im:
        im.load()
        note = None
        if im.width != im.height:
            note = f'not square ({im.width}×{im.height})'
        has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
        im = im.convert('RGBA' if has_alpha else 'RGB')
        if max(im.size) > size:
            im.thumbnail((size, size), Image.LANCZOS)
        tmp = dst.with_name(dst.name + '.tmp')
        im.save(tmp, 'WEBP', quality=quality, method=6)
    with Image.open(tmp) as check:  # make sure what we wrote is a readable image
        check.verify()
    tmp.replace(dst)
    return src.stat().st_size, dst.stat().st_size, note


def main():
    ap = argparse.ArgumentParser(description='Convert db/data/icons images to WebP.')
    ap.add_argument('--icons-dir', type=Path, default=DEFAULT_ICONS_DIR)
    ap.add_argument('--size', type=int, default=128, help='max width/height in px (default 128)')
    ap.add_argument('--quality', type=int, default=85, help='WebP quality 1–100 (default 85)')
    ap.add_argument('--keep-originals', action='store_true', help='do not delete the source files')
    ap.add_argument('--dry-run', action='store_true', help='list what would be converted, change nothing')
    args = ap.parse_args()

    try:
        from PIL import Image, features
    except ImportError:
        sys.exit('Pillow is required: pip install pillow')
    if not features.check('webp'):
        sys.exit('This Pillow build has no WebP support: pip install --upgrade pillow')

    if not args.icons_dir.is_dir():
        sys.exit(f'No icons folder at {args.icons_dir}')

    sources = sorted(p for p in args.icons_dir.rglob('*') if p.is_file() and p.suffix.lower() in SOURCE_EXTENSIONS)
    converted = skipped = 0
    before = after = 0
    failed, notes = [], []

    for src in sources:
        dst = src.with_suffix('.webp')
        rel = src.relative_to(args.icons_dir).as_posix()
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            skipped += 1
            if not args.keep_originals and not args.dry_run:
                src.unlink()  # already converted earlier; finish the cleanup
            continue
        if args.dry_run:
            print(f'would convert {rel}')
            converted += 1
            continue
        try:
            old, new, note = convert_one(src, dst, args.size, args.quality, Image)
        except Exception as err:  # corrupt / unsupported file: keep the original
            failed.append(f'{rel}: {err}')
            continue
        converted += 1
        before += old
        after += new
        if note:
            notes.append(f'{rel}: {note}')
        if not args.keep_originals:
            src.unlink()

    verb = 'would convert' if args.dry_run else 'converted'
    print(f'{verb} {converted}, already up to date {skipped}, failed {len(failed)} — in {args.icons_dir}')
    if before:
        print(f'size: {human(before)} → {human(after)} ({100 - after * 100 / before:.0f}% smaller)')
    for n in notes[:20]:
        print(f'  note: {n}')
    if len(notes) > 20:
        print(f'  … {len(notes) - 20} more notes')
    for f in failed:
        print(f'  FAILED {f}', file=sys.stderr)
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
