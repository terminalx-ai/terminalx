"""Build, verify and launch a standalone iOS simulator app with working Keychain access."""

import argparse
import json
import platform
import plistlib
import struct
import subprocess
import sys
from pathlib import Path


MOBILE = Path(__file__).resolve().parents[1]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, cwd=MOBILE, **kwargs)


def verify_app(app):
    info = plistlib.loads((app / "Info.plist").read_bytes())
    if info.get("CFBundleSupportedPlatforms") != ["iPhoneSimulator"]:
        raise ValueError("Expected an iOS simulator app")
    binary = (app / info["CFBundleExecutable"]).read_bytes()
    # This build uses only the host architecture. Simulator entitlements live in
    # a Mach-O section; codesign --entitlements can show an empty plist instead.
    if binary[:4] != b"\xcf\xfa\xed\xfe":
        raise ValueError("Expected a thin, little-endian 64-bit simulator executable")
    command_offset = 32
    for _ in range(struct.unpack_from("<I", binary, 16)[0]):
        command, command_size = struct.unpack_from("<II", binary, command_offset)
        if command == 0x19:  # LC_SEGMENT_64
            section_count = struct.unpack_from("<I", binary, command_offset + 64)[0]
            for index in range(section_count):
                section = command_offset + 72 + index * 80
                name = binary[section:section + 16].rstrip(b"\0")
                segment = binary[section + 16:section + 32].rstrip(b"\0")
                if (segment, name) != (b"__TEXT", b"__entitlements"):
                    continue
                size, offset = struct.unpack_from("<QI", binary, section + 40)
                entitlements = plistlib.loads(binary[offset:offset + size].rstrip(b"\0"))
                identifier = entitlements.get("application-identifier", "")
                bundle = info["CFBundleIdentifier"]
                if identifier == bundle or identifier.endswith("." + bundle):
                    print(f"Verified simulator Keychain entitlement: {identifier}", flush=True)
                    return bundle
        command_offset += command_size
    raise ValueError(
        "Simulator app is missing its Keychain application-identifier. "
        "Rebuild with CODE_SIGNING_ALLOWED=YES and CODE_SIGN_IDENTITY=-; "
        "CODE_SIGNING_ALLOWED=NO breaks SecureStore pairing."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", help="Simulator UDID; defaults to the only booted iPhone")
    parser.add_argument("--derived-data", type=Path, default=MOBILE / "dist/simulator-build")
    parser.add_argument("--verify-only", type=Path, metavar="APP", help="Check an existing .app without installing it")
    args = parser.parse_args()
    if args.verify_only:
        verify_app(args.verify_only.resolve())
        return

    devices = json.loads(run("xcrun", "simctl", "list", "devices", "available", "--json", capture_output=True).stdout)
    candidates = [
        device for runtime, entries in devices["devices"].items()
        if ".iOS-" in runtime
        for device in entries
        if (device["udid"] == args.device if args.device else
            device["state"] == "Booted" and device["name"].startswith("iPhone"))
    ]
    if len(candidates) != 1:
        raise ValueError("Boot one iPhone in Simulator, or select one with --device <UDID> (xcrun simctl list devices available)")
    device = candidates[0]
    if device["state"] != "Booted":
        run("xcrun", "simctl", "boot", device["udid"])
    run("open", "-a", "Simulator")
    run("xcrun", "simctl", "bootstatus", device["udid"], "-b")

    workspace = MOBILE / "ios/TerminalX.xcworkspace"
    if not workspace.exists():
        run("pnpm", "exec", "expo", "prebuild", "--platform", "ios")
    derived = args.derived_data.resolve()
    # Ad-hoc simulator signing needs no Apple certificate or paid team, but must
    # remain enabled so Xcode embeds the identity used by Simulator's Keychain.
    run(
        "xcodebuild", "-workspace", str(workspace), "-scheme", "TerminalX",
        "-configuration", "Release", "-destination", f"id={device['udid']}",
        "-derivedDataPath", str(derived), f"ARCHS={platform.machine()}",
        "ONLY_ACTIVE_ARCH=YES", "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-",
        "DEVELOPMENT_TEAM=", "build",
    )
    app = derived / "Build/Products/Release-iphonesimulator/TerminalX.app"
    bundle = verify_app(app)
    run("xcrun", "simctl", "install", device["udid"], str(app))
    run("xcrun", "simctl", "launch", "--terminate-running-process", device["udid"], bundle)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Simulator build failed: {error}", file=sys.stderr)
        sys.exit(1)
