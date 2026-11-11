"""Tests for the release pipeline (scripts/release/txrelease). They run anywhere, macOS or not: every
command goes through a fake runner, so nothing is built, notarized, pushed or uploaded.

    python3 -m unittest discover -s scripts/release -p 'test_*.py'
"""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import release as cli  # noqa: E402
from txrelease import assets, config, credentials, notarize, publish, secrets_scan, source  # noqa: E402
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

    def runner(self, dry_run=True, tag_exists=False) -> FakeRunner:
        return FakeRunner([
            *git_responses(),
            (['git', 'rev-parse', '-q', '--verify'], Result(0 if tag_exists else 1, '')),
            (['git', 'rev-parse', f'{self.release.tag}^{{}}'], Result(0, HEAD)),
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
        self.assertFalse(runner.ran('gh'))
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
        self.assertEqual(order, [['git', 'tag', '-a'], ['git', 'push', '--atomic'], ['gh', 'release', 'create'],
                                 ['gh', 'release', 'download'], ['gh', 'release', 'edit'], ['gh', 'release', 'view']])
        self.assertTrue(self.release.record('release-result.json').exists())

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


class SecretScanTests(TempCase):
    SECRET = 'not-a-real-secret-value-0123456789'

    def setUp(self):
        super().setUp()
        self.fixture = Fixture(self.directory)
        self.release = self.fixture.release

    def runner(self, diff='', messages=''):
        return FakeRunner([
            (['git', 'diff'], Result(0, diff)),
            (['git', 'log'], Result(0, messages)),
            (['git', 'rev-parse', 'HEAD'], Result(0, HEAD)),
            (['hdiutil'], Result(0, '')),
        ])

    def scan(self, runner, **kwargs):
        return secrets_scan.scan(self.release, runner, {'test secret': self.SECRET}, Path('/Users/example-person'), **kwargs)

    def test_a_clean_release_passes_and_covers_every_asset(self):
        result = self.scan(self.runner())
        self.assertTrue(result['clean'], result['findings'])
        self.assertTrue(result['assetsScanned'])
        self.assertEqual(result['base'], BASE)
        secrets_scan.require_clean_scan(self.release, HEAD, sorted(self.release.assets.iterdir()))

    def test_finds_a_local_secret_without_ever_writing_it(self):
        result = self.scan(self.runner(diff=f'+token = "{self.SECRET}"'))
        self.assertFalse(result['clean'])
        self.assertIn({'where': f'git diff {BASE[:8]}..HEAD', 'what': 'test secret'}, result['findings'])
        self.assertNotIn(self.SECRET, self.release.record('secret-scan.json').read_text())

    def test_finds_secrets_inside_assets_and_notes(self):
        signature = self.release.assets / 'TerminalX.app.tar.gz.sig'
        signature.write_bytes(self.SECRET.encode())
        self.release.record('notes.md').write_text(f'Key: {AWS_SHAPED}\n')
        result = self.scan(self.runner())
        self.assertIn({'where': 'asset TerminalX.app.tar.gz.sig', 'what': 'test secret'}, result['findings'])
        self.assertIn({'where': 'notes.md', 'what': 'AWS access key pattern'}, result['findings'])

    def test_a_home_path_counts_in_commits_and_notes_but_not_inside_binaries(self):
        result = self.scan(self.runner(diff='+cd /Users/example-person/code'))
        self.assertIn({'where': f'git diff {BASE[:8]}..HEAD', 'what': 'home directory path'}, result['findings'])
        self.release.built_dmg.write_bytes(b'/Users/example-person/.cargo/registry panic path')
        assets.copy_assets(self.release, self.release.assets, 'n', pub_date='2026-11-11T00:00:00Z')
        self.assertTrue(self.scan(self.runner())['clean'])

    def test_finds_a_secret_inside_the_updater_archive(self):
        make_archive(self.release.assets / 'TerminalX.app.tar.gz',
                     {'TerminalX.app/Contents/Resources/config.json': f'{{"k": "{self.SECRET}"}}'.encode()})
        result = self.scan(self.runner())
        self.assertIn({'where': 'archive TerminalX.app/Contents/Resources/config.json', 'what': 'test secret'}, result['findings'])

    def test_the_identical_latest_dmg_is_scanned_once(self):
        runner = self.runner()
        result = self.scan(runner)
        attaches = [c for c in runner.calls if c[:2] == ['hdiutil', 'attach']]
        self.assertEqual(len(attaches), 1)
        self.assertTrue(result['clean'])

    def test_a_commits_only_scan_cannot_clear_a_publish(self):
        self.scan(self.runner(), include_assets=False, base='HEAD~1')
        with self.assertRaises(ReleaseError):
            secrets_scan.require_clean_scan(self.release, HEAD, [])

    def test_the_slack_prefixes_the_app_uses_on_purpose_do_not_match(self):
        scanner = secrets_scan.Scanner({})
        scanner.scan('source', b"const prefixes = ['xoxb-', 'xoxp-'];")
        self.assertEqual(scanner.findings, [])
        scanner.scan('source', SLACK_SHAPED.encode())
        self.assertEqual(scanner.findings, [{'where': 'source', 'what': 'Slack token pattern'}])


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
