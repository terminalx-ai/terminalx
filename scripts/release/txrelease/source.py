"""The prepare and check steps: pin the source commit, then run the project's own checks on it."""
from __future__ import annotations

import os
import re
from pathlib import Path

from .config import Release, ReleaseError
from .proc import Runner, now, read_record, require, write_json

# The serve integration tests a release runs (the CI headless-serve job runs a subset of these).
SERVE_TESTS = ['owner_pretool', 'local_platform', 'local_lifetime', 'local_sharing_owner', 'local_mobile',
               'local_legacy', 'local_handover', 'local_issue_start', 'agent_setup', 'session_parent',
               'headless_pair', 'headless_update']


def check_steps(release: Release) -> list[tuple[str, list[str], Path]]:
    root = release.root
    serve = ['cargo', 't', '--locked', '--manifest-path', 'src-tauri/serve/Cargo.toml', '--features', 'local-ui']
    for test in SERVE_TESTS:
        serve += ['--test', test]
    return [
        ('install', ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], root),
        ('tsc', ['pnpm', 'exec', 'tsc', '--noEmit'], root),
        ('mobile-tsc', ['pnpm', '--dir', 'mobile', 'typecheck'], root),
        ('vitest', ['pnpm', 'exec', 'vitest', 'run'], root),
        ('mobile-vitest', ['pnpm', '--dir', 'mobile', 'exec', 'vitest', 'run'], root),
        ('release-tooling', ['python3', '-m', 'unittest', 'discover', '-s', 'scripts/release', '-p', 'test_*.py'], root),
        ('source-icons', ['python3', 'scripts/test_icons.py'], root),
        ('packaged-icon-tests', ['python3', 'scripts/test_packaged_icons.py'], root),
        ('frontend', ['pnpm', 'build'], root),
        ('webkit-install', ['pnpm', 'exec', 'playwright', 'install', 'webkit'], root),
        ('webkit', ['pnpm', 'test:webkit-layout'], root),
        ('console-layout', ['node', 'scripts/webkit/organization-console-link.mjs'], root),
        ('local-sharing', ['pnpm', 'test:webkit-local-sharing'], root),
        ('swift-tests', ['swift', 'test', '--package-path', 'native/computer-use-macos'], root),
        ('clippy', ['cargo', 'clippy', '--all-targets', '--locked', '--', '-D', 'warnings'], root / 'src-tauri'),
        ('rust-tests', ['cargo', 't', '--locked', '--', '--test-threads=4'], root / 'src-tauri'),
        ('serve-tests', serve + ['--', '--test-threads=4'], root),
    ]


def head(runner: Runner, root: Path) -> str:
    return runner.out('git', 'rev-parse', 'HEAD', cwd=root)


def release_branch(version: str) -> str:
    """The branch a release is cut to (docs/RELEASING.md, Cut a version)."""
    return f'release/{version}'


def require_release_checkout(runner: Runner, root: Path, version: str) -> str:
    """A clean checkout on release/<version> (or, as before release branches, on main). Returns the branch."""
    branch = runner.out('git', 'branch', '--show-current', cwd=root)
    allowed = (release_branch(version), 'main')
    require(branch in allowed, f'releases are built from {allowed[0]} (cut it with the cut step) or main; '
                               f'this checkout is on {branch or "a detached HEAD"}')
    require(not runner.out('git', 'status', '--porcelain', cwd=root), 'the working tree has uncommitted changes; commit or remove them first')
    return branch


def cut(root: Path, runner: Runner, version: str, worktree: Path | None = None) -> dict:
    """Create release/<version> from the current origin/main in a worktree of its own, so the main
    checkout stays free and later merges to main cannot reach the release."""
    require(re.fullmatch(r'\d+\.\d+\.\d+', version), f'"{version}" is not a version like 1.2.3')
    branch = release_branch(version)
    runner.run(['git', 'fetch', '--quiet', 'origin', 'main'], cwd=root)
    exists = runner.run(['git', 'rev-parse', '-q', '--verify', f'refs/heads/{branch}'], cwd=root, check=False)
    require(exists.code, f'{branch} already exists here; release from its worktree or delete the branch first')
    remote = runner.run(['git', 'ls-remote', '--exit-code', '--heads', 'origin', branch], cwd=root, check=False)
    require(remote.code, f'{branch} already exists on origin')
    base = runner.out('git', 'rev-parse', 'origin/main', cwd=root)
    path = worktree or root / '.raccoon' / 'worktrees' / f'release-{version}'
    require(not path.exists(), f'{path} already exists')
    runner.run(['git', 'worktree', 'add', '--quiet', '--no-track', '-b', branch, path, base], cwd=root)
    return {'version': version, 'branch': branch, 'baseMainCommit': base, 'worktree': str(path), 'cutAt': now()}


