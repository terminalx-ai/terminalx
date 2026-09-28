#!/usr/bin/env python3
"""Verify the icons selected by an iOS/macOS .app's Info.plist (Pillow required).

Read-only: never changes a signed bundle or refreshes system icon caches.
"""

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageStat


REPO = Path(__file__).resolve().parents[1]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_png(path):
    # Device builds contain Apple's CgBI PNGs, which Pillow cannot decode.
    # Revert the optimization into a temporary file, preserving the artifact.
    if path.read_bytes()[12:16] == b"CgBI":
        with tempfile.TemporaryDirectory(prefix="terminalx-png-") as temporary:
            decoded = Path(temporary) / "icon.png"
            subprocess.run(["xcrun", "pngcrush", "-q", "-revert-iphone-optimizations",
                            str(path), str(decoded)], check=True, capture_output=True)
            with Image.open(decoded) as image:
                return image.convert("RGBA")
    with Image.open(path) as image:
        return image.convert("RGBA")


def verify_mobile_png(path, source, development):
    image = read_png(path)
    require(image.width == image.height and image.width >= 20,
            f"{path.name}: expected a square launcher icon")
    require(image.getchannel("A").getextrema() == (255, 255),
            f"{path.name}: mobile icon must be opaque")
    require(any(low != high for low, high in image.convert("RGB").getextrema()),
            f"{path.name}: solid-color placeholder")
    for point in ((0, 0), (0, image.height - 1),
                  (image.width - 1, 0), (image.width - 1, image.height - 1)):
        require(max(image.getpixel(point)[:3]) < 50,
                f"{path.name}: expected full-bleed dark corners")
    orange = sum(r > 220 and 70 < g < 150 and b < 70 for r, g, b in image.convert("RGB").getdata())
    require((orange > image.width * image.height * 0.01) == development,
            f"{path.name}: incorrect development badge")
    expected = source.resize(image.size, Image.Resampling.LANCZOS).convert("RGB")
    error = max(ImageStat.Stat(ImageChops.difference(image.convert("RGB"), expected)).mean)
    # actool's resampling/color conversion differs slightly from Pillow.
    require(error < 8, f"{path.name}: artwork differs from expected variant (mean error {error:.2f})")
    return {"file": path.name, "sha256": sha256(path), "size": list(image.size),
            "meanPixelError": round(error, 3)}


def verify_app(app, platform, variant="production", expected_bundle_id=None):
    app = Path(app).resolve()
    development = variant == "development"
    plist = app / ("Contents/Info.plist" if platform == "macos" else "Info.plist")
    info = plistlib.loads(plist.read_bytes())
    default_id = ("com.terminalx.next.dev" if development else "com.terminalx.next") if platform == "macos" else "com.terminalx.next.mobile"
    require(info.get("CFBundleIdentifier") == (expected_bundle_id or default_id),
            f"Unexpected bundle identifier: {info.get('CFBundleIdentifier')}")
    report = {"platform": platform, "expectedVariant": variant,
              "bundleIdentifier": info["CFBundleIdentifier"],
              "version": info.get("CFBundleShortVersionString"),
              "build": info.get("CFBundleVersion"), "infoPlistSha256": sha256(plist)}
    if platform == "macos":
        name = info.get("CFBundleIconFile")
        require(isinstance(name, str) and Path(name).name == name, "Missing/invalid CFBundleIconFile")
        resource = app / "Contents/Resources" / (name if name.endswith(".icns") else name + ".icns")
        expected = REPO / ("src-tauri/icons-dev/icon.icns" if development else "resources/icon-source/legacy.icns")
        require(resource.read_bytes() == expected.read_bytes(), "Selected desktop ICNS differs from expected variant/Legacy")
        report["icons"] = [{"file": resource.name, "sha256": sha256(resource)}]
    else:
        require(any(p in ("iPhoneOS", "iPhoneSimulator") for p in info.get("CFBundleSupportedPlatforms", [])),
                "Expected an iOS app")
        source = read_png(REPO / "mobile/assets" / ("icon-dev.png" if development else "icon.png"))
        names = []
        for key in ("CFBundleIcons", "CFBundleIcons~ipad"):
            if key != "CFBundleIcons" and key not in info:
                continue
            primary = info.get(key, {}).get("CFBundlePrimaryIcon", {})
            files = primary.get("CFBundleIconFiles", [])
            require(files, f"{key}: missing primary icon files; cannot verify packaged pixels")
            names.extend(files)
        icons = set()
        for name in names:
            require(isinstance(name, str) and Path(name).name == name, "Invalid primary icon filename")
            stem = name.removesuffix(".png")
            matches = [p for p in app.glob("*.png") if p.stem == stem or
                       p.stem.startswith(stem + "@") or p.stem.startswith(stem + "~")]
            require(matches, f"Primary icon {name} has no packaged PNG; cannot verify pixels")
            icons.update(matches)
        report["icons"] = [verify_mobile_png(p, source, development) for p in sorted(icons)]
        catalog = app / "Assets.car"
        require(catalog.is_file(), "Missing compiled Assets.car")
        report["assetsCarSha256"] = sha256(catalog)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=("ios", "macos"))
    parser.add_argument("app", type=Path, help="Built, extracted, or installed .app")
    parser.add_argument("--variant", choices=("production", "development"), default="production")
    parser.add_argument("--bundle-id", help="Expected identity override, e.g. for comparison with Legacy")
    args = parser.parse_args()
    try:
        print(json.dumps(verify_app(args.app, args.platform, args.variant, args.bundle_id), indent=2))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Icon verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
