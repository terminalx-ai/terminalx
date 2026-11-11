"""Tests for the release pipeline (scripts/release/txrelease). They need Python 3.9 or newer (the
python3 macOS ships is 3.9) and git, and run on macOS or not: git runs for real in scratch
repositories, and every other command goes through a fake runner, so nothing is built, notarized,
pushed or uploaded.

    python3 -m unittest discover -s scripts/release -p 'test_*.py'
"""
from __future__ import annotations

import contextlib
import gzip
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import zipfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import release as cli  # noqa: E402
from txrelease import assets, config, content, credentials, notarize, publish, secrets_scan, source  # noqa: E402
from txrelease.config import LATEST_DMG, ReleaseError  # noqa: E402
from txrelease.proc import Result, Runner, sha256, write_json  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION = '9.8.7'
HEAD = 'a' * 40
BASE = 'b' * 40
IDENTITY = 'Developer ID Application: Example Maker (ABCDE12345)'
# Credential-shaped fixtures are put together at run time: written out whole, they would be in the
# diff the next release's secret scan reads, and it would refuse to publish.
PEM_KEY = '-----BEGIN ' + 'PRIVATE KEY-----\n{body}\n-----END ' + 'PRIVATE KEY-----\n'
AWS_SHAPED = 'AKIA' + 'ABCDEFGHIJKLMNOP'
SLACK_SHAPED = 'xoxb' + '-1234567890-abcdefghij'


class FakeRunner(Runner):
    """Answers commands from (prefix, response) pairs, first match wins; records every call."""

    def __init__(self, responses=(), dry_run=False):
        super().__init__(dry_run=dry_run)
        self.responses = list(responses)
        self.calls: list[list[str]] = []

    def execute(self, argv, *, cwd, env, log):
        self.calls.append(argv)
        for prefix, response in self.responses:
            if argv[:len(prefix)] == prefix:
                return response(argv) if callable(response) else response
        raise AssertionError(f'unexpected command: {argv}')

    def ran(self, *prefix: str) -> bool:
        return any(call[:len(prefix)] == list(prefix) for call in self.calls)


def git_responses(branch='main', status='', head=HEAD):
    return [
        (['git', 'branch', '--show-current'], Result(0, branch)),
        (['git', 'status', '--porcelain'], Result(0, status)),
        (['git', 'rev-parse', 'HEAD'], Result(0, head)),
    ]


def write_repo(root: Path, versions=(VERSION, VERSION, VERSION)) -> None:
    (root / 'src-tauri').mkdir(parents=True, exist_ok=True)
    (root / 'package.json').write_text(json.dumps({'version': versions[0], 'dependencies': {'agent-browser': '0.27.0'}}))
    (root / 'src-tauri/tauri.conf.json').write_text(json.dumps({
        'version': versions[1],
        'plugins': {'updater': {'endpoints': ['https://github.com/terminalx-ai/raccoon/releases/latest/download/latest.json']}},
    }))
    (root / 'src-tauri/Cargo.toml').write_text(f'[package]\nname = "raccoon"\nversion = "{versions[2]}"\n\n[dependencies]\nserde = {{ version = "1" }}\n')
    (root / 'CHANGELOG.md').write_text(f'# TerminalX changelog\n\n## Unreleased\n\n## {VERSION}\n\n- Things.\n')


def make_archive(path: Path, members: dict[str, bytes]) -> None:
    staging = path.parent / 'archive-staging'
    for name, data in members.items():
        (staging / name).parent.mkdir(parents=True, exist_ok=True)
        (staging / name).write_bytes(data)
    with tarfile.open(path, 'w:gz') as archive:
        archive.add(staging / 'TerminalX.app', arcname='TerminalX.app')
    shutil.rmtree(staging)


class Fixture:
    """A release whose every step has passed: build output, records and assets on disk."""

    def __init__(self, directory: Path):
        self.root = directory / 'repo'
        write_repo(self.root)
        self.release = config.Release(root=self.root, version=VERSION, out=self.root / f'.raccoon/release-{VERSION}',
                                      target_dir=directory / 'target')
        r = self.release
        (r.bundle / 'dmg').mkdir(parents=True)
        r.built_app.mkdir(parents=True)
        r.built_dmg.write_bytes(b'stapled dmg bytes ' * 1000)
        make_archive(r.built_archive, {'TerminalX.app/Contents/Info.plist': b'<plist/>'})
        r.built_archive.with_name(config.SIGNATURE).write_bytes(b'c2lnbmF0dXJl\n')
        write_json(r.record('release-context.json'), {'version': VERSION, 'baseMainCommit': BASE, 'sourceCommit': HEAD})
        write_json(r.record('build-metadata.json'), {'version': VERSION, 'sourceCommit': HEAD, 'exitCode': 0})
        write_json(r.record('signing-config.json'), {'bundle': {'macOS': {'signingIdentity': IDENTITY}}})
        steps = [{'name': name, 'exitCode': 0} for name, _, _ in source.check_steps(r)]
        write_json(r.record('release-checks.json'), {'passed': True, 'sourceCommit': HEAD, 'steps': steps})
        write_json(r.record('notarization.json'), {'accepted': True, 'sourceCommit': HEAD, 'dmgSha256': sha256(r.built_dmg),
                                                   'dmgSubmission': {'id': 'submission-1', 'status': 'Accepted', 'message': 'ok'}})
        write_json(r.record('artifact-verification.json'), {'passed': True, 'sourceCommit': HEAD})
        assets.copy_assets(r, r.assets, f'TerminalX {VERSION}', pub_date='2026-11-11T00:00:00Z')
        r.record('notes.md').write_text('Release notes.\n')
        self.scan_clean()

    def scan_clean(self, **overrides) -> None:
        time.sleep(0.01)  # the scan record must be newer than the assets and notes it covers
        write_json(self.release.record('secret-scan.json'),
                   {'clean': True, 'findings': [], 'assetsScanned': True, 'head': HEAD, 'base': BASE, 'scanned': {'files': 9, 'bytes': 1}, **overrides})

    def runner(self, dry_run=True, tag_exists=False, on_github=None) -> FakeRunner:
        """``on_github`` is the GitHub release ``gh release view`` finds for the tag: None for none."""
        found = Result(1, 'release not found') if on_github is None else Result(0, json.dumps(on_github))
        return FakeRunner([
            *git_responses(),
            (['git', 'rev-parse', '-q', '--verify'], Result(0 if tag_exists else 1, '')),
            (['git', 'rev-parse', f'{self.release.tag}^{{}}'], Result(0, HEAD)),
            (['gh', 'release', 'view', self.release.tag, '--repo', config.REPO, '--json', 'isDraft,assets'], found),
        ], dry_run=dry_run)


