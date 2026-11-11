"""The scan step: refuse to publish if anything secret is in what goes to GitHub.

The repository is public. This scans what a release publishes: the commits pushed on top of main
(diffs and messages), the release notes, and every file inside the release assets (the updater
archive extracted, the DMG mounted, the signature, latest.json and SHA256SUMS). It looks for this
machine's own secrets, read at run time and never printed (credentials.local_secrets), for the
current user's home directory path in the commits and notes, and for common credential patterns.
It reports only where a match is and which kind it is, never the value. secret-scan.json records the
result; publish refuses a scan that found something, did not cover the assets, or is older than them.
"""
from __future__ import annotations

import re
import shutil
import tarfile
from dataclasses import dataclass, field
from pathlib import Path

from .config import ARCHIVE, Release
from .proc import Runner, now, read_record, require, sha256, write_json

PATTERNS = {
    'private key block': rb'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----',
    'GitHub token pattern': rb'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}',
    'Linear key pattern': rb'\blin_api_[A-Za-z0-9]{30,}',
    'Anthropic or OpenAI key pattern': rb'\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}',
    'AWS access key pattern': rb'\bAKIA[0-9A-Z]{16}\b',
    # A real Slack token has a numeric workspace ID after its prefix (xoxb-1234567890-...). The bare
    # prefixes are in the app on purpose: transcription refuses to learn words that start with them.
    'Slack token pattern': rb'\bxox[abposr]-[0-9]{6,}-[A-Za-z0-9-]{6,}',
}
NOTES = ['notes.md']


@dataclass
class Scanner:
    needles: dict[str, bytes]
    patterns: dict[str, bytes] = field(default_factory=lambda: dict(PATTERNS))
    findings: list[dict] = field(default_factory=list)
    files: int = 0
    bytes: int = 0

    def scan(self, where: str, data: bytes, extra: dict[str, bytes] | None = None) -> None:
        self.files += 1
        self.bytes += len(data)
        for what, value in {**self.needles, **(extra or {})}.items():
            if value in data:
                self.findings.append({'where': where, 'what': what})
        for what, pattern in self.patterns.items():
            if re.search(pattern, data):
                self.findings.append({'where': where, 'what': what})

    def scan_tree(self, prefix: str, base: Path) -> None:
        for path in sorted(p for p in base.rglob('*') if p.is_file() and not p.is_symlink()):
            self.scan(f'{prefix} {path.relative_to(base)}', path.read_bytes())


def home_needles(home: Path) -> dict[str, bytes]:
    """The home directory, for text a person wrote. Built binaries legitimately embed build paths,
    so this is not looked for inside the assets."""
    text = str(home)
    return {'home directory path': text.encode()} if len(text) > len('/Users/') else {}


def scan_commits(scanner: Scanner, runner: Runner, root: Path, base: str, home: Path) -> None:
    extra = home_needles(home)
    diff = runner.run(['git', 'diff', f'{base}..HEAD'], cwd=root).output.encode()
    scanner.scan(f'git diff {base[:8]}..HEAD', diff, extra)
    messages = runner.run(['git', 'log', '--format=%B', f'{base}..HEAD'], cwd=root).output.encode()
    scanner.scan(f'git log {base[:8]}..HEAD (messages)', messages, extra)


def scan_assets(scanner: Scanner, runner: Runner, release: Release, assets: Path) -> None:
    seen: dict[str, str] = {}
    work = release.record('scan-extracted')
    for path in sorted(assets.iterdir()):
        digest = sha256(path)
        if digest in seen:
            # TerminalX-latest-aarch64.dmg is the versioned DMG byte for byte; scanning it once covers both.
            scanner.scan(f'asset {path.name} (identical to {seen[digest]})', b'')
            continue
        seen[digest] = path.name
        if path.name == ARCHIVE:
            if work.exists():
                shutil.rmtree(work)
            work.mkdir()
            with tarfile.open(path) as archive:
                archive.extractall(work, filter='tar')
            scanner.scan(f'asset {path.name} (archive)', path.read_bytes())
            scanner.scan_tree('archive', work)
            shutil.rmtree(work)
        elif path.suffix == '.dmg':
            scanner.scan(f'asset {path.name} (image)', path.read_bytes())
            mount = release.record('scan-mounted')
            mount.mkdir(exist_ok=True)
            runner.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, path])
            try:
                scanner.scan_tree(f'dmg {path.name}', mount)
            finally:
                runner.run(['hdiutil', 'detach', mount])
        else:
            scanner.scan(f'asset {path.name}', path.read_bytes())


def scan(release: Release, runner: Runner, needles: dict[str, str], home: Path, *, base: str | None = None,
         include_assets: bool = True) -> dict:
    """Scan, write secret-scan.json, and return its contents. ``base`` defaults to the main commit
    prepare recorded; ``include_assets=False`` scans only the commits (for a branch, before a build)."""
    if base is None:
        base = read_record(release.record('release-context.json'), 'prepare')['baseMainCommit']
    scanner = Scanner({label: value.encode() for label, value in needles.items()})
    scan_commits(scanner, runner, release.root, base, home)
    extra = home_needles(home)
    for name in NOTES:
        if release.record(name).exists():
            scanner.scan(name, release.record(name).read_bytes(), extra)
    if include_assets:
        require(release.assets.is_dir(), 'there are no assets to scan; run the assemble step first')
        scan_assets(scanner, runner, release, release.assets)
    result = {
        'clean': not scanner.findings,
        'findings': scanner.findings,
        'scanned': {'files': scanner.files, 'bytes': scanner.bytes},
        'base': base,
        'head': runner.out('git', 'rev-parse', 'HEAD', cwd=release.root),
        'secretsChecked': sorted(scanner.needles) + sorted(extra),
        'patternsChecked': sorted(scanner.patterns),
        'assetsScanned': include_assets,
        'scannedAt': now(),
    }
    release.out.mkdir(parents=True, exist_ok=True)
    write_json(release.record('secret-scan.json'), result)
    return result


def require_clean_scan(release: Release, source: str, published: list[Path]) -> dict:
    record = release.record('secret-scan.json')
    result = read_record(record, 'scan')
    require(result.get('clean') is True, 'the secret scan found something: ' + ', '.join(f'{f["what"]} in {f["where"]}' for f in result.get('findings', [])))
    require(result.get('assetsScanned') is True, 'the secret scan did not cover the release assets; run the scan step after assemble')
    require(result.get('head') == source, 'the secret scan ran on a different commit; run the scan step again')
    # The scan must cover every commit this release pushes: from the main commit prepare recorded.
    base = read_record(release.record('release-context.json'), 'prepare')['baseMainCommit']
    require(result.get('base') == base, f'the secret scan did not start at {base[:8]}, the origin/main prepare recorded; run the scan step without --base')
    stale = [p.name for p in published if p.stat().st_mtime >= record.stat().st_mtime]
    require(not stale, f'the secret scan is older than {", ".join(stale)}; run the scan step again')
    return result
