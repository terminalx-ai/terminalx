"""The publish and verify-live steps.

publish checks every earlier step's record first and only then changes anything: a release whose
checks, notarization, stapling, artifact verification or secret scan did not pass never gets a tag,
a push or a GitHub release. It then pushes main and the tag, uploads a draft release, downloads it
back and compares, and only then marks it Latest, which moves both the in-app update feed and the
stable download link to it. If it stops after the draft exists, running it again reuses that draft:
the push is a no-op once main and the tag are there, and the draft's notes and assets are replaced.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from .assets import check_assets
from .config import ARCHIVE, LATEST_DMG, MANIFEST, REPO, SIGNATURE, STABLE_DOWNLOAD_URL, Release
from .notarize import gatekeeper_dmg, require_notarized, stapled
from .proc import Runner, now, read_record, require, write_json
from .secrets_scan import require_clean_scan
from .source import pinned_source, require_checks_passed
from .verify import require_verified, updater_signature


def gates(release: Release, runner: Runner) -> dict:
    """Everything that must already hold before publish changes anything. Returns what it checked."""
    source = pinned_source(release, runner)
    meta = read_record(release.record('build-metadata.json'), 'build')
    require(meta.get('exitCode') == 0 and meta.get('sourceCommit') == source, 'the build did not pass at the pinned commit')
    require_checks_passed(release, source)
    require(release.assets.is_dir(), 'there are no assets; run the assemble step')
    digests = check_assets(release, release.assets)
    notarization = require_notarized(release, source, release.assets / release.dmg_name)
    require_verified(release, source)
    notes = release.record('notes.md')
    require(notes.is_file(), 'notes.md (the GitHub release notes) is missing from the release directory')
    require('@@' not in notes.read_text(), 'notes.md still holds an @@ placeholder')
    assets = sorted(release.assets.iterdir())
    scan = require_clean_scan(release, source, [notes, *assets])
    return {'sourceCommit': source, 'assets': digests, 'notarizationSubmission': notarization['dmgSubmission']['id'],
            'secretScan': scan['scanned']}


def compare_download(release: Release, runner: Runner, downloaded: Path) -> dict:
    """A downloaded copy of the release must be the local assets byte for byte."""
    local = check_assets(release, release.assets)
    remote = check_assets(release, downloaded)
    require(local == remote, 'the downloaded assets differ from the local ones')
    updater = updater_signature(release, runner, downloaded / ARCHIVE)
    require(updater.get('signatureVerified') is True, 'the downloaded updater archive signature does not verify')
    return {'allAssetsMatchLocal': True, 'checksumsVerified': True, 'manifestVerified': True, 'updater': updater}


def existing_release(release: Release, runner: Runner) -> dict | None:
    """The GitHub release for this tag, if there is one: whether it is a draft and its asset names."""
    found = runner.run(['gh', 'release', 'view', release.tag, '--repo', REPO, '--json', 'isDraft,assets'], cwd=release.root, check=False)
    if found.code:
        require('release not found' in found.output, f'gh release view exited {found.code}: {found.output[-2000:]}')
        return None
    document = json.loads(found.output)
    return {'isDraft': document['isDraft'], 'assets': sorted(a['name'] for a in document.get('assets', []))}


def upload_draft(release: Release, runner: Runner) -> None:
    """Create the draft release, or bring the draft an earlier, failed publish left back to exactly
    this release's notes and assets, so publish can simply be run again."""
    root, tag = release.root, release.tag
    paths = sorted(release.assets.iterdir())
    title, notes = f'TerminalX {release.version}', release.record('notes.md')
    existing = existing_release(release, runner)
    if existing is None:
        runner.run(['gh', 'release', 'create', tag, '--repo', REPO, '--verify-tag', '--draft', '--title', title,
                    '--notes-file', notes, *paths], cwd=root, mutates=True)
        return
    require(existing['isDraft'], f'{tag} is already published on GitHub; run the verify-live step to check what it serves')
    print(f'Reusing the draft release {tag} an earlier publish left.', flush=True)
    for name in existing['assets']:
        if name not in {p.name for p in paths}:
            runner.run(['gh', 'release', 'delete-asset', tag, name, '--repo', REPO, '--yes'], cwd=root, mutates=True)
    runner.run(['gh', 'release', 'edit', tag, '--repo', REPO, '--title', title, '--notes-file', notes], cwd=root, mutates=True)
    runner.run(['gh', 'release', 'upload', tag, '--repo', REPO, '--clobber', *paths], cwd=root, mutates=True)