class TempCase(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='tx-release-test-'))
        self.addCleanup(shutil.rmtree, self.directory, True)


class ConfigTests(TempCase):
    def test_loads_the_version_and_computes_paths_without_a_fixed_home(self):
        write_repo(self.directory)
        release = config.load(self.directory, env={'TERMINALX_RELEASE_TARGET_DIR': str(self.directory / 't')})
        self.assertEqual(release.version, VERSION)
        self.assertEqual(release.out, self.directory / f'.raccoon/release-{VERSION}')
        self.assertEqual(release.built_dmg, self.directory / f't/release/bundle/dmg/TerminalX_{VERSION}_aarch64.dmg')
        self.assertEqual(release.archive_url, f'https://github.com/terminalx-ai/terminalx/releases/download/v{VERSION}/TerminalX.app.tar.gz')
        default = config.load(self.directory, env={})
        self.assertEqual(default.target_dir, Path.home() / f'Library/Caches/terminalx-release-{VERSION}')

    def test_refuses_version_files_that_disagree(self):
        write_repo(self.directory, versions=(VERSION, VERSION, '9.8.6'))
        with self.assertRaises(ReleaseError) as raised:
            config.load(self.directory, env={})
        self.assertIn('src-tauri/Cargo.toml 9.8.6', str(raised.exception.code))

    def test_the_repository_versions_agree(self):
        self.assertEqual(len(set(config.read_versions(REPO_ROOT).values())), 1)

    def test_the_stable_download_link_names_the_latest_asset(self):
        self.assertEqual(config.STABLE_DOWNLOAD_URL,
                         'https://github.com/terminalx-ai/terminalx/releases/latest/download/TerminalX-latest-aarch64.dmg')
        self.assertIn(LATEST_DMG, config.asset_names(VERSION))


class CredentialTests(TempCase):
    def notary_env(self, data=None, key_name='AuthKey_TEST.p8'):
        key = self.directory / key_name
        key.write_text(PEM_KEY.format(body='TESTKEYBODYLINE0123456789'))
        config_path = self.directory / 'notary.json'
        config_path.write_text(json.dumps(data if data is not None else {'keyPath': str(key), 'keyId': 'KEYID12345', 'issuerId': 'issuer-uuid-1'}))
        return {'TERMINALX_NOTARY_CONFIG': str(config_path), 'HOME': str(self.directory)}

    def test_a_missing_notary_config_names_the_file_and_the_override(self):
        with self.assertRaises(ReleaseError) as raised:
            credentials.notary_key({'HOME': str(self.directory)})
        message = raised.exception.code
        self.assertIn(str(self.directory / '.appstoreconnect/terminalx-notary.json'), message)
        self.assertIn('TERMINALX_NOTARY_CONFIG', message)
        self.assertIn('docs/RELEASING.md', message)

    def test_a_notary_config_without_fields_or_key_file_is_refused(self):
        with self.assertRaises(ReleaseError) as raised:
            credentials.notary_key(self.notary_env({'keyPath': '', 'keyId': 'x'}))
        self.assertIn('keyPath, issuerId', raised.exception.code)
        with self.assertRaises(ReleaseError) as raised:
            credentials.notary_key(self.notary_env({'keyPath': str(self.directory / 'gone.p8'), 'keyId': 'K', 'issuerId': 'I'}))
        self.assertIn('missing or is not a .p8 file', raised.exception.code)

    def test_reads_the_notary_key_and_hands_it_to_tauri_and_notarytool(self):
        key = credentials.notary_key(self.notary_env())
        self.assertEqual(key.tauri_env()['APPLE_API_KEY'], 'KEYID12345')
        self.assertEqual(key.tauri_env()['APPLE_API_ISSUER'], 'issuer-uuid-1')
        self.assertEqual(key.notarytool_args()[:2], ['--key', str(self.directory / 'AuthKey_TEST.p8')])

    def test_a_missing_updater_key_says_how_it_is_made(self):
        with self.assertRaises(ReleaseError) as raised:
            credentials.updater_key({'HOME': str(self.directory)})
        self.assertIn('tauri signer generate', raised.exception.code)
        self.assertIn('TERMINALX_UPDATER_KEY', raised.exception.code)

    def test_signing_identity_comes_from_the_environment_or_the_one_keychain_identity(self):
        self.assertEqual(credentials.signing_identity(FakeRunner(), {'APPLE_SIGNING_IDENTITY': IDENTITY}), IDENTITY)
        with self.assertRaises(ReleaseError):
            credentials.signing_identity(FakeRunner(), {'APPLE_SIGNING_IDENTITY': 'Apple Development: Someone'})
        listing = f'  1) 0123 "{IDENTITY}"\n  2) 4567 "Apple Development: Example (ZZZZZ99999)"\n     2 valid identities found'
        runner = FakeRunner([(['security', 'find-identity'], Result(0, listing))])
        self.assertEqual(credentials.signing_identity(runner, {}), IDENTITY)
        two = listing + '\n  3) 89AB "Developer ID Application: Other Maker (QWERT67890)"'
        with self.assertRaises(ReleaseError) as raised:
            credentials.signing_identity(FakeRunner([(['security', 'find-identity'], Result(0, two))]), {})
        self.assertIn('set APPLE_SIGNING_IDENTITY', raised.exception.code)
        with self.assertRaises(ReleaseError) as raised:
            credentials.signing_identity(FakeRunner([(['security', 'find-identity'], Result(0, '0 valid identities found'))]), {})
        self.assertIn('install the Developer ID Application certificate', raised.exception.code)
        self.assertEqual(credentials.team_id(IDENTITY), 'ABCDE12345')


