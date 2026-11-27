#!/usr/bin/env python3
"""The update feeds for the Windows and Linux builds, written next to their installers.

macOS has latest.json, which scripts/release/release.py writes and checks byte for byte. Windows and
Linux each get a feed of their own, so that pipeline is never touched:

- latest-windows.json: the NSIS installer, under windows-x86_64-nsis and windows-x86_64;
- latest-linux.json: the AppImage, the deb and the rpm under linux-x86_64-{appimage,deb,rpm}, and
  the AppImage under linux-x86_64 for an install whose kind the updater cannot tell.

The updater looks up `{os}-{arch}-{installer}` first, then `{os}-{arch}`. Every installer needs its
updater signature beside it (`<installer>.sig`, from `tauri signer sign`). A feed is written for each
system whose installers are all there; a system with some of them, or with a signature missing, is an
error. The URLs point at the release of this version's tag.

    python3 scripts/release/desktop-feed.py --version 0.2.41 --repo terminalx-ai/terminalx --dir dist
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

# Each kind of installer: how its file ends, the feed it goes in, the platform keys it is listed under,
# and the fixed name a copy of it keeps (/releases/latest/download/<that name> is always the newest).
KINDS = {
    'nsis': ('-setup.exe', 'latest-windows.json', ['windows-x86_64-nsis', 'windows-x86_64'], 'TerminalX-latest-x64-setup.exe'),
    'appimage': ('.AppImage', 'latest-linux.json', ['linux-x86_64-appimage', 'linux-x86_64'], 'TerminalX-latest-amd64.AppImage'),
    'deb': ('.deb', 'latest-linux.json', ['linux-x86_64-deb'], 'TerminalX-latest-amd64.deb'),
    'rpm': ('.rpm', 'latest-linux.json', ['linux-x86_64-rpm'], 'TerminalX-latest-x86_64.rpm'),
}
FEEDS = {'latest-windows.json': ['nsis'], 'latest-linux.json': ['appimage', 'deb', 'rpm']}
CHECKSUMS = 'SHA256SUMS-desktop'


class FeedError(Exception):
    pass


def find(directory: Path) -> dict[str, Path]:
    """The one installer of each kind in ``directory`` (fixed-name copies aside)."""
    fixed = {kind[3] for kind in KINDS.values()}
    found: dict[str, Path] = {}
    for kind, (suffix, _, _, _) in KINDS.items():
        matches = sorted(p for p in directory.iterdir() if p.name.endswith(suffix) and p.name not in fixed)
        if len(matches) > 1:
            raise FeedError(f'more than one {kind} installer: {", ".join(p.name for p in matches)}')
        if matches:
            found[kind] = matches[0]
    return found


def release_url(repo: str, version: str, name: str) -> str:
    return f'https://github.com/{repo}/releases/download/v{version}/{quote(name)}'


def feeds(found: dict[str, Path], repo: str, version: str, notes: str, pub_date: str) -> dict[str, dict]:
    """Each feed whose installers are all present, keyed by its file name."""
    documents: dict[str, dict] = {}
    for feed, kinds in FEEDS.items():
        present = [kind for kind in kinds if kind in found]
        if not present:
            continue
        missing = [kind for kind in kinds if kind not in found]
        if missing:
            raise FeedError(f'{feed}: no {", ".join(missing)} installer beside {", ".join(found[k].name for k in present)}')
        platforms: dict[str, dict] = {}
        for kind in kinds:
            installer = found[kind]
            signature = installer.with_name(installer.name + '.sig')
            if not signature.is_file():
                raise FeedError(f'{installer.name} has no updater signature ({signature.name})')
            entry = {'signature': signature.read_text().strip(), 'url': release_url(repo, version, installer.name)}
            for key in KINDS[kind][2]:
                platforms[key] = entry
        documents[feed] = {'version': version, 'notes': notes, 'pub_date': pub_date, 'platforms': platforms}
    if not documents:
        raise FeedError('no Windows or Linux installer found')
    return documents


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def write(directory: Path, repo: str, version: str, notes: str | None = None, pub_date: str | None = None) -> list[str]:
    """Write the feeds, the fixed-name copies and the checksums into ``directory``. Returns every file
    to upload, the feeds last: an updater reading a feed finds everything it names already there."""
    found = find(directory)
    when = pub_date or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    documents = feeds(found, repo, version, notes or f'TerminalX {version}', when)
    uploads: list[str] = []
    for kind, installer in sorted(found.items()):
        copy = directory / KINDS[kind][3]
        shutil.copy2(installer, copy)
        uploads += [installer.name, installer.name + '.sig', copy.name]
    for feed, document in documents.items():
        (directory / feed).write_text(json.dumps(document, indent=2) + '\n')
    listed = uploads + list(documents)
    (directory / CHECKSUMS).write_text(''.join(f'{sha256(directory / name)}  {name}\n' for name in listed))
    return uploads + [CHECKSUMS] + list(documents)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--version', required=True, help='the release version, without the v')
    parser.add_argument('--repo', required=True, help='owner/name of the repository the release is in')
    parser.add_argument('--dir', required=True, type=Path, help='the folder with the installers and their .sig files')
    parser.add_argument('--notes', help='the notes the feeds carry (default "TerminalX <version>")')
    args = parser.parse_args(argv)
    try:
        for name in write(args.dir, args.repo, args.version, args.notes):
            print(name)
    except FeedError as error:
        print(f'desktop-feed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
