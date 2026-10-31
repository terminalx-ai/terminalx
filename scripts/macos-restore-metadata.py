#!/usr/bin/env python3
"""Inspect Apple's restore *metadata* without downloading or enrolling an IPSW.

The Apple feed is a current-release discovery source, not a versioned API or
proof of image bytes. Offline input has explicitly unverified origin. Output is
an investigation report, deliberately incompatible with the runtime catalog.
"""
import argparse
import hashlib
import json
import plistlib
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

CATALOG_URL = "https://mesu.apple.com/assets/macos/com_apple_macOSIPSW/com_apple_macOSIPSW.xml"
LIMIT = 2 * 1024 * 1024
MODEL = "VirtualMac2,1"
MAJOR = 26


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ValueError("Metadata URL redirected; review the new origin separately")


def fetch_metadata():
    # Fixed metadata endpoint only; no request to FirmwareURL or an IPSW URL.
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(CATALOG_URL, timeout=15) as response:
        if response.status != 200 or response.url != CATALOG_URL:
            raise ValueError("Original Apple metadata endpoint required")
        return response.read(LIMIT + 1)


def inspect_metadata(raw, fetched=False):
    if len(raw) > LIMIT:
        raise ValueError("Restore metadata exceeds bound")
    data = plistlib.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Apple restore metadata must be a dictionary")
    versions = data.get("MobileDeviceSoftwareVersionsByVersion")
    if not isinstance(versions, dict):
        raise ValueError("Apple restore metadata structure is missing")
    records = []

    def collect(value, path, depth=0):
        if depth > 12:
            raise ValueError("Unexpected restore metadata nesting")
        if not isinstance(value, dict):
            raise ValueError("Unexpected restore metadata record")
        if any(key in value for key in ("FirmwareURL", "ProductVersion", "BuildVersion")):
            records.append((path, value))
        else:
            for key, child in value.items():
                if isinstance(child, dict):
                    collect(child, path + [key], depth + 1)

    for version, group in versions.items():
        devices = group.get("MobileDeviceSoftwareVersions") if isinstance(group, dict) else None
        if not isinstance(devices, dict):
            raise ValueError("Apple device metadata structure is missing")
        if MODEL in devices:
            collect(devices[MODEL], [version, "MobileDeviceSoftwareVersions", MODEL])
    observed, candidates = set(), {}
    for path, record in records:
        version, build, url = (record.get(k) for k in ("ProductVersion", "BuildVersion", "FirmwareURL"))
        if not isinstance(version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", version):
            raise ValueError("Explicit numeric macOS version required")
        observed.add(version)
        if int(version.split(".")[0]) != MAJOR:
            continue
        if not isinstance(build, str) or not re.fullmatch(r"[A-Za-z0-9]+", build):
            raise ValueError("Explicit restore build required")
        if not isinstance(url, str):
            raise ValueError("Explicit Apple restore URL required")
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != "https" or parsed.hostname not in {"updates.cdn-apple.com", "appldnld.apple.com"}
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443) or parsed.query or parsed.fragment
                or not parsed.path.endswith(".ipsw")):
            raise ValueError("Unambiguous Apple HTTPS IPSW URL required")
        sha1 = record.get("FirmwareSHA1")
        if sha1 is not None and (not isinstance(sha1, str) or not re.fullmatch(r"[a-fA-F0-9]{40}", sha1)):
            raise ValueError("Malformed publisher SHA1 metadata")
        key = (version, build)
        candidate = {"macosVersion": version, "build": build, "url": url,
                     "publisherSha1": sha1.lower() if sha1 else None,
                     "verifiedImageSha256": None, "verifiedImageBytes": None}
        if key in candidates and candidates[key] != candidate:
            raise ValueError("Conflicting restore metadata for the same version/build")
        candidates[key] = candidate
    return {"reportVersion": 1, "kind": "appleRestoreMetadataObservation",
            "source": CATALOG_URL if fetched else "offline-input-origin-unverified",
            "metadataSha256": hashlib.sha256(raw).hexdigest(),
            "requestedMacosMajor": MAJOR, "model": MODEL,
            "observedVersions": sorted(observed), "candidates": list(candidates.values()),
            "result": "candidates-require-image-validation" if candidates else "no-macos26-candidate",
            "imageDownloaded": False, "imageAuthenticated": False, "catalogEntryEligible": False,
            "requiredBeforeEnrollment": ["Apple-origin version26 source evidence", "complete image byte size and independently computed SHA256",
                                         "Apple Virtualization local image metadata and supported configuration", "reviewed immutable catalog change"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--catalog", type=Path, help="Inspect a retained metadata plist; no network")
    source.add_argument("--fetch", action="store_true", help="Read only the fixed Apple metadata endpoint")
    args = parser.parse_args()
    try:
        if args.fetch:
            raw = fetch_metadata()
        else:
            with args.catalog.open("rb") as file:
                raw = file.read(LIMIT + 1)
        print(json.dumps(inspect_metadata(raw, fetched=args.fetch), indent=2))
        return 0
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        print(json.dumps({"result": "metadata-refused", "detail": str(error), "catalogEntryEligible": False}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
