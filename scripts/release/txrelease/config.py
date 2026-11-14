"""Where a release lives: its version, its working directory, the build output and the asset names.

Nothing here is specific to one machine. The version comes from the repository, the working
directory is the git-ignored ``.raccoon/release-<version>`` and the Cargo target directory is under
the current user's cache folder unless ``TERMINALX_RELEASE_TARGET_DIR`` points elsewhere.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

REPO = 'terminalx-ai/terminalx'
ARCH = 'aarch64'
PLATFORM = 'darwin-aarch64'
BUNDLE_IDENTIFIER = 'com.terminalx.next'
ARCHIVE = 'TerminalX.app.tar.gz'
SIGNATURE = ARCHIVE + '.sig'
MANIFEST = 'latest.json'
CHECKSUMS = 'SHA256SUMS'
# A second copy of the DMG under a name that never changes, so that
# /releases/latest/download/<this name> always resolves to the newest notarized build.
LATEST_DMG = f'TerminalX-latest-{ARCH}.dmg'
STABLE_DOWNLOAD_URL = f'https://github.com/{REPO}/releases/latest/download/{LATEST_DMG}'


class ReleaseError(SystemExit):
    """A release step refused to go on. The message says what is wrong and what to do."""

    def __init__(self, message: str):
        super().__init__(f'release: {message}')


def dmg_name(version: str) -> str:
    return f'TerminalX_{version}_{ARCH}.dmg'


def asset_names(version: str) -> set[str]:
    return {dmg_name(version), LATEST_DMG, ARCHIVE, SIGNATURE, MANIFEST, CHECKSUMS}


def read_versions(root: Path) -> dict[str, str]:
    """The version in each of the three files that must agree (docs/RELEASING.md, Cut a version)."""
    package = json.loads((root / 'package.json').read_text())['version']
    tauri = json.loads((root / 'src-tauri/tauri.conf.json').read_text())['version']
    cargo_text = (root / 'src-tauri/Cargo.toml').read_text()
    package_section = cargo_text.split('[package]', 1)[1].split('\n[', 1)[0]
    match = re.search(r'^version\s*=\s*"([^"]+)"', package_section, re.M)
    if not match:
        raise ReleaseError('src-tauri/Cargo.toml has no [package] version')
    return {'package.json': package, 'src-tauri/tauri.conf.json': tauri, 'src-tauri/Cargo.toml': match.group(1)}


def updater_feed(root: Path) -> str:
    endpoints = json.loads((root / 'src-tauri/tauri.conf.json').read_text())['plugins']['updater']['endpoints']
    if len(endpoints) != 1:
        raise ReleaseError(f'expected one updater endpoint in tauri.conf.json, found {len(endpoints)}')
    return endpoints[0]


@dataclass(frozen=True)
class Release:
    root: Path
    version: str
    out: Path
    target_dir: Path

    @property
    def tag(self) -> str:
        return 'v' + self.version

    @property
    def dmg_name(self) -> str:
        return dmg_name(self.version)

    @property
    def bundle(self) -> Path:
        return self.target_dir / 'release/bundle'

    @property
    def built_dmg(self) -> Path:
        return self.bundle / 'dmg' / self.dmg_name

    @property
    def built_app(self) -> Path:
        return self.bundle / 'macos/TerminalX.app'

    @property
    def built_archive(self) -> Path:
        return self.bundle / 'macos' / ARCHIVE

    @property
    def assets(self) -> Path:
        return self.out / 'assets'

    @property
    def archive_url(self) -> str:
        return f'https://github.com/{REPO}/releases/download/{self.tag}/{ARCHIVE}'

    @property
    def feed_url(self) -> str:
        return updater_feed(self.root)

    def record(self, name: str) -> Path:
        return self.out / name


def load(root: Path, env: Mapping[str, str] = os.environ) -> Release:
    versions = read_versions(root)
    if len(set(versions.values())) != 1:
        found = ', '.join(f'{file} {version}' for file, version in versions.items())
        raise ReleaseError(f'the three version files disagree ({found}); bump all three (docs/RELEASING.md, Cut a version)')
    version = next(iter(versions.values()))
    target = env.get('TERMINALX_RELEASE_TARGET_DIR')
    target_dir = Path(target).expanduser() if target else Path.home() / 'Library/Caches' / f'terminalx-release-{version}'
    return Release(root=root, version=version, out=root / '.raccoon' / f'release-{version}', target_dir=target_dir)
