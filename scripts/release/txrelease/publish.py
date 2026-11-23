"""The publish and verify-live steps.

publish checks every earlier step's record first and only then changes anything: a release whose
checks, notarization, stapling, artifact verification or secret scan did not pass never gets a tag,
a push or a GitHub release. It then pushes the release branch (or main) and the tag, uploads a
draft release, downloads it back and compares, and only then marks it Latest, which moves both the
in-app update feed and the stable download link to it. If it stops after the draft exists, running
it again reuses that draft: the push is a no-op once the branch and the tag are there, and the
draft's notes and assets are replaced.

merge-back then brings a release branch into main with a merge commit, so main gets the version bump
and the changelog however far it moved meanwhile. The tagged commit is never rebased. A conflict
that is only the new changelog section is resolved here; any other conflict, or a main that keeps
moving, becomes a "Release TerminalX <version>" pull request instead of a failed release.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from .assets import check_assets
from .config import ARCHIVE, LATEST_DMG, MANIFEST, REPO, SIGNATURE, STABLE_DOWNLOAD_URL, Release
from .notarize import gatekeeper_dmg, require_notarized, stapled
from .proc import Runner, now, read_record, require, write_json
from .secrets_scan import require_clean_scan
from .source import pinned_context, release_branch, require_checks_passed
from .verify import require_verified, updater_signature


def gates(release: Release, runner: Runner) -> dict:
    """Everything that must already hold before publish changes anything. Returns what it checked."""
    context = pinned_context(release, runner)
    source = context['sourceCommit']
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
    return {'sourceCommit': source, 'branch': context.get('branch', 'main'), 'baseMainCommit': context['baseMainCommit'], 'assets': digests, 'notarizationSubmission': notarization['dmgSubmission']['id'],
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
    # The branch and the tag go together or not at all. A release branch and its tag are new refs, so
    # merges to main since the cut cannot refuse them; on main, an atomic push refuses a stale main.
    # Neither overwrites remote history.
    runner.run(['git', 'push', '--atomic', 'origin', checked['branch'], f'refs/tags/{tag}'], cwd=root, mutates=True)
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


MERGE_ATTEMPTS = 3


def release_section(changelog: str, version: str) -> str | None:
    """The "## <version>" section of a changelog, heading included, up to the next "## " heading."""
    match = re.search(rf'^## {re.escape(version)}\n.*?(?=^## |\Z)', changelog, re.M | re.S)
    return match.group(0) if match else None


def merged_changelog(base: str, main: str, branch: str, version: str) -> str | None:
    """main's changelog with the release's new section added, when the branch only added that section
    to the changelog it was cut with. Entries main gained since stay under "Unreleased". None when the
    branch changed anything else, which a person has to merge."""
    section = release_section(branch, version)
    flat = lambda text: re.sub(r'\n{3,}', '\n\n', text).strip()
    if section is None or release_section(main, version) is not None or flat(branch.replace(section, '', 1)) != flat(base):
        return None
    later = re.search(r'^## (?!Unreleased\n)', main, re.M)
    if later is None:
        return main.rstrip('\n') + '\n\n' + section.rstrip('\n') + '\n'
    return main[:later.start()] + section.rstrip('\n') + '\n\n' + main[later.start():]


def conflicted(runner: Runner, worktree: Path) -> list[str]:
    return runner.out('git', 'diff', '--name-only', '--diff-filter=U', cwd=worktree).split()


def merge_into_main(release: Release, runner: Runner, branch: str, source: str, worktree: Path) -> dict:
    """Merge the tagged commit into the current origin/main in a scratch worktree. Returns what happened:
    merged (with the merge commit) or the conflicted files a person has to resolve."""
    message = f'Merge {branch} into main (TerminalX {release.version})'
    merge = runner.run(['git', 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', message, source], cwd=worktree, check=False)
    if merge.code:
        files = conflicted(runner, worktree)
        resolved = None
        if files == ['CHANGELOG.md']:
            stage = lambda n: runner.out('git', 'show', f':{n}:CHANGELOG.md', cwd=worktree) + '\n'
            resolved = merged_changelog(stage(1), stage(2), stage(3), release.version)
        if resolved is None:
            runner.run(['git', 'merge', '--abort'], cwd=worktree, check=False)
            return {'merged': False, 'conflicts': files or ['(the merge failed: ' + merge.output[-500:] + ')']}
        (worktree / 'CHANGELOG.md').write_text(resolved)
        runner.run(['git', 'add', 'CHANGELOG.md'], cwd=worktree)
        runner.run(['git', 'commit', '--no-edit', '--no-verify'], cwd=worktree)
    return {'merged': True, 'mergeCommit': runner.out('git', 'rev-parse', 'HEAD', cwd=worktree),
            'changelogResolved': bool(merge.code)}


def open_release_pr(release: Release, runner: Runner, branch: str, reason: str) -> str:
    """The open "Release TerminalX <version>" pull request from the branch into main, opened if needed."""
    root = release.root
    found = runner.out('gh', 'pr', 'list', '--repo', REPO, '--base', 'main', '--head', branch, '--state', 'open',
                       '--json', 'url', '--jq', '.[0].url // ""', cwd=root)
    if found:
        return found
    body = (f'TerminalX {release.version} is published from `{branch}` ({release.tag}). This brings its version bump and '
            f'changelog into main. It could not be merged by the release pipeline: {reason}\n\n'
            'Merge it with a merge commit; do not rebase or squash, so the tagged commit stays in main\'s history.')
    created = runner.run(['gh', 'pr', 'create', '--repo', REPO, '--base', 'main', '--head', branch,
                          '--title', f'Release TerminalX {release.version}', '--body', body], cwd=root, mutates=True)
    return created.output.strip().splitlines()[-1] if created.output.strip() else ''


def merge_back(release: Release, runner: Runner) -> dict:
    """After publish: get the release branch into main, by a merge commit or, failing that, a PR."""
    context = read_record(release.record('release-context.json'), 'prepare')
    branch, source, root = context.get('branch', 'main'), context['sourceCommit'], release.root
    if branch == 'main':
        return {'branch': 'main', 'method': 'none', 'note': 'built from main; publish pushed it there'}
    require(branch == release_branch(release.version), f'release-context.json names {branch}, not {release_branch(release.version)}')
    result = read_record(release.record('release-result.json'), 'publish')
    require(result.get('sourceCommit') == source and not result.get('dryRun'), 'publish has not published this commit; run the publish step')
    report: dict = {'branch': branch, 'sourceCommit': source, 'attempts': []}
    worktree = release.record('merge-back')
    reason = ''
    for _ in range(MERGE_ATTEMPTS):
        runner.run(['git', 'fetch', '--quiet', 'origin', 'main'], cwd=root)
        main = runner.out('git', 'rev-parse', 'origin/main', cwd=root)
        if runner.run(['git', 'merge-base', '--is-ancestor', source, main], cwd=root, check=False).code == 0:
            report.update(method='already-merged', mainCommit=main)
            break
        if worktree.exists():
            runner.run(['git', 'worktree', 'remove', '--force', worktree], cwd=root, check=False)
            shutil.rmtree(worktree, ignore_errors=True)
        runner.run(['git', 'worktree', 'add', '--quiet', '--detach', worktree, main], cwd=root)
        try:
            merged = merge_into_main(release, runner, branch, source, worktree)
            report['attempts'].append({'main': main, **merged})
            if not merged['merged']:
                reason = 'these files conflict with main: ' + ', '.join(merged['conflicts'])
                break
            # Refused, and nothing written, if main moved since the fetch: then merge again onto the new main.
            pushed = runner.run(['git', 'push', 'origin', f'{merged["mergeCommit"]}:refs/heads/main'], cwd=root, check=False, mutates=True)
            if pushed.code == 0:
                report.update(method='merge', mainCommit=merged['mergeCommit'])
                break
            reason = f'main kept moving ({MERGE_ATTEMPTS} merges were refused as no longer fast-forward)'
        finally:
            runner.run(['git', 'worktree', 'remove', '--force', worktree], cwd=root, check=False)
    if 'method' not in report:
        report.update(method='pull-request', reason=reason, pullRequest=open_release_pr(release, runner, branch, reason))
        print(f'{branch} could not be merged into main ({reason}); opened {report["pullRequest"] or "a pull request"}.', flush=True)
    report['finishedAt'] = now()
    write_json(release.record('merge-back.json'), report)
    return report
