#!/usr/bin/env python3
"""Build, notarize, verify, scan and publish a TerminalX macOS release.

Run from the repository root, on main, after the version bump and changelog commit:

    python3 -I scripts/release/release.py prepare
    python3 -I scripts/release/release.py all            # check → … → verify-live, stops at the first failure
    python3 -I scripts/release/release.py publish --dry-run

Each step reads the records the earlier ones left in .raccoon/release-<version>/ and refuses to run
on anything they did not pass. docs/RELEASING.md describes the steps, the records and the
credentials (all read from outside the repository).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

# `python3 -I` leaves this script's own directory off sys.path; the package lives beside it.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from txrelease import assets, build, config, credentials, notarize, publish, secrets_scan, source, verify  # noqa: E402
from txrelease.config import ReleaseError  # noqa: E402
from txrelease.proc import Runner  # noqa: E402

PIPELINE = ['check', 'build', 'notarize', 'verify', 'assemble', 'scan', 'publish', 'verify-live']


def repository_root() -> Path:
    return Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())


def run_step(name: str, release: config.Release, runner: Runner, args: argparse.Namespace):
    release.out.mkdir(parents=True, exist_ok=True)
    if name == 'prepare':
        return source.prepare(release, runner)
    if name == 'check':
        return source.check(release, runner)
    if name == 'build':
        return build.build(release, runner)
    if name == 'notarize':
        return notarize.notarize(release, runner)
    if name == 'verify':
        return verify.verify(release, runner)
    if name == 'assemble':
        return assets.assemble(release, runner, notes=args.notes)
    if name == 'scan':
        base = runner.out('git', 'rev-parse', '--verify', f'{args.base}^{{commit}}', cwd=release.root) if args.base else None
        result = secrets_scan.scan(release, runner, credentials.local_secrets(runner), Path.home(),
                                   base=base, include_assets=not args.commits_only)
        print(json.dumps({k: v for k, v in result.items() if k != 'secretsChecked'}, indent=2))
        print('secrets checked:', len(result['secretsChecked']))
        if not result['clean']:
            raise ReleaseError('the secret scan found something; nothing may be published (see secret-scan.json)')
        return result
    if name == 'publish':
        return publish.publish(release, runner)
    if name == 'verify-live':
        return publish.verify_live(release, runner)
    raise ReleaseError(f'unknown step {name}')


def check_dmg(path: Path, runner: Runner) -> dict:
    """Read-only: is this DMG, and the app inside it, notarized, stapled and accepted by Gatekeeper?"""
    report = notarize.assess(runner, path)
    with tempfile.TemporaryDirectory(prefix='tx-dmg-') as mount:
        runner.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, path])
        try:
            app = Path(mount) / 'TerminalX.app'
            report['appStapled'] = notarize.stapled(runner, app)
            report['appGatekeeper'] = notarize.gatekeeper_app(runner, app)
        finally:
            runner.run(['hdiutil', 'detach', mount])
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('step', choices=['prepare', *PIPELINE, 'all', 'check-dmg'])
    parser.add_argument('path', nargs='?', type=Path, help='check-dmg: the DMG to assess')
    parser.add_argument('--dry-run', action='store_true', help='publish: run every gate, print what would be pushed and uploaded')
    parser.add_argument('--notes', help='assemble: the one-line notes latest.json carries (default "TerminalX <version>")')
    parser.add_argument('--base', help='scan: scan commits from this revision (default: the main commit prepare recorded)')
    parser.add_argument('--commits-only', action='store_true', help='scan: scan only the commits and notes, not release assets')
    args = parser.parse_args(argv)
    runner = Runner(dry_run=args.dry_run)
    try:
        if args.dry_run and args.step != 'publish':
            # Building and notarizing have no dry run: they submit to Apple. publish is the step a dry run is for.
            raise ReleaseError('--dry-run applies to the publish step only')
        if args.step == 'check-dmg':
            if not args.path:
                raise ReleaseError('check-dmg needs the path of a DMG')
            print(json.dumps(check_dmg(args.path, runner), indent=2))
            return 0
        release = config.load(repository_root())
        steps = PIPELINE if args.step == 'all' else [args.step]
        if args.step == 'all' and not release.record('notes.md').is_file():
            raise ReleaseError(f'write the GitHub release notes to {release.record("notes.md")} before running all')
        for name in steps:
            print(f'== {name}', flush=True)
            result = run_step(name, release, runner, args)
            if name in ('publish', 'verify-live', 'notarize') and isinstance(result, dict):
                print(json.dumps(result, indent=2))
        return 0
    except ReleaseError as error:
        print(error.code, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