class AssetTests(TempCase):
    def setUp(self):
        super().setUp()
        self.fixture = Fixture(self.directory)
        self.release = self.fixture.release

    def test_the_latest_dmg_is_a_byte_identical_copy_listed_in_the_checksums(self):
        directory = self.release.assets
        self.assertEqual(sorted(p.name for p in directory.iterdir()), sorted(config.asset_names(VERSION)))
        self.assertEqual((directory / LATEST_DMG).read_bytes(), (directory / self.release.dmg_name).read_bytes())
        lines = dict(reversed(line.split('  ', 1)) for line in (directory / 'SHA256SUMS').read_text().splitlines())
        self.assertEqual(set(lines), config.asset_names(VERSION) - {'SHA256SUMS'})
        self.assertEqual(lines[LATEST_DMG], lines[self.release.dmg_name])
        self.assertEqual(lines[LATEST_DMG], sha256(self.release.built_dmg))
        assets.check_assets(self.release, directory)

    def test_latest_json_points_the_updater_at_this_release_archive(self):
        document = json.loads((self.release.assets / 'latest.json').read_text())
        self.assertEqual(document['version'], VERSION)
        self.assertEqual(document['platforms']['darwin-aarch64'],
                         {'signature': 'c2lnbmF0dXJl', 'url': self.release.archive_url})

    def test_a_latest_dmg_that_differs_is_refused(self):
        (self.release.assets / LATEST_DMG).write_bytes(b'something else')
        assets.write_checksums(self.release.assets, [self.release.dmg_name, LATEST_DMG, 'TerminalX.app.tar.gz', 'TerminalX.app.tar.gz.sig', 'latest.json'])
        with self.assertRaises(ReleaseError) as raised:
            assets.check_assets(self.release, self.release.assets)
        self.assertIn('not byte-identical', raised.exception.code)

    def test_checksums_that_leave_out_the_latest_dmg_are_refused(self):
        assets.write_checksums(self.release.assets, [self.release.dmg_name, 'TerminalX.app.tar.gz', 'TerminalX.app.tar.gz.sig', 'latest.json'])
        with self.assertRaises(ReleaseError) as raised:
            assets.check_assets(self.release, self.release.assets)
        self.assertIn('every asset but itself', raised.exception.code)

    def test_a_missing_asset_is_refused(self):
        (self.release.assets / LATEST_DMG).unlink()
        with self.assertRaises(ReleaseError):
            assets.check_assets(self.release, self.release.assets)


class NotarizeTests(TempCase):
    def setUp(self):
        super().setUp()
        self.fixture = Fixture(self.directory)
        self.release = self.fixture.release
        self.release.record('notarization.json').unlink()
        key = self.directory / 'AuthKey_T.p8'
        key.write_text(PEM_KEY.format(body='BODY'))
        (self.directory / 'notary.json').write_text(json.dumps({'keyPath': str(key), 'keyId': 'KID', 'issuerId': 'ISS'}))
        self.env = {'TERMINALX_NOTARY_CONFIG': str(self.directory / 'notary.json')}

    def runner(self, verdict='Accepted', staple_code=0, validate_code=0, app_source='Notarized Developer ID'):
        def validate(argv):
            if argv[-1].endswith('.dmg') and validate_code:
                return Result(validate_code, 'TerminalX.dmg does not have a ticket stapled to it.')
            return Result(0, 'The validate action worked!')
        return FakeRunner([
            *git_responses(),
            (['xcrun', 'stapler', 'validate'], validate),
            (['spctl', '--assess', '-vvv', '--type', 'exec'], Result(0, f'accepted\nsource={app_source}')),
            (['spctl', '--assess', '-vvv', '--type', 'open'], Result(0, 'accepted\nsource=Notarized Developer ID')),
            (['xcrun', 'notarytool', 'submit'], Result(0 if verdict == 'Accepted' else 1, json.dumps({'id': 'sub-1', 'status': verdict, 'message': 'm'}))),
            (['xcrun', 'notarytool', 'log'], Result(0, '{"issues": null}')),
            (['xcrun', 'stapler', 'staple'], Result(staple_code, 'The staple and validate action worked!' if not staple_code else 'staple failed')),
        ])

    def record(self):
        return json.loads(self.release.record('notarization.json').read_text())

    def test_an_accepted_stapled_dmg_is_recorded_with_its_digest(self):
        report = notarize.notarize(self.release, self.runner(), env=self.env)
        self.assertTrue(report['accepted'])
        self.assertEqual(self.record()['dmgSha256'], sha256(self.release.built_dmg))
        self.assertEqual(self.record()['dmgSubmission']['status'], 'Accepted')
        self.assertNotIn('KID', self.release.record('notarization.json').read_text())

    def test_a_rejected_dmg_stops_the_release_before_stapling(self):
        runner = self.runner(verdict='Invalid')
        with self.assertRaises(ReleaseError) as raised:
            notarize.notarize(self.release, runner, env=self.env)
        self.assertIn('Apple did not accept the DMG: Invalid', raised.exception.code)
        self.assertFalse(runner.ran('xcrun', 'stapler', 'staple'))
        self.assertFalse(self.record()['accepted'])

    def test_a_failed_staple_or_missing_ticket_stops_the_release(self):
        with self.assertRaises(ReleaseError) as raised:
            notarize.notarize(self.release, self.runner(staple_code=65), env=self.env)
        self.assertIn('stapling the DMG failed', raised.exception.code)
        self.assertFalse(self.record()['accepted'])
        with self.assertRaises(ReleaseError) as raised:
            notarize.notarize(self.release, self.runner(validate_code=65), env=self.env)
        self.assertIn('no valid stapled notarization ticket', raised.exception.code)
        self.assertFalse(self.record()['accepted'])

    def test_an_app_the_build_did_not_notarize_stops_before_submitting_the_dmg(self):
        runner = self.runner(app_source='Developer ID')
        with self.assertRaises(ReleaseError) as raised:
            notarize.notarize(self.release, runner, env=self.env)
        self.assertIn('Gatekeeper does not accept TerminalX.app as notarized', raised.exception.code)
        self.assertFalse(runner.ran('xcrun', 'notarytool', 'submit'))

    def test_a_dmg_changed_after_stapling_is_not_the_notarized_one(self):
        notarize.notarize(self.release, self.runner(), env=self.env)
        self.release.built_dmg.write_bytes(b'rebuilt')
        with self.assertRaises(ReleaseError) as raised:
            notarize.require_notarized(self.release, HEAD, self.release.built_dmg)
        self.assertIn('is not the DMG that was notarized', raised.exception.code)


