#!/usr/bin/env python3
"""Check the shipped assets for issue #156 (macOS, Pillow, pnpm required)."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from PIL import Image, ImageChops


REPO = Path(__file__).resolve().parents[1]
CATALOG = REPO / "mobile/ios/TerminalX/Images.xcassets/AppIcon.appiconset"


def rgba(path):
    with Image.open(path) as image:
        return image.convert("RGBA")


def opaque_bounds(image):
    return image.getchannel("A").point(lambda alpha: 255 if alpha >= 128 else 0).getbbox()


def orange_count(image):
    return sum(r > 220 and 70 < g < 150 and b < 70 and a > 200
               for r, g, b, a in image.getdata())


class IconAssetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="terminalx-icon-check-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.iconsets = {}
        for variant in ("icons", "icons-dev"):
            output = Path(cls.temporary.name) / f"{variant}.iconset"
            subprocess.run(["iconutil", "-c", "iconset",
                            str(REPO / "src-tauri" / variant / "icon.icns"),
                            "-o", str(output)], check=True)
            cls.iconsets[variant] = output

    def test_release_is_exact_legacy_icns_without_badge(self):
        self.assertEqual((REPO / "resources/icon-source/legacy.icns").read_bytes(),
                         (REPO / "src-tauri/icons/icon.icns").read_bytes())
        for path in self.iconsets["icons"].glob("*.png"):
            self.assertEqual(orange_count(rgba(path)), 0, path.name)

    def test_small_finder_slots_fill_the_tile(self):
        for variant, iconset in self.iconsets.items():
            for name in ("icon_16x16.png", "icon_16x16@2x.png",
                         "icon_32x32.png", "icon_32x32@2x.png"):
                with self.subTest(variant=variant, slot=name):
                    image = rgba(iconset / name)
                    left, top, right, bottom = opaque_bounds(image)
                    allowance = max(1, round(image.width * 0.05))
                    self.assertLessEqual(max(left, top), allowance)
                    self.assertGreaterEqual(min(right, bottom), image.width - allowance)

    def test_large_macos_slots_keep_inset_and_dev_badge_overhangs(self):
        for variant, iconset in self.iconsets.items():
            for path in iconset.glob("*.png"):
                image = rgba(path)
                if image.width < 128:
                    continue
                with self.subTest(variant=variant, slot=path.name):
                    left, top, right, bottom = opaque_bounds(image)
                    self.assertGreaterEqual(min(left, top), image.width * 0.08)
                    if variant == "icons-dev":
                        self.assertGreater(orange_count(image), image.width ** 2 * 0.02)
                        self.assertGreater(min(right, bottom), image.width * 0.95)
                    else:
                        self.assertLessEqual(max(right, bottom), image.width * 0.92)

    def test_linux_pngs_and_every_windows_frame_are_trimmed(self):
        for variant in self.iconsets:
            directory = REPO / "src-tauri" / variant
            images = [(p.name, rgba(p)) for p in directory.glob("*.png")
                      if not p.name.startswith("app-icon")]
            with Image.open(directory / "icon.ico") as ico:
                images.extend((f"ICO {size}", ico.ico.getimage(size).convert("RGBA"))
                              for size in ico.ico.sizes())
            for name, image in images:
                with self.subTest(variant=variant, image=name):
                    left, top, right, bottom = opaque_bounds(image)
                    self.assertGreaterEqual(min(right - left, bottom - top), image.width * 0.87)

    def test_mobile_ios_has_opaque_dark_corners_and_correct_badges(self):
        for variant in self.iconsets:
            for path in (REPO / "src-tauri" / variant / "ios").glob("*.png"):
                with self.subTest(path=path):
                    image = rgba(path)
                    self.assertEqual(image.getchannel("A").getextrema(), (255, 255))
                    for x, y in ((0, 0), (0, image.height - 1),
                                 (image.width - 1, 0), (image.width - 1, image.height - 1)):
                        self.assertLess(max(image.getpixel((x, y))[:3]), 50)
                    self.assertEqual(orange_count(image) > 0, variant == "icons-dev")

    def test_android_uses_dark_background_and_safe_foreground(self):
        for variant in self.iconsets:
            directory = REPO / "src-tauri" / variant / "android"
            self.assertIn("#111111", (directory / "values/ic_launcher_background.xml").read_text())
            for path in directory.glob("mipmap-*/ic_launcher_foreground.png"):
                image = rgba(path)
                self.assertEqual(image.getpixel((0, 0))[3], 0)
                self.assertEqual(orange_count(image) > 0, variant == "icons-dev")

    def test_committed_xcode_catalog_uses_release_mobile_artwork(self):
        contents = json.loads((CATALOG / "Contents.json").read_text())
        entries = [entry for entry in contents["images"] if "filename" in entry]
        self.assertTrue(entries)
        source = rgba(REPO / "mobile/assets/icon.png")
        for entry in entries:
            image = rgba(CATALOG / entry["filename"])
            expected = source.resize(image.size, Image.Resampling.LANCZOS)
            self.assertIsNone(ImageChops.difference(image, expected).getbbox(alpha_only=False))

    def test_expo_resolves_release_and_development_icons(self):
        for variant in ("production", "development"):
            result = subprocess.run(
                ["pnpm", "exec", "expo", "config", "--type", "public", "--json"],
                cwd=REPO / "mobile", env={**os.environ, "APP_VARIANT": variant},
                check=True, capture_output=True, text=True,
            )
            config = json.loads(result.stdout)
            suffix = "-dev" if variant == "development" else ""
            self.assertEqual(config["icon"], f"./assets/icon{suffix}.png")
            self.assertEqual(config["android"]["adaptiveIcon"]["foregroundImage"],
                             f"./assets/adaptive-icon{suffix}.png")
            self.assertTrue((REPO / "mobile" / config["icon"]).is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