def publish(release: Release, runner: Runner) -> dict:
    checked = gates(release, runner)
    source = checked['sourceCommit']
    root, tag = release.root, release.tag
    print(f'All gates passed for {tag} at {source[:8]}.', flush=True)

    if runner.run(['git', 'rev-parse', '-q', '--verify', f'refs/tags/{tag}'], cwd=root, check=False).code:
        runner.run(['git', 'tag', '-a', tag, '-m', f'TerminalX {release.version}', source], cwd=root, mutates=True)
    elif not runner.dry_run:
        require(runner.out('git', 'rev-parse', f'{tag}^{{}}', cwd=root) == source, f'tag {tag} already exists on another commit')
    # An atomic push refuses a stale main; it never overwrites remote history.
    runner.run(['git', 'push', '--atomic', 'origin', 'main', f'refs/tags/{tag}'], cwd=root, mutates=True)
    upload_draft(release, runner)
    downloaded = release.record('downloaded')
    if runner.dry_run:
        print('[dry run] would download the draft back and compare it with the local assets', flush=True)
        uploaded = None
    else:
        if downloaded.exists():
            shutil.rmtree(downloaded)
        runner.run(['gh', 'release', 'download', tag, '--repo', REPO, '--dir', downloaded], cwd=root)
        uploaded = compare_download(release, runner, downloaded)
        write_json(release.record('upload-verification.json'), uploaded)
    # Marking it Latest moves /releases/latest/download/ (the update feed and the stable DMG link).
    runner.run(['gh', 'release', 'edit', tag, '--repo', REPO, '--draft=false', '--latest'], cwd=root, mutates=True)
    result = {**checked, 'tag': tag, 'dryRun': runner.dry_run, 'uploadVerification': uploaded, 'publishedAt': now()}
    if not runner.dry_run:
        result['releaseUrl'] = runner.out('gh', 'release', 'view', tag, '--repo', REPO, '--json', 'url', '--jq', '.url', cwd=root)
        write_json(release.record('release-result.json'), result)
    return result


def download(runner: Runner, url: str, path: Path) -> None:
    runner.run(['curl', '--fail', '--silent', '--show-error', '--location', '--retry', '2', '--max-time', '300', url, '--output', path])


def verify_live(release: Release, runner: Runner) -> dict:
    """What a user and an installed app now get: the update feed and the stable download link."""
    live = release.record('live')
    if live.exists():
        shutil.rmtree(live)
    live.mkdir(parents=True)
    feed = release.feed_url
    download(runner, feed, live / MANIFEST)
    document = json.loads((live / MANIFEST).read_text())
    require(document.get('version') == release.version, f'the update feed serves {document.get("version")}, not {release.version}')
    url = document['platforms']['darwin-aarch64']['url']
    require(url == release.archive_url, f'the update feed points at {url}')
    download(runner, url, live / ARCHIVE)
    download(runner, url + '.sig', live / SIGNATURE)
    download(runner, STABLE_DOWNLOAD_URL, live / LATEST_DMG)
    for name in (MANIFEST, ARCHIVE, SIGNATURE, LATEST_DMG):
        require((live / name).read_bytes() == (release.assets / name).read_bytes(), f'the live {name} differs from the published one')
    updater = updater_signature(release, runner, live / ARCHIVE)
    report = {'feed': feed, 'version': release.version, 'stableDownload': STABLE_DOWNLOAD_URL, 'liveAssetsMatchLocal': True,
              'stableDownloadStapled': stapled(runner, live / LATEST_DMG), 'stableDownloadGatekeeper': gatekeeper_dmg(runner, live / LATEST_DMG),
              'updaterSignatureVerified': updater['signatureVerified'], 'archiveSha256': updater['sha256'], 'checkedAt': now()}
    write_json(release.record('live-verification.json'), report)
    return report