class PublishGateTests(TempCase):
    def setUp(self):
        super().setUp()
        self.fixture = Fixture(self.directory)
        self.release = self.fixture.release

    def refused(self, fragment: str):
        runner = self.fixture.runner(dry_run=False)
        with self.assertRaises(ReleaseError) as raised:
            publish.publish(self.release, runner)
        self.assertIn(fragment, raised.exception.code)
        self.assertEqual(runner.mutations, [], 'nothing may be tagged, pushed or uploaded after a failed gate')
        self.assertFalse(runner.ran('gh'))

    def test_a_dry_run_passes_every_gate_and_only_prints_the_publishing_commands(self):
        runner = self.fixture.runner(dry_run=True)
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            result = publish.publish(self.release, runner)
        self.assertTrue(result['dryRun'])
        self.assertEqual([m[:3] for m in runner.mutations], [['git', 'tag', '-a'], ['git', 'push', '--atomic'],
                                                             ['gh', 'release', 'create'], ['gh', 'release', 'edit']])
        create = runner.mutations[2]
        self.assertIn('--draft', create)
        self.assertIn(str(self.release.assets / LATEST_DMG), create)
        self.assertIn(str(self.release.assets / 'SHA256SUMS'), create)
        self.assertIn('--latest', runner.mutations[3])
        # The only gh command a dry run runs is the read-only look for a draft an earlier run left.
        self.assertEqual([c[:3] for c in runner.calls if c[0] == 'gh'], [['gh', 'release', 'view']])
        self.assertIn('[dry run] would run: git push --atomic origin main refs/tags/v9.8.7', printed.getvalue())
        self.assertFalse(self.release.record('release-result.json').exists())

    def test_refuses_without_an_accepted_notarization(self):
        write_json(self.release.record('notarization.json'), {'accepted': False, 'sourceCommit': HEAD})
        self.fixture.scan_clean()
        self.refused('does not record an accepted, stapled DMG')

    def test_refuses_a_dmg_other_than_the_stapled_one(self):
        report = json.loads(self.release.record('notarization.json').read_text())
        report['dmgSha256'] = '0' * 64
        write_json(self.release.record('notarization.json'), report)
        self.refused('is not the DMG that was notarized and stapled')

    def test_refuses_a_scan_that_found_something(self):
        self.fixture.scan_clean(clean=False, findings=[{'where': 'notes.md', 'what': 'GitHub token pattern'}])
        self.refused('GitHub token pattern in notes.md')

    def test_refuses_a_scan_that_skipped_the_assets(self):
        self.fixture.scan_clean(assetsScanned=False)
        self.refused('did not cover the release assets')

    def test_refuses_a_scan_older_than_the_assets_or_notes(self):
        time.sleep(0.01)
        self.release.record('notes.md').write_text('Edited after the scan.\n')
        self.refused('the secret scan is older than notes.md')

    def test_refuses_a_scan_that_skipped_commits_on_top_of_main(self):
        self.fixture.scan_clean(base=HEAD)
        self.refused('the secret scan did not start at bbbbbbbb')

    def test_refuses_a_missing_scan(self):
        self.release.record('secret-scan.json').unlink()
        self.refused('secret-scan.json is missing: run the scan step first')

    def test_refuses_failed_checks_or_unverified_artifacts(self):
        write_json(self.release.record('release-checks.json'), {'passed': False, 'sourceCommit': HEAD, 'steps': []})
        self.refused('does not record a pass')

    def test_refuses_unverified_artifacts(self):
        write_json(self.release.record('artifact-verification.json'), {'passed': False, 'sourceCommit': HEAD})
        self.refused('the artifacts were not verified')

    def test_refuses_a_checkout_that_moved_since_prepare(self):
        runner = FakeRunner(git_responses(head='c' * 40))
        with self.assertRaises(ReleaseError) as raised:
            publish.publish(self.release, runner)
        self.assertIn('HEAD moved', raised.exception.code)
        self.assertEqual(runner.mutations, [])

    def test_refuses_a_branch_other_than_main_or_a_dirty_tree(self):
        for responses, fragment in [(git_responses(branch='feature'), 'releases are built from main'),
                                    (git_responses(status=' M README.md'), 'uncommitted changes')]:
            runner = FakeRunner(responses)
            with self.assertRaises(ReleaseError) as raised:
                publish.publish(self.release, runner)
            self.assertIn(fragment, raised.exception.code)
            self.assertEqual(runner.mutations, [])

    def test_publishes_and_marks_latest_only_after_the_download_matches(self):
        downloaded = self.release.record('downloaded')

        def fake_download(argv):
            shutil.copytree(self.release.assets, downloaded)
            return Result(0, '')
        runner = FakeRunner([
            *self.fixture.runner().responses,
            (['gh', 'release', 'download'], fake_download),
            (['node'], Result(0, json.dumps({'signatureVerified': True, 'sha256': 'x'}))),
            (['gh', 'release', 'view'], Result(0, 'https://github.com/terminalx-ai/terminalx/releases/tag/v9.8.7')),
            (['git', 'tag'], Result(0, '')), (['git', 'push'], Result(0, '')),
            (['gh', 'release', 'create'], Result(0, '')), (['gh', 'release', 'edit'], Result(0, '')),
        ])
        result = publish.publish(self.release, runner)
        self.assertTrue(result['uploadVerification']['allAssetsMatchLocal'])
        order = [c[:3] for c in runner.calls if c[0] in ('gh', 'git') and c[1] in ('release', 'push', 'tag')]
        self.assertEqual(order, [['git', 'tag', '-a'], ['git', 'push', '--atomic'], ['gh', 'release', 'view'], ['gh', 'release', 'create'],
                                 ['gh', 'release', 'download'], ['gh', 'release', 'edit'], ['gh', 'release', 'view']])
        self.assertTrue(self.release.record('release-result.json').exists())

    def test_running_publish_again_reuses_the_draft_an_earlier_run_left(self):
        # The first run pushed and created the draft, then stopped: the draft holds a stray file and
        # misses SHA256SUMS. The second run must bring it back to exactly this release, not fail.
        names = sorted(p.name for p in self.release.assets.iterdir())
        draft = {'isDraft': True, 'assets': [{'name': n} for n in names if n != 'SHA256SUMS'] + [{'name': 'stray.txt'}]}
        runner = self.fixture.runner(dry_run=True, tag_exists=True, on_github=draft)
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            publish.publish(self.release, runner)
        self.assertIn('Reusing the draft release v9.8.7', printed.getvalue())
        self.assertEqual([m[:3] for m in runner.mutations], [['git', 'push', '--atomic'], ['gh', 'release', 'delete-asset'],
                                                             ['gh', 'release', 'edit'], ['gh', 'release', 'upload'],
                                                             ['gh', 'release', 'edit']])
        self.assertEqual(runner.mutations[1][3:5], ['v9.8.7', 'stray.txt'])
        self.assertIn('--notes-file', runner.mutations[2])
        self.assertNotIn('--latest', runner.mutations[2])
        upload = runner.mutations[3]
        self.assertIn('--clobber', upload)
        self.assertEqual(sorted(Path(a).name for a in upload if a.startswith(str(self.release.assets))), names)
        self.assertIn('--latest', runner.mutations[4])

    def test_refuses_to_touch_a_release_already_published(self):
        runner = self.fixture.runner(dry_run=False, tag_exists=True, on_github={'isDraft': False, 'assets': []})
        runner.responses.append((['git', 'push'], Result(0, 'Everything up-to-date')))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ReleaseError) as raised:
            publish.publish(self.release, runner)
        self.assertIn('v9.8.7 is already published on GitHub; run the verify-live step', raised.exception.code)
        self.assertEqual([m[:2] for m in runner.mutations], [['git', 'push']])

    def test_a_failed_look_for_the_draft_stops_before_uploading(self):
        runner = self.fixture.runner(dry_run=True)
        runner.responses.insert(0, (['gh', 'release', 'view'], Result(1, 'HTTP 502: Bad Gateway')))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ReleaseError) as raised:
            publish.publish(self.release, runner)
        self.assertIn('gh release view exited 1: HTTP 502', raised.exception.code)
        self.assertFalse(any(m[:2] == ['gh', 'release'] for m in runner.mutations))

    def test_a_download_that_differs_never_becomes_latest(self):
        downloaded = self.release.record('downloaded')

        def corrupted(argv):
            shutil.copytree(self.release.assets, downloaded)
            (downloaded / LATEST_DMG).write_bytes(b'truncated')
            return Result(0, '')
        runner = FakeRunner([
            *self.fixture.runner().responses,
            (['gh', 'release', 'download'], corrupted),
            (['git', 'tag'], Result(0, '')), (['git', 'push'], Result(0, '')), (['gh', 'release', 'create'], Result(0, '')),
        ])
        with self.assertRaises(ReleaseError):
            publish.publish(self.release, runner)
        self.assertFalse(runner.ran('gh', 'release', 'edit'))


