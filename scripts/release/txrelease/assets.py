"""The assemble step, and the checks every copy of the release assets must pass.

A release publishes six files: the versioned DMG, the same DMG under the fixed name
TerminalX-latest-aarch64.dmg (so /releases/latest/download/TerminalX-latest-aarch64.dmg is always
the newest build), the updater archive and its signature, latest.json and SHA256SUMS.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from .config import ARCHIVE, CHECKSUMS, LATEST_DMG, MANIFEST, PLATFORM, SIGNATURE, Release, asset_names
from .notarize import require_notarized
from .proc import Runner, now, require, sha256
from .source import pinned_source
from .verify import require_verified


def manifest(release: Release, signature: str, notes: str, pub_date: str) -> dict:
    return {
        'version': release.version,
        'notes': notes,
        'pub_date': pub_date,
        'platforms': {PLATFORM: {'signature': signature, 'url': release.archive_url}},
    }


def write_checksums(directory: Path, names: list[str]) -> str:
    text = ''.join(f'{sha256(directory / name)}  {name}\n' for name in names)
    (directory / CHECKSUMS).write_text(text)
    return text


def copy_assets(release: Release, assets: Path, notes: str, pub_date: str | None = None) -> None:
    """Write the six assets into ``assets`` from the build output."""
    if assets.exists():
        shutil.rmtree(assets)
    assets.mkdir(parents=True)
    shutil.copy2(release.built_dmg, assets / release.dmg_name)
    shutil.copy2(release.built_dmg, assets / LATEST_DMG)
    shutil.copy2(release.built_archive, assets / ARCHIVE)
    shutil.copy2(release.built_archive.with_name(SIGNATURE), assets / SIGNATURE)
    signature = (assets / SIGNATURE).read_text().strip()
    document = manifest(release, signature, notes, pub_date or now())
    (assets / MANIFEST).write_text(json.dumps(document, indent=2) + '\n')
    write_checksums(assets, [release.dmg_name, LATEST_DMG, ARCHIVE, SIGNATURE, MANIFEST])


def check_assets(release: Release, assets: Path) -> dict[str, str]:
    """Everything that must hold for a set of release assets, wherever they came from. Returns each
    file's SHA-256."""
    names = {p.name for p in assets.iterdir()}
    expected = asset_names(release.version)
    require(names == expected, f'{assets.name} holds {sorted(names)}, expected {sorted(expected)}')
    digests = {name: sha256(assets / name) for name in expected}
    require(digests[LATEST_DMG] == digests[release.dmg_name], f'{LATEST_DMG} is not byte-identical to {release.dmg_name}')
    listed: dict[str, str] = {}
    for line in (assets / CHECKSUMS).read_text().splitlines():
        digest, _, name = line.partition('  ')
        require(name not in listed, f'{CHECKSUMS} lists {name} twice')
        listed[name] = digest
    require(set(listed) == expected - {CHECKSUMS}, f'{CHECKSUMS} lists {sorted(listed)}, expected every asset but itself')
    for name, digest in listed.items():
        require(digests[name] == digest, f'{name} does not match its {CHECKSUMS} line')
    document = json.loads((assets / MANIFEST).read_text())
    require(document.get('version') == release.version, f'{MANIFEST} says version {document.get("version")}')
    platform = document.get('platforms', {}).get(PLATFORM, {})
    require(platform.get('url') == release.archive_url, f'{MANIFEST} points the updater at {platform.get("url")}, not {release.archive_url}')
    require(platform.get('signature') == (assets / SIGNATURE).read_text().strip(), f'{MANIFEST} signature differs from {SIGNATURE}')
    return digests


def assemble(release: Release, runner: Runner, notes: str | None = None) -> dict[str, str]:
    source = pinned_source(release, runner)
    require_notarized(release, source, release.built_dmg)
    require_verified(release, source)
    copy_assets(release, release.assets, notes or f'TerminalX {release.version}')
    digests = check_assets(release, release.assets)
    for name in sorted(digests):
        print(f'{digests[name]}  {name}')
    return digests
