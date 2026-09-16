#!/usr/bin/env python3
"""Integration check: Expo variant switches through Apple's asset compiler.

Requires macOS, Xcode with a compatible installed simulator runtime, pnpm and Pillow.
Uses an isolated native project; never modifies the checkout's release catalog.
"""

import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

from verify_packaged_icons import REPO, verify_app


def run(*args, **kwargs):
    result = subprocess.run(*args, capture_output=True, text=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f"Command failed: {result.args}\n{result.stdout}\n{result.stderr}")
    return result


class CompiledIconsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="terminalx-compiled-icons-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.apps = {}
        project = cls.root / "mobile"
        project.mkdir()
        for name in ("package.json", "app.json", "app.config.js"):
            shutil.copy(REPO / "mobile" / name, project / name)
        shutil.copytree(REPO / "mobile/assets", project / "assets")
        (project / "node_modules").symlink_to(REPO / "mobile/node_modules", target_is_directory=True)
        for variant in ("production", "development", "production"):
            env = {**os.environ, "APP_VARIANT": variant, "CI": "1"}
            run([str(project / "node_modules/.bin/expo"), "prebuild", "--platform", "ios",
                 "--no-install", "--no-clean"], cwd=project, env=env)
            config = json.loads(run(
                [str(project / "node_modules/.bin/expo"), "config", "--type", "public", "--json"],
                cwd=project, env=env).stdout)
            app = cls.root / f"{variant}.app"
            if app.exists():
                shutil.rmtree(app)
            app.mkdir()
            run([
                "xcrun", "actool", str(project / "ios/TerminalX/Images.xcassets"),
                "--compile", str(app), "--platform", "iphoneos",
                "--minimum-deployment-target", "16.0", "--target-device", "iphone",
                "--app-icon", "AppIcon", "--output-partial-info-plist", str(app / "Info.plist"),
            ])
            info = plistlib.loads((app / "Info.plist").read_bytes())
            info.update(CFBundleIdentifier=config["ios"]["bundleIdentifier"],
                        CFBundleSupportedPlatforms=["iPhoneOS"],
                        CFBundleShortVersionString=config["version"], CFBundleVersion="test")
            (app / "Info.plist").write_bytes(plistlib.dumps(info))
            # These are compiled catalog fixtures, not runnable application builds.
            verify_app(app, "ios", variant)
            cls.apps[variant] = app

    def test_both_compiled_variants(self):
        for variant, app in self.apps.items():
            with self.subTest(variant=variant):
                self.assertTrue(verify_app(app, "ios", variant)["icons"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