class VerifyLiveTests(TempCase):
    def test_the_stable_link_must_serve_the_published_dmg(self):
        fixture = Fixture(self.directory)
        release = fixture.release
        served = {release.feed_url: release.assets / 'latest.json',
                  release.archive_url: release.assets / 'TerminalX.app.tar.gz',
                  release.archive_url + '.sig': release.assets / 'TerminalX.app.tar.gz.sig',
                  config.STABLE_DOWNLOAD_URL: release.assets / LATEST_DMG}

        def curl(argv):
            Path(argv[argv.index('--output') + 1]).write_bytes(served[argv[argv.index('--output') - 1]].read_bytes())
            return Result(0, '')
        responses = [(['curl'], curl), (['node'], Result(0, json.dumps({'signatureVerified': True, 'sha256': 'x'}))),
                     (['xcrun', 'stapler', 'validate'], Result(0, 'The validate action worked!')),
                     (['spctl'], Result(0, 'accepted\nsource=Notarized Developer ID'))]
        report = publish.verify_live(release, FakeRunner(responses))
        self.assertEqual(report['stableDownload'], config.STABLE_DOWNLOAD_URL)
        stale = self.directory / 'stale.dmg'
        stale.write_bytes(b'an older release')
        served[config.STABLE_DOWNLOAD_URL] = stale
        with self.assertRaises(ReleaseError) as raised:
            publish.verify_live(release, FakeRunner(responses))
        self.assertIn(f'the live {LATEST_DMG} differs', raised.exception.code)


GIT = ['git', '-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false',
       '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main']


class GitRunner(FakeRunner):
    """Runs git for real, in a scratch repository; answers everything else from its responses."""

    def execute(self, argv, *, cwd, env, log):
        if argv[0] == 'git':
            self.calls.append(argv)
            return Runner.execute(self, argv, cwd=cwd, env=env, log=log)
        return super().execute(argv, cwd=cwd, env=env, log=log)

    def execute_bytes(self, argv, *, cwd, input):
        if argv[0] != 'git':
            raise AssertionError(f'unexpected command: {argv}')
        self.calls.append(argv)
        return Runner.execute_bytes(self, argv, cwd=cwd, input=input)


