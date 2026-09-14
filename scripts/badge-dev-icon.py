#!/usr/bin/env python3
"""Regenerate desktop and mobile icons from the vendored Legacy artwork.

Run on macOS with Pillow and the repo's pnpm dependencies installed:
    python3 scripts/badge-dev-icon.py

Legacy's ICNS already contains trimmed 16/32/64px slots and inset large slots.
Keep it verbatim for release; badge each native slot for dev. Tauri generates
Windows/Linux assets from a trimmed master and mobile assets from full-bleed
artwork, never from the macOS master. See docs/RELEASING.md for Expo prebuild.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "resources/icon-source/legacy.icns"
MOBILE = REPO / "mobile/assets"
# Measured from Legacy resources/icon-dev.png: a 58px orange disc centred at
# (218, 218) on a 256px canvas. No border; the disc overhangs the tile corner.
BADGE_FILL = (255, 107, 43, 255)
BADGE_SIZE = 58 / 256
BADGE_MARGIN = 9 / 256
LETTER_CAP_HEIGHT = 25 / 58
SUPERSAMPLE = 4
FONT_CANDIDATES = (
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
    ("/System/Library/Fonts/Helvetica.ttc", 1),
)


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



def badge(icon: Image.Image, *, mobile: bool = False, adaptive: bool = False) -> Image.Image:
    """Stamp Legacy's orange D, keeping mobile badges inside the system mask."""
    canvas = icon.width * SUPERSAMPLE
    # Adaptive foregrounds have a smaller safe area. Keep the whole badge
    # inside its central circle so Android launchers cannot crop away the D.
    fraction = 0.15 if adaptive else BADGE_SIZE
    margin = 0.27 if adaptive else (0.12 if mobile else BADGE_MARGIN)
    size = round(canvas * fraction)
    right = round(canvas * (1 - margin))
    box = (right - size, right - size, right - 1, right - 1)
    layer = Image.new("RGBA", (canvas, canvas))
    draw = ImageDraw.Draw(layer)
    draw.ellipse(box, fill=BADGE_FILL)
    font, glyph = fit_letter("D", size * LETTER_CAP_HEIGHT)
    x = box[0] + (size - glyph[2] + glyph[0]) / 2 - glyph[0]
    y = box[1] + (size - glyph[3] + glyph[1]) / 2 - glyph[1]
    draw.text((x, y), "D", font=font, fill="white")
    result = icon.convert("RGBA").copy()
    result.alpha_composite(layer.resize(icon.size, Image.Resampling.LANCZOS))
    return result


def trim(icon: Image.Image) -> Image.Image:
    """Port Legacy's -trim, -resize, centred -extent (including soft shadow)."""
    cropped = icon.crop(icon.getchannel("A").getbbox())
    fitted = ImageOps.contain(cropped, icon.size, Image.Resampling.LANCZOS)
    result = Image.new("RGBA", icon.size)
    result.alpha_composite(fitted, ((icon.width - fitted.width) // 2,
                                   (icon.height - fitted.height) // 2))
    return result


def save(icon: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    icon.save(path, "PNG", optimize=True)


def run(*args: str) -> None:
    subprocess.run(args, cwd=REPO, check=True)


def generate() -> None:
    # Fail before touching outputs if a build dependency is missing.
    for command in ("iconutil", "pnpm"):
        if not shutil.which(command):
            raise SystemExit(f"{command} is required; see docs/RELEASING.md")
    load_font(100)
    mobile = Image.open(MOBILE / "icon.png").convert("RGBA")
    adaptive = Image.open(MOBILE / "adaptive-icon.png").convert("RGBA")
    save(badge(mobile, mobile=True).convert("RGB"), MOBILE / "icon-dev.png")
    save(badge(adaptive, adaptive=True), MOBILE / "adaptive-icon-dev.png")

    with tempfile.TemporaryDirectory(prefix="terminalx-icons-") as temporary:
        tmp = Path(temporary)
        iconset = tmp / "legacy.iconset"
        run("iconutil", "-c", "iconset", str(SOURCE), "-o", str(iconset))
        master = Image.open(iconset / "icon_512x512@2x.png").convert("RGBA")
        devset = tmp / "dev.iconset"
        devset.mkdir()
        for path in sorted(iconset.glob("*.png")):
            slot = badge(Image.open(path).convert("RGBA"))
            save(trim(slot) if slot.width <= 64 else slot, devset / path.name)

        for dev in (False, True):
            output = REPO / "src-tauri" / ("icons-dev" if dev else "icons")
            output.mkdir(parents=True, exist_ok=True)
            desktop = badge(master) if dev else master
            save(desktop, output / ("app-icon-dev.png" if dev else "app-icon.png"))
            desktop_source = tmp / "desktop.png"
            save(trim(desktop), desktop_source)
            generated = tmp / ("dev" if dev else "release")
            run("pnpm", "tauri", "icon", str(desktop_source), "--output", str(generated))
            # Keep only desktop outputs from this pass; never publish the
            # white-backed mobile icons Tauri derives from transparent tiles.
            for path in generated.iterdir():
                if path.is_file() and path.suffix in (".png", ".ico"):
                    shutil.copyfile(path, output / path.name)
            if dev:
                run("iconutil", "-c", "icns", str(devset), "-o", str(output / "icon.icns"))
            else:
                shutil.copyfile(SOURCE, output / "icon.icns")

            manifest = tmp / "mobile.json"
            manifest.write_text(json.dumps({
                "default": str(MOBILE / ("icon-dev.png" if dev else "icon.png")),
                "bg_color": "#111111",
                "android_fg": str(MOBILE / ("adaptive-icon-dev.png" if dev else "adaptive-icon.png")),
                # Legacy's foreground already includes Android's safe area.
                "android_fg_scale": 100,
            }))
            run("pnpm", "tauri", "icon", str(manifest), "--output", str(generated))
            for platform in ("ios", "android"):
                shutil.copytree(generated / platform, output / platform, dirs_exist_ok=True)
            # Retire the old N-badged master names so they cannot be reused.
            obsolete = output / ("app-icon-next-dev.png" if dev else "app-icon-next.png")
            obsolete.unlink(missing_ok=True)
    print("Regenerated release/dev desktop and mobile icons. Run Expo prebuild to refresh Xcode.")


if __name__ == "__main__":
    generate()