def prepare(release: Release, runner: Runner) -> dict:
    """Pin the release: a clean release/<version> branch cut from main (or main itself, containing
    all of origin/main), with a changelog section."""
    root = release.root
    branch = require_release_checkout(runner, root, release.version)
    runner.run(['git', 'fetch', '--quiet', 'origin', 'main'], cwd=root)
    if branch == 'main':
        base = runner.out('git', 'rev-parse', 'origin/main', cwd=root)
        contains = runner.run(['git', 'merge-base', '--is-ancestor', base, 'HEAD'], cwd=root, check=False)
        require(contains.code == 0, f'HEAD does not contain origin/main ({base[:8]}); pull main and validate again')
    else:
        # Main may move on after the cut; the release is what was cut plus the branch's own commits.
        found = runner.run(['git', 'merge-base', 'HEAD', 'origin/main'], cwd=root, check=False)
        require(found.code == 0 and found.output, f'{branch} shares no history with origin/main; cut it from main')
        base = found.output
    changelog = (root / 'CHANGELOG.md').read_text()
    require(f'\n## {release.version}\n' in changelog, f'CHANGELOG.md has no "## {release.version}" section')
    context = {'version': release.version, 'branch': branch, 'baseMainCommit': base, 'sourceCommit': head(runner, root),
               'preparedAt': now()}
    write_json(release.record('release-context.json'), context)
    return context


def pinned_context(release: Release, runner: Runner) -> dict:
    """prepare's record; refuses if the checkout has moved, changed or switched branch since."""
    context = read_record(release.record('release-context.json'), 'prepare')
    require(context['version'] == release.version, f'release-context.json is for {context["version"]}, not {release.version}')
    branch = require_release_checkout(runner, release.root, release.version)
    pinned = context.get('branch', 'main')
    require(branch == pinned, f'prepare pinned {pinned}, but this checkout is on {branch}')
    current = head(runner, release.root)
    require(current == context['sourceCommit'], f'HEAD moved from {context["sourceCommit"][:8]} to {current[:8]}; run prepare and the checks again')
    return context


def pinned_source(release: Release, runner: Runner) -> str:
    """The commit prepare pinned; refuses if the checkout has moved or changed since."""
    return pinned_context(release, runner)['sourceCommit']


def check(release: Release, runner: Runner, env=os.environ) -> dict:
    source = pinned_source(release, runner)
    steps = []
    report = {'passed': False, 'sourceCommit': source, 'startedAt': now(), 'steps': steps}
    check_env = dict(env)
    check_env['CARGO_TARGET_DIR'] = str(release.target_dir) + '-check'
    for name, argv, cwd in check_steps(release):
        print(f'START {name}', flush=True)
        started = now()
        with release.record(f'{name}.log').open('w') as log:
            result = runner.run(argv, cwd=cwd, env=check_env, check=False, log=log)
        steps.append({'name': name, 'command': argv, 'exitCode': result.code, 'startedAt': started, 'finishedAt': now()})
        write_json(release.record('release-checks.json'), report)
        print(f'END {name} exit={result.code}', flush=True)
        if result.code:
            tail = '\n'.join(release.record(f'{name}.log').read_text().splitlines()[-60:])
            raise ReleaseError(f'check {name} failed (log in {name}.log):\n{tail}')
    report['passed'] = True
    report['finishedAt'] = now()
    write_json(release.record('release-checks.json'), report)
    return report


def require_checks_passed(release: Release, source: str) -> None:
    checks = read_record(release.record('release-checks.json'), 'check')
    require(checks.get('passed') is True, 'release-checks.json does not record a pass; run the check step')
    require(checks.get('sourceCommit') == source, 'the checks ran on a different commit; run the check step again')
    expected = {name for name, _, _ in check_steps(release)}
    ran = {step['name'] for step in checks.get('steps', []) if step.get('exitCode') == 0}
    missing = sorted(expected - ran)
    require(not missing, f'checks did not pass: {", ".join(missing)}')