def zip_bytes(members: dict[str, bytes], encrypted: bool = False) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    data = bytearray(buffer.getvalue())
    if encrypted:
        # Set the "encrypted" flag on the first member's local and central headers.
        for offset in (0, data.rindex(b'PK\x01\x02')):
            flag_at = offset + (6 if offset == 0 else 8)
            data[flag_at] |= 1
    return bytes(data)


def tar_gz_bytes(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def png_bytes(text_chunk: bytes = b'') -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    header = struct.pack('>IIBBBBB', 1, 1, 8, 0, 0, 0, 0)
    chunks = chunk(b'IHDR', header)
    if text_chunk:
        chunks += chunk(b'zTXt', b'Comment\x00\x00' + zlib.compress(text_chunk))
    return b'\x89PNG\r\n\x1a\n' + chunks + chunk(b'IDAT', zlib.compress(b'\x00\x00')) + chunk(b'IEND', b'')


class SecretScanTests(TempCase):
    SECRET = 'not-a-real-secret-value-0123456789'

    def setUp(self):
        super().setUp()
        self.fixture = Fixture(self.directory)
        self.release = self.fixture.release
        self.root = self.release.root
        self.git('init', '-q')
        (self.root / '.gitignore').write_text('/.raccoon/\n')
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'Published main')
        self.base = self.git('rev-parse', 'HEAD')
        write_json(self.release.record('release-context.json'), {'version': VERSION, 'baseMainCommit': self.base, 'sourceCommit': self.base})

    def git(self, *args: str) -> str:
        return subprocess.run([*GIT, *args], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, files: dict[str, bytes | None], message: str = 'Release commit') -> str:
        for name, data in files.items():
            path = self.root / name
            if data is None:
                path.unlink()
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.git('add', '-A')
        self.git('commit', '-q', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def blob(self, name: str, rev: str = 'HEAD') -> str:
        return self.git('rev-parse', f'{rev}:{name}')[:8]

    def runner(self):
        return GitRunner([(['hdiutil'], Result(0, ''))])

    def scan(self, runner=None, **kwargs):
        return secrets_scan.scan(self.release, runner or self.runner(), {'test secret': self.SECRET}, Path('/Users/example-person'), **kwargs)

    def assertFound(self, result, where: str, what: str):
        self.assertIn({'where': where, 'what': what}, result['findings'])
        self.assertFalse(result['clean'])

    def test_a_clean_release_passes_and_covers_every_asset(self):
        head = self.commit({'CHANGELOG.md': b'# TerminalX changelog\n\n## 9.8.7\n\n- Clean.\n', 'icon.png': png_bytes()})
        result = self.scan()
        self.assertTrue(result['clean'], result['findings'])
        self.assertTrue(result['assetsScanned'])
        self.assertEqual((result['base'], result['head']), (self.base, head))
        secrets_scan.require_clean_scan(self.release, head, sorted(self.release.assets.iterdir()))

    def test_finds_a_local_secret_without_ever_writing_it(self):
        self.commit({'src/config.ts': f'export const token = "{self.SECRET}"\n'.encode()})
        result = self.scan()
        self.assertFound(result, f'git src/config.ts ({self.blob("src/config.ts")})', 'test secret')
        self.assertNotIn(self.SECRET, self.release.record('secret-scan.json').read_text())

    def test_finds_a_secret_inside_a_binary_file(self):
        blob = b'\xcf\xfa\xed\xfe' + bytes(4096) + self.SECRET.encode() + b'\x00' + bytes(range(16)) * 256
        self.commit({'resources/model.bin': blob})
        self.assertIn('Binary files', self.git('diff', f'{self.base}..HEAD'), 'git diff alone would not show this file')
        self.assertFound(self.scan(), f'git resources/model.bin ({self.blob("resources/model.bin")})', 'test secret')

    def test_finds_a_secret_inside_a_nested_archive(self):
        inner = tar_gz_bytes({'bundle/settings.json': f'{{"awsKey": "{AWS_SHAPED}"}}'.encode()})
        outer = zip_bytes({'vendor/bundle.tar.gz': inner, 'README.txt': b'nothing here'})
        self.commit({'fixtures/vendor.zip': outer})
        where = f'git fixtures/vendor.zip ({self.blob("fixtures/vendor.zip")})!vendor/bundle.tar.gz!gunzip!bundle/settings.json'
        self.assertFound(self.scan(), where, 'AWS access key pattern')

    def test_finds_a_secret_inside_a_png_text_chunk(self):
        self.commit({'docs/shot.png': png_bytes(f'token={self.SECRET}'.encode())})
        self.assertFound(self.scan(), f'git docs/shot.png ({self.blob("docs/shot.png")})!zTXt Comment', 'test secret')

    def test_finds_a_secret_a_later_commit_removed_again(self):
        self.commit({'notes/scratch.txt': f'{self.SECRET}\n'.encode()}, 'Add scratch')
        removed = self.git('rev-parse', 'HEAD:notes/scratch.txt')[:8]
        self.commit({'notes/scratch.txt': None}, 'Remove scratch')
        self.assertFound(self.scan(), f'git notes/scratch.txt ({removed})', 'test secret')

    def test_a_pattern_already_on_main_is_not_new_but_a_new_one_is(self):
        self.commit({'docs/example.md': f'old: {AWS_SHAPED}\n'.encode()}, 'On main already')
        self.base = self.git('rev-parse', 'HEAD')
        write_json(self.release.record('release-context.json'), {'version': VERSION, 'baseMainCommit': self.base, 'sourceCommit': self.base})
        self.commit({'docs/example.md': f'old: {AWS_SHAPED}\nunrelated edit\n'.encode()})
        self.assertTrue(self.scan()['clean'])
        self.commit({'docs/example.md': f'old: {AWS_SHAPED}\nnew: AKIA{"Z" * 16}\n'.encode()})
        self.assertFound(self.scan(), f'git docs/example.md ({self.blob("docs/example.md")})', 'AWS access key pattern')

    def test_a_file_the_scan_cannot_open_fails_unless_its_format_is_allowed(self):
        self.commit({'vendor/tools.7z': b"7z\xbc\xaf'\x1c" + bytes(64)})
        self.assertFound(self.scan(), f'git vendor/tools.7z ({self.blob("vendor/tools.7z")})',
                         '7z archive the scan cannot open; add it to ALLOWED_OPAQUE with a reason, or do not publish it')
        self.commit({'vendor/tools.7z': None, 'vendor/blob.dat': os.urandom(64 << 10)})
        self.assertFound(self.scan(), f'git vendor/blob.dat ({self.blob("vendor/blob.dat")})',
                         'compressed or encrypted data in no format the scan knows; recognise its format in content.sniff() '
                         'and either open it (OPENERS) or name it in ALLOWED_OPAQUE with a reason, or do not publish it')
        # The earlier commits are still pushed, so their files still count; the allowed JPEG adds nothing.
        self.commit({'vendor/blob.dat': None, 'docs/photo.jpg': b'\xff\xd8\xff\xe0' + os.urandom(64 << 10)})
        self.assertEqual([f for f in self.scan()['findings'] if 'docs/photo.jpg' in f['where']], [])
        self.assertIn('JPEG image', content.ALLOWED_OPAQUE)

    def test_an_archive_the_scan_cannot_read_fails(self):
        self.commit({'fixtures/locked.zip': zip_bytes({'key.txt': b'hidden'}, encrypted=True),
                     'fixtures/cut.gz': gzip.compress(os.urandom(100000))[:200]})
        result = self.scan()
        self.assertTrue(any(f['where'] == f'git fixtures/locked.zip ({self.blob("fixtures/locked.zip")})'
                            and f['what'].startswith('unreadable zip archive (key.txt is encrypted)') for f in result['findings']), result['findings'])
        self.assertTrue(any(f['where'] == f'git fixtures/cut.gz ({self.blob("fixtures/cut.gz")})'
                            and f['what'].startswith('unreadable gzip stream') for f in result['findings']), result['findings'])

    def test_an_archive_that_expands_too_far_fails(self):
        self.commit({'fixtures/zeros.gz': gzip.compress(bytes(1 << 20))})
        original = content.MAX_EXPANDED
        content.MAX_EXPANDED = 1 << 16
        self.addCleanup(setattr, content, 'MAX_EXPANDED', original)
        result = self.scan()
        self.assertTrue(any('expands past' in f['what'] for f in result['findings']), result['findings'])

    def test_finds_secrets_inside_assets_and_notes(self):
        signature = self.release.assets / 'TerminalX.app.tar.gz.sig'
        signature.write_bytes(self.SECRET.encode())
        self.release.record('notes.md').write_text(f'Key: {AWS_SHAPED}\n')
        result = self.scan()
        self.assertFound(result, 'asset TerminalX.app.tar.gz.sig', 'test secret')
        self.assertFound(result, 'notes.md', 'AWS access key pattern')

    def test_a_home_path_counts_in_commits_and_notes_but_not_inside_binaries(self):
        self.commit({'docs/setup.md': b'cd /Users/example-person/code\n'})
        self.assertFound(self.scan(), f'git docs/setup.md ({self.blob("docs/setup.md")})', 'home directory path')
        self.commit({'docs/setup.md': None})
        self.release.built_dmg.write_bytes(b'/Users/example-person/.cargo/registry panic path')
        assets.copy_assets(self.release, self.release.assets, 'n', pub_date='2026-11-11T00:00:00Z')
        self.assertEqual([f for f in self.scan()['findings'] if 'docs/setup.md' not in f['where']], [])

    def test_finds_a_secret_inside_the_updater_archive_and_archives_within_it(self):
        resources = 'TerminalX.app/Contents/Resources/'
        make_archive(self.release.assets / 'TerminalX.app.tar.gz', {
            resources + 'config.json': f'{{"k": "{self.SECRET}"}}'.encode(),
            resources + 'skills.zip': zip_bytes({'skill/notes.md': f'key {AWS_SHAPED}'.encode()}),
        })
        result = self.scan()
        archive = 'asset TerminalX.app.tar.gz (archive)!gunzip!'
        self.assertFound(result, archive + resources + 'config.json', 'test secret')
        self.assertFound(result, archive + resources + 'skills.zip!skill/notes.md', 'AWS access key pattern')

    def test_the_identical_latest_dmg_is_scanned_once(self):
        runner = self.runner()
        result = self.scan(runner)
        attaches = [c for c in runner.calls if c[:2] == ['hdiutil', 'attach']]
        self.assertEqual(len(attaches), 1)
        self.assertTrue(result['clean'], result['findings'])

    def test_a_commits_only_scan_cannot_clear_a_publish(self):
        head = self.commit({'README.md': b'Hello.\n'})
        self.scan(include_assets=False, base=self.base)
        with self.assertRaises(ReleaseError):
            secrets_scan.require_clean_scan(self.release, head, [])

    def test_the_slack_prefixes_the_app_uses_on_purpose_do_not_match(self):
        scanner = secrets_scan.Scanner({})
        scanner.scan('source', b"const prefixes = ['xoxb-', 'xoxp-'];")
        self.assertEqual(scanner.findings, [])
        scanner.scan('source', SLACK_SHAPED.encode())
        self.assertEqual(scanner.findings, [{'where': 'source', 'what': 'Slack token pattern'}])


def mach_o(body: bytes, filetype=2) -> bytes:
    """A 64-bit arm64 Mach-O header with one load command, then ``body``."""
    command = struct.pack('<II', 0x19, 72) + bytes(64)
    return struct.pack('<IiiIIIII', 0xfeedfacf, 0x0100000c, 0, filetype, 1, len(command), 0, 0) + command + body


class ContentTests(unittest.TestCase):
    """The format checks an executable or a video passes, and the high-entropy data it would otherwise be."""

    def inspect(self, data: bytes) -> list[str]:
        inspector = content.Inspector({'test secret': b'tx-test-secret-value'}, dict(secrets_scan.PATTERNS))
        inspector.inspect('file', data)
        return [hit.what for hit in inspector.hits]

    def test_an_executable_with_compressed_data_inside_is_searched_and_allowed(self):
        # The main app executable measures about 7.3 bits per byte (Tauri compresses the frontend
        # into it); a larger frontend must not stop a release, and its bytes are still searched.
        payload = zlib.compress(os.urandom(256 << 10), 9)
        self.assertGreater(content.entropy(mach_o(payload)), content.OPAQUE_ENTROPY)
        self.assertEqual(content.sniff(mach_o(payload)), 'Mach-O executable')
        self.assertEqual(self.inspect(mach_o(payload)), [])
        self.assertEqual(self.inspect(mach_o(payload + b'tx-test-secret-value' + payload)), ['test secret'])
        fat = struct.pack('>II', 0xcafebabe, 1) + struct.pack('>iiIII', 0x0100000c, 0, 4096, len(mach_o(payload)), 14)
        fat += bytes(4096 - len(fat)) + mach_o(payload)
        self.assertEqual(content.sniff(fat), 'Mach-O executable')
        self.assertEqual(content.sniff(b'\x7fELF\x02\x01\x01' + payload), 'ELF executable')
        self.assertIn('Mach-O executable', content.ALLOWED_OPAQUE)

    def test_only_a_well_formed_header_counts_as_an_executable(self):
        noise = os.urandom(64 << 10)
        for data in (b'\xcf\xfa\xed\xfe' + noise,              # Mach-O magic, nonsense header
                     mach_o(noise, filetype=0),                  # no such file type
                     b'\xca\xfe\xba\xbe\x00\x00\x00\x34' + noise,  # a Java class file (version 52)
                     b'\x7fELF\x09' + noise):                     # ELF magic, no such class
            self.assertIsNone(content.sniff(data), data[:8])
            self.assertEqual(len(self.inspect(data)), 1)
            self.assertTrue(self.inspect(data)[0].startswith('compressed or encrypted data in no format the scan knows'))

    def test_a_video_is_searched_and_allowed(self):
        samples = os.urandom(128 << 10)
        mp4 = struct.pack('>I', 24) + b'ftypisom' + bytes(12) + struct.pack('>I', 8 + len(samples)) + b'mdat' + samples
        self.assertEqual(content.sniff(mp4), 'ISO media file')
        self.assertEqual(self.inspect(mp4), [])
        self.assertEqual(self.inspect(mp4 + f'udta {AWS_SHAPED}'.encode()), ['AWS access key pattern'])
        self.assertEqual(content.sniff(b'\x1a\x45\xdf\xa3' + samples), 'Matroska or WebM video')
        self.assertIsNone(content.sniff(struct.pack('>I', 3) + b'ftyp' + samples))


class SourceTests(TempCase):
    def test_every_serve_test_the_release_runs_exists(self):
        for name in source.SERVE_TESTS:
            self.assertTrue((REPO_ROOT / f'src-tauri/serve/tests/{name}.rs').is_file(), name)

    def test_every_check_names_a_script_or_file_in_the_repository(self):
        release = config.Release(root=REPO_ROOT, version=VERSION, out=self.directory, target_dir=self.directory)
        scripts = json.loads((REPO_ROOT / 'package.json').read_text())['scripts']
        for name, argv, _ in source.check_steps(release):
            if argv[:1] == ['pnpm'] and len(argv) == 2:
                self.assertIn(argv[1], scripts, name)
            for arg in argv:
                if arg.startswith('scripts/') or arg.startswith('native/'):
                    self.assertTrue((REPO_ROOT / arg).exists(), f'{name}: {arg}')

    def test_prepare_refuses_without_a_changelog_section(self):
        write_repo(self.directory)
        (self.directory / 'CHANGELOG.md').write_text('# TerminalX changelog\n\n## Unreleased\n')
        release = config.load(self.directory, env={'TERMINALX_RELEASE_TARGET_DIR': str(self.directory / 't')})
        runner = FakeRunner([*git_responses(), (['git', 'fetch'], Result(0, '')), (['git', 'rev-parse', 'origin/main'], Result(0, BASE)),
                             (['git', 'merge-base'], Result(0, ''))])
        with self.assertRaises(ReleaseError) as raised:
            source.prepare(release, runner)
        self.assertIn(f'no "## {VERSION}" section', raised.exception.code)

    def test_prepare_refuses_a_head_without_origin_main(self):
        write_repo(self.directory)
        release = config.load(self.directory, env={'TERMINALX_RELEASE_TARGET_DIR': str(self.directory / 't')})
        runner = FakeRunner([*git_responses(), (['git', 'fetch'], Result(0, '')), (['git', 'rev-parse', 'origin/main'], Result(0, BASE)),
                             (['git', 'merge-base'], Result(1, ''))])
        with self.assertRaises(ReleaseError) as raised:
            source.prepare(release, runner)
        self.assertIn('does not contain origin/main', raised.exception.code)
        runner = FakeRunner([*git_responses(), (['git', 'fetch'], Result(0, '')), (['git', 'rev-parse', 'origin/main'], Result(0, BASE)),
                             (['git', 'merge-base'], Result(0, ''))])
        context = source.prepare(release, runner)
        self.assertEqual((context['baseMainCommit'], context['sourceCommit']), (BASE, HEAD))


class CommandLineTests(unittest.TestCase):
    def test_dry_run_is_only_for_publish(self):
        with contextlib.redirect_stderr(io.StringIO()) as printed:
            self.assertEqual(cli.main(['build', '--dry-run']), 1)
        self.assertIn('--dry-run applies to the publish step only', printed.getvalue())

    def test_the_committed_tooling_names_no_home_directory(self):
        home = str(Path.home())
        for path in Path(__file__).resolve().parent.rglob('*'):
            if path.is_file() and path.suffix in ('.py', '.mjs', '.sh') and len(home) > len('/Users/'):
                self.assertNotIn(home, path.read_text(), path.name)


if __name__ == '__main__':
    unittest.main()
