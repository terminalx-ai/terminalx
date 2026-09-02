#!/usr/bin/env python3
"""Stamp a "D" badge onto the app icon so the dev build is easy to tell apart
from the release build in the Dock and the ⌘-Tab switcher.

    python3 scripts/badge-dev-icon.py

Reads the 1024px master out of src-tauri/icons/icon.icns (or any PNG/ICNS
passed as the first argument), composites an amber rounded badge with a white
"D" into the bottom-right corner, and writes the result to
src-tauri/icons-dev/app-icon-dev.png. Feed that file to

    pnpm tauri icon src-tauri/icons-dev/app-icon-dev.png --output src-tauri/icons-dev

to regenerate the whole dev icon set.

The output is deterministic: same source, same fonts, same bytes.
"""

from __future__ import annotations

import struct
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO / "src-tauri" / "icons" / "icon.icns"
DEFAULT_OUTPUT = REPO / "src-tauri" / "icons-dev" / "app-icon-dev.png"

# The Den palette's amber accent, converted from the CSS tokens the UI uses:
# --accent: oklch(0.78 0.13 70) and --accent-fg: oklch(0.2 0.03 70) in
# src/styles/tokens.css. Keeping the badge on the app's own accent means the
# dev icon still looks like Raccoon rather than a sticker.
BADGE_FILL = (236, 168, 81, 255)
BADGE_OUTLINE = (31, 19, 6, 255)
LETTER = "D"
LETTER_FILL = (255, 255, 255, 255)

# Fractions of the icon's width, so the badge scales with whatever master we
# are handed.
BADGE_SIZE = 0.28
BADGE_MARGIN = 0.025
BADGE_RADIUS = 0.28  # of the badge's own size
OUTLINE_WIDTH = 1 / 64  # ~1px once the Dock renders the icon at 64px
LETTER_CAP_HEIGHT = 0.52  # of the badge's own size

# Drawn at 4x and downsampled; PIL has no anti-aliased shape drawing.
SUPERSAMPLE = 4

# First one that exists wins, so the result is stable across machines that
# have the same fonts installed.
FONT_CANDIDATES = (
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
    ("/System/Library/Fonts/Helvetica.ttc", 1),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", 0),
)


def load_source(path: Path) -> Image.Image:
    """Open a PNG, or the largest image inside an ICNS."""
    if path.suffix.lower() != ".icns":
        return Image.open(path).convert("RGBA")
    return largest_icns_image(path)


def largest_icns_image(path: Path) -> Image.Image:
    """Pull the biggest PNG-encoded entry out of an ICNS container.

    Pillow's ICNS reader tops out at whatever sizes it recognises and quietly
    downsamples; the release icns carries a 1024px master (the `ic10` entry)
    and that is the one worth badging.
    """
    data = path.read_bytes()
    magic, total = struct.unpack(">4sI", data[:8])
    if magic != b"icns":
        raise SystemExit(f"{path} is not an ICNS file")
    best: Image.Image | None = None
    offset = 8
    while offset + 8 <= total:
        _kind, length = struct.unpack(">4sI", data[offset : offset + 8])
        if length < 8:
            raise SystemExit(f"{path} has a malformed entry at byte {offset}")
        payload = data[offset + 8 : offset + length]
        offset += length
        # Only the PNG entries matter: the legacy raw-bitmap and mask entries
        # top out at 128px, so they could never be the largest anyway.
        if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
            continue
        image = Image.open(BytesIO(payload)).convert("RGBA")
        if best is None or image.width > best.width:
            best = image
    if best is None:
        raise SystemExit(f"{path} holds no PNG entry to badge")
    return best


def load_font(pixel_size: int) -> ImageFont.FreeTypeFont:
    for candidate, index in FONT_CANDIDATES:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, pixel_size, index=index)
    tried = "\n  ".join(path for path, _ in FONT_CANDIDATES)
    raise SystemExit(f"no bold sans font found. Looked for:\n  {tried}")


def fit_letter(target_cap_height: float) -> tuple[ImageFont.FreeTypeFont, tuple[int, int, int, int]]:
    """Find the font size whose "D" is `target_cap_height` pixels tall.

    Cap height as a fraction of the em varies by face, so measure the glyph at
    a probe size, extrapolate, then walk the last pixel or two by hand.
    """
    probe = 100
    box = load_font(probe).getbbox(LETTER)
    cap_at_probe = box[3] - box[1]
    if cap_at_probe <= 0:
        raise SystemExit(f'the chosen font renders "{LETTER}" as nothing')
    size = max(1, round(target_cap_height * probe / cap_at_probe))
    font = load_font(size)
    while size > 1 and font.getbbox(LETTER)[3] - font.getbbox(LETTER)[1] > target_cap_height:
        size -= 1
        font = load_font(size)
    return font, font.getbbox(LETTER)


def badge(icon: Image.Image) -> Image.Image:
    if icon.width != icon.height:
        raise SystemExit(f"source icon is {icon.width}x{icon.height}, expected a square")

    scale = SUPERSAMPLE
    canvas = icon.width * scale
    size = round(icon.width * BADGE_SIZE) * scale
    margin = round(icon.width * BADGE_MARGIN) * scale
    radius = round(size * BADGE_RADIUS)
    outline = max(scale, round(icon.width * OUTLINE_WIDTH) * scale)

    layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    right = canvas - margin
    bottom = canvas - margin
    box = (right - size, bottom - size, right, bottom)
    # The outline is drawn inside the badge, so the badge keeps its full size
    # and the dark ring separates amber from whatever sits behind it.
    draw.rounded_rectangle(box, radius=radius, fill=BADGE_FILL, outline=BADGE_OUTLINE, width=outline)

    font, glyph = fit_letter(size * LETTER_CAP_HEIGHT)
    # Centre the glyph by its ink box, not by its metrics box: bearings and
    # descender space would push the "D" off-centre otherwise.
    ink_width = glyph[2] - glyph[0]
    ink_height = glyph[3] - glyph[1]
    x = box[0] + (size - ink_width) / 2 - glyph[0]
    y = box[1] + (size - ink_height) / 2 - glyph[1]
    draw.text((x, y), LETTER, font=font, fill=LETTER_FILL)

    # Downsample the badge alone and composite at native resolution, so the
    # source art comes through untouched outside the badge.
    badged = icon.convert("RGBA").copy()
    badged.alpha_composite(layer.resize((icon.width, icon.height), Image.LANCZOS))
    return badged


def main(argv: list[str]) -> int:
    source = Path(argv[1]) if len(argv) > 1 else DEFAULT_SOURCE
    output = Path(argv[2]) if len(argv) > 2 else DEFAULT_OUTPUT
    if not source.exists():
        raise SystemExit(f"no source icon at {source}")
    icon = load_source(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    badge(icon).save(output, "PNG", optimize=True)
    print(f"wrote {output} ({icon.width}x{icon.height}) from {source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
