#!/usr/bin/env python3
"""Regression tests for rejecting incorrect assets selected by packaged metadata."""

from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

from PIL import Image

from verify_packaged_icons import REPO, verify_app


class PackagedIconsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="terminalx-icon-fixtures-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.apps = {}
        for variant in ("production", "development"):
            app = cls.root / f"{variant}.app"
            app.mkdir()
            source = REPO / "mobile/assets" / ("icon-dev.png" if variant == "development" else "icon.png")
            with Image.open(source) as image:
                image.resize((120, 120), Image.Resampling.LANCZOS).save(app / "AppIcon60x60@2x.png")
            (app / "Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "com.terminalx.next.mobile",
                "CFBundleSupportedPlatforms": ["iPhoneOS"],
                "CFBundleIcons": {"CFBundlePrimaryIcon": {"CFBundleIconFiles": ["AppIcon60x60"]}},
            }))
            (app / "Assets.car").write_bytes(b"unit test fixture; integration tests use actool")
            cls.apps[variant] = app

    def copy_app(self, variant="production"):
        temporary = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(temporary.cleanup)
        app = Path(temporary.name) / "TerminalX.app"
        shutil.copytree(self.apps[variant], app)
        return app

    def test_release_and_dev_icons(self):
        for variant, app in self.apps.items():
            with self.subTest(variant=variant):
                result = verify_app(app, "ios", variant)
                self.assertTrue(result["icons"])
                self.assertTrue(result["assetsCarSha256"])

    def test_rejects_packaged_white_placeholder(self):
        app = self.copy_app()
        for path in app.glob("AppIcon*.png"):
            Image.new("RGB", (120, 120), "white").save(path)
        with self.assertRaisesRegex(ValueError, "solid-color placeholder"):
            verify_app(app, "ios")

    def test_apple_optimized_device_pngs_are_decoded_without_mutating_them(self):
        app = self.copy_app()
        icon = app / "AppIcon60x60@2x.png"
        original = app / "input.png"
        icon.rename(original)
        subprocess.run(["xcrun", "pngcrush", "-q", "-iphone", str(original), str(icon)],
                       check=True, capture_output=True)
        before = icon.read_bytes()
        self.assertEqual(before[12:16], b"CgBI")
        verify_app(app, "ios")
        self.assertEqual(icon.read_bytes(), before)

    def test_rejects_wrong_variant(self):
        for variant, other in (("production", "development"), ("development", "production")):
            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, "development badge"):
                verify_app(self.apps[variant], "ios", other)

    def test_rejects_missing_selected_icon_despite_other_good_pngs(self):
        app = self.copy_app()
        info = plistlib.loads((app / "Info.plist").read_bytes())
        info["CFBundleIcons"]["CFBundlePrimaryIcon"]["CFBundleIconFiles"] = ["WrongCatalog"]
        (app / "Info.plist").write_bytes(plistlib.dumps(info))
        with self.assertRaisesRegex(ValueError, "no packaged PNG"):
            verify_app(app, "ios")

    def test_rejects_wrong_bundle(self):
        with self.assertRaisesRegex(ValueError, "Unexpected bundle identifier"):
            verify_app(self.apps["production"], "ios", expected_bundle_id="wrong.bundle")

    def test_rejects_missing_compiled_catalog(self):
        app = self.copy_app()
        (app / "Assets.car").unlink()
        with self.assertRaisesRegex(ValueError, "Missing compiled Assets.car"):
            verify_app(app, "ios")

    def test_checks_ipad_primary_icon_too(self):
        app = self.copy_app()
        info = plistlib.loads((app / "Info.plist").read_bytes())
        info["CFBundleIcons~ipad"] = {"CFBundlePrimaryIcon": {"CFBundleIconFiles": ["TabletIcon"]}}
        (app / "Info.plist").write_bytes(plistlib.dumps(info))
        Image.new("RGB", (152, 152), "white").save(app / "TabletIcon@2x~ipad.png")
        with self.assertRaisesRegex(ValueError, "solid-color placeholder"):
            verify_app(app, "ios")

    def test_desktop_checks_selected_resource_not_unreferenced_legacy_copy(self):
        app = self.root / "Desktop.app"
        resources = app / "Contents/Resources"
        resources.mkdir(parents=True)
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "com.terminalx.next", "CFBundleIconFile": "selected",
        }))
        shutil.copy(REPO / "resources/icon-source/legacy.icns", resources / "selected.icns")
        verify_app(app, "macos")
        shutil.copy(resources / "selected.icns", resources / "icon.icns")
        shutil.copy(REPO / "src-tauri/icons-dev/icon.icns", resources / "selected.icns")
        with self.assertRaisesRegex(ValueError, "differs from expected"):
            verify_app(app, "macos")


if __name__ == "__main__":
    unittest.main(verbosity=2)
