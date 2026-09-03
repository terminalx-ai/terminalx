#!/usr/bin/env python3
"""Generate the TerminalX release and development icon masters.

    python3 scripts/badge-dev-icon.py

The source of truth is the icon embedded in the installed predecessor app.
The script extracts the largest PNG entry from that ICNS container, stamps an
unwanted vertical highlight out of the left chevron, stamps an amber "N" or
"D" badge into its bottom-right corner, and writes the two 1024px masters
consumed by Tauri:

    src-tauri/icons/app-icon-next.png
    src-tauri/icons-dev/app-icon-next-dev.png

Pass another ICNS or PNG as the first argument when reproducing the assets on
a machine where the predecessor is installed somewhere else. Then run:

    pnpm tauri icon src-tauri/icons/app-icon-next.png --output src-tauri/icons
    pnpm tauri icon src-tauri/icons-dev/app-icon-next-dev.png --output src-tauri/icons-dev

The output is deterministic: the same source, fonts, and Pillow version yield
the same bytes.
"""

from __future__ import annotations

import struct
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path("/Applications/TerminalX.app/Contents/Resources/icon.icns")
RELEASE_OUTPUT = REPO / "src-tauri" / "icons" / "app-icon-next.png"
DEV_OUTPUT = REPO / "src-tauri" / "icons-dev" / "app-icon-next-dev.png"

# The Den palette's amber accent, converted from the CSS tokens the UI uses:
# --accent: oklch(0.78 0.13 70) and --accent-fg: oklch(0.2 0.03 70) in
# src/styles/tokens.css. Both badges therefore belong to the app's own palette.
BADGE_FILL = (236, 168, 81, 255)
BADGE_OUTLINE = (31, 19, 6, 255)
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

# The source artwork contains a narrow vertical highlight behind the left
# chevron. These coordinates name that strip in its 1024px master. Replacing
# its dark pixels from the adjacent background keeps the chevron's white,
# anti-aliased edges intact while removing the line at every generated size.
SOURCE_REFERENCE_SIZE = 1024
HIGHLIGHT_X = (320, 334)
HIGHLIGHT_Y = (408, 608)
HIGHLIGHT_COPY_OFFSET = 20
HIGHLIGHT_MAX_CHANNEL = 180

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
    downsamples; the source ICNS carries a 1024px master (the ``ic10`` entry),
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
        # Only the PNG entries matter: legacy raw-bitmap and mask entries top
        # out at 128px, so they could never be the largest anyway.
        if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
            continue
        image = Image.open(BytesIO(payload)).convert("RGBA")
        if best is None or image.width > best.width:
            best = image
    if best is None:
        raise SystemExit(f"{path} holds no PNG entry to badge")
    return best


def remove_vertical_highlight(icon: Image.Image) -> Image.Image:
    """Remove the source icon's stray line without touching the logo edges."""
    cleaned = icon.copy()
    scale = icon.width / SOURCE_REFERENCE_SIZE
    left, right = (round(value * scale) for value in HIGHLIGHT_X)
    top, bottom = (round(value * scale) for value in HIGHLIGHT_Y)
    offset = max(1, round(HIGHLIGHT_COPY_OFFSET * scale))
    for x in range(left, right):
        source_x = x - offset
        for y in range(top, bottom):
            pixel = icon.getpixel((x, y))
            if max(pixel[:3]) < HIGHLIGHT_MAX_CHANNEL:
                cleaned.putpixel((x, y), icon.getpixel((source_x, y)))
    return cleaned


def load_font(pixel_size: int) -> ImageFont.FreeTypeFont:
    for candidate, index in FONT_CANDIDATES:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, pixel_size, index=index)
    tried = "\n  ".join(path for path, _ in FONT_CANDIDATES)
    raise SystemExit(f"no bold sans font found. Looked for:\n  {tried}")


def fit_letter(letter: str, target_cap_height: float) -> tuple[ImageFont.FreeTypeFont, tuple[int, int, int, int]]:
    """Find the font size whose letter is ``target_cap_height`` pixels tall."""
    probe = 100
    box = load_font(probe).getbbox(letter)
    cap_at_probe = box[3] - box[1]
    if cap_at_probe <= 0:
        raise SystemExit(f'the chosen font renders "{letter}" as nothing')
    size = max(1, round(target_cap_height * probe / cap_at_probe))
    font = load_font(size)
    while size > 1 and font.getbbox(letter)[3] - font.getbbox(letter)[1] > target_cap_height:
        size -= 1
        font = load_font(size)
    return font, font.getbbox(letter)


def badge(icon: Image.Image, letter: str) -> Image.Image:
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

    font, glyph = fit_letter(letter, size * LETTER_CAP_HEIGHT)
    # Centre the glyph by its ink box, not by its metrics box: bearings and
    # descender space would push the letter off-centre otherwise.
    ink_width = glyph[2] - glyph[0]
    ink_height = glyph[3] - glyph[1]
    x = box[0] + (size - ink_width) / 2 - glyph[0]
    y = box[1] + (size - ink_height) / 2 - glyph[1]
    draw.text((x, y), letter, font=font, fill=LETTER_FILL)

    # Downsample the badge alone and composite at native resolution, so the
    # source art comes through untouched outside the badge.
    badged = icon.convert("RGBA").copy()
    badged.alpha_composite(layer.resize((icon.width, icon.height), Image.LANCZOS))
    return badged


def write(icon: Image.Image, letter: str, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    badge(icon, letter).save(output, "PNG", optimize=True)
    print(f'wrote {output} ({icon.width}x{icon.height}) with badge "{letter}"')


def main(argv: list[str]) -> int:
    source = Path(argv[1]) if len(argv) > 1 else DEFAULT_SOURCE
    if not source.exists():
        raise SystemExit(f"no source icon at {source}")
    icon = remove_vertical_highlight(load_source(source))
    write(icon, "N", RELEASE_OUTPUT)
    write(icon, "D", DEV_OUTPUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
