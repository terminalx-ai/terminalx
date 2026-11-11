"""The notarize step: check the app Tauri notarized, then notarize, staple and check the DMG.

Every outcome other than "Apple accepted it, the ticket is stapled and Gatekeeper rates it Notarized
Developer ID" stops the release. notarization.json records the verdicts and the DMG's SHA-256 after
stapling; publish refuses any DMG whose bytes differ from it.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from . import credentials
from .config import Release, ReleaseError
from .proc import Runner, now, read_record, require, sha256, write_json
from .source import pinned_source

NOTARIZED = 'source=Notarized Developer ID'
STAPLED = 'The validate action worked'


def gatekeeper_app(runner: Runner, app: Path) -> str:
    result = runner.run(['spctl', '--assess', '-vvv', '--type', 'exec', app], check=False)
    require(result.code == 0 and NOTARIZED in result.output, f'Gatekeeper does not accept {app.name} as notarized: {result.output}')
    return result.output


def gatekeeper_dmg(runner: Runner, dmg: Path) -> str:
    result = runner.run(['spctl', '--assess', '-vvv', '--type', 'open', '--context', 'context:primary-signature', dmg], check=False)
    require(result.code == 0 and NOTARIZED in result.output, f'Gatekeeper does not accept {dmg.name} as notarized: {result.output}')
    return result.output


def stapled(runner: Runner, path: Path) -> str:
    result = runner.run(['xcrun', 'stapler', 'validate', path], check=False)
    require(result.code == 0 and STAPLED in result.output, f'{path.name} has no valid stapled notarization ticket: {result.output}')
    return result.output


def assess(runner: Runner, dmg: Path, app: Path | None = None) -> dict:
    """Stapling and Gatekeeper checks on a DMG and the app inside it (or a given app)."""
    report = {'dmgStapled': stapled(runner, dmg), 'dmgGatekeeper': gatekeeper_dmg(runner, dmg)}
    if app is not None:
        report['appStapled'] = stapled(runner, app)
        report['appGatekeeper'] = gatekeeper_app(runner, app)
    return report


def notarize(release: Release, runner: Runner, env=os.environ) -> dict:
    pinned_source(release, runner)
    meta = read_record(release.record('build-metadata.json'), 'build')
    require(meta.get('exitCode') == 0 and meta.get('version') == release.version, 'the build did not finish; run the build step')
    key = credentials.notary_key(env)
    dmg, app = release.built_dmg, release.built_app
    report: dict = {'version': release.version, 'sourceCommit': meta['sourceCommit'], 'startedAt': now(), 'accepted': False}
    record = release.record('notarization.json')
    # Written now so that a failure below leaves a record that says so, never an old pass.
    write_json(record, report)

    # The app comes out of the build already notarized and stapled.
    report['appStapled'] = stapled(runner, app)
    report['appGatekeeper'] = gatekeeper_app(runner, app)

    submitted = runner.run(['xcrun', 'notarytool', 'submit', dmg, *key.notarytool_args(), '--wait', '--timeout', '45m',
                            '--output-format', 'json'], check=False)
    try:
        verdict = json.loads(submitted.output)
    except json.JSONDecodeError:
        raise ReleaseError(f'notarytool submit exited {submitted.code} without a verdict: {submitted.output[-2000:]}') from None
    report['dmgSubmission'] = {k: verdict.get(k) for k in ('id', 'status', 'message')}
    if verdict.get('id'):
        log = runner.run(['xcrun', 'notarytool', 'log', verdict['id'], *key.notarytool_args()], check=False)
        release.record('notarization-dmg-log.json').write_text(log.output + '\n')
    write_json(record, report)
    require(submitted.code == 0 and verdict.get('status') == 'Accepted',
            f'Apple did not accept the DMG: {verdict.get("status")}: {verdict.get("message")} (log in notarization-dmg-log.json)')

    staple = runner.run(['xcrun', 'stapler', 'staple', dmg], check=False)
    report['dmgStaple'] = staple.output
    require(staple.code == 0, f'stapling the DMG failed: {staple.output}')
    report.update(assess(runner, dmg))
    report['dmgSha256'] = sha256(dmg)
    report['accepted'] = True
    report['finishedAt'] = now()
    write_json(record, report)
    return report


def require_notarized(release: Release, source: str, dmg: Path) -> dict:
    report = read_record(release.record('notarization.json'), 'notarize')
    require(report.get('accepted') is True, 'notarization.json does not record an accepted, stapled DMG; run the notarize step')
    require(report.get('dmgSubmission', {}).get('status') == 'Accepted', 'Apple did not accept the DMG')
    require(report.get('sourceCommit') == source, 'the notarized build is from a different commit')
    require(report.get('dmgSha256') == sha256(dmg), f'{dmg.name} is not the DMG that was notarized and stapled')
    return report
