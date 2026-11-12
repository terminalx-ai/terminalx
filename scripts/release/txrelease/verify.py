"""The verify step: check the shipped artifacts themselves, not the build directory around them.

The updater archive is extracted and the DMG mounted; both must hold the same, Developer ID signed,
notarized and stapled app, so an in-app update installs exactly what the download page offers.
"""
from __future__ import annotations

import json
import os
import plistlib
import shutil
import tempfile
from pathlib import Path

from .config import BUNDLE_IDENTIFIER, SIGNATURE, Release
from .credentials import team_id
from .notarize import gatekeeper_app, gatekeeper_dmg, require_notarized, stapled
from .proc import Runner, now, read_record, require, sha256, write_json
from .source import pinned_source


def agent_browser_version(root: Path) -> str:
    package = json.loads((root / 'package.json').read_text())
    version = package.get('dependencies', {}).get('agent-browser') or package.get('devDependencies', {}).get('agent-browser')
    require(isinstance(version, str) and bool(version.strip()), 'package.json has no agent-browser version to verify')
    return version


def updater_signature(release: Release, runner: Runner, archive: Path) -> dict:
    script = release.root / 'scripts/release/verify-updater.mjs'
    return json.loads(runner.out('node', script, archive, cwd=release.root))


def members(base: Path) -> dict[str, str]:
    return {str(p.relative_to(base)): ('symlink:' + os.readlink(p) if p.is_symlink() else sha256(p))
            for p in base.rglob('*') if p.is_file() or p.is_symlink()}


def verify(release: Release, runner: Runner) -> dict:
    source = pinned_source(release, runner)
    meta = read_record(release.record('build-metadata.json'), 'build')
    require(meta.get('exitCode') == 0 and meta.get('sourceCommit') == source, 'the build is not from the pinned commit')
    identity = read_record(release.record('signing-config.json'), 'build')['bundle']['macOS']['signingIdentity']
    team = team_id(identity)
    dmg, archive = release.built_dmg, release.built_archive
    require_notarized(release, source, dmg)
    record = release.record('artifact-verification.json')
    checks: dict = {'version': release.version, 'sourceCommit': source, 'passed': False, 'startedAt': now()}
    write_json(record, checks)

    extract = release.record('extracted')
    if extract.exists():
        shutil.rmtree(extract)
    extract.mkdir()
    runner.run(['tar', '-xzf', archive, '-C', extract])
    app = extract / 'TerminalX.app'
    helper = app / 'Contents/Resources/TerminalX Computer Use Helper.app'
    local_runtime = app / 'Contents/Resources/local-runtime/terminalx-serve'
    launcher = app / 'Contents/MacOS/terminalx'
    require(not launcher.is_symlink(), 'the CLI launcher is a symlink; the updater archive would lose its signature')
    require('Mach-O 64-bit executable arm64' in runner.out('file', launcher), 'the CLI launcher is not an arm64 Mach-O')

    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    require(info['CFBundleShortVersionString'] == release.version, f'Info.plist says {info["CFBundleShortVersionString"]}')
    require(info['CFBundleIdentifier'] == BUNDLE_IDENTIFIER, f'bundle identifier is {info["CFBundleIdentifier"]}')
    checks['bundleIdentifier'] = info['CFBundleIdentifier']
    checks['icons'] = json.loads(runner.out('python3', 'scripts/verify_packaged_icons.py', 'macos', app, cwd=release.root))

    for label, path in [('app', app), ('helper', helper), ('localRuntime', local_runtime), ('cliLauncher', launcher), ('dmg', dmg)]:
        runner.run(['codesign', '--verify', '--deep', '--strict', path])
        details = runner.out('codesign', '-dv', '--verbose=4', path)
        require(f'Authority={identity}' in details and f'TeamIdentifier={team}' in details, f'{label} is not signed by the release identity')
        checks[label + 'CodeSignatureVerified'] = True
    printed = runner.out('codesign', '-d', '--entitlements', ':-', app)
    start, end = printed.find('<?xml'), printed.rfind('</plist>')
    require(start >= 0 and end > start, 'codesign printed no entitlements plist for the app')
    entitlements = plistlib.loads(printed[start:end + len('</plist>')].encode())
    require(entitlements.get('com.apple.security.device.audio-input') is True, 'the app lacks the audio-input entitlement')
    checks['appAudioEntitlement'] = True

    # The app the updater installs carries its own stapled ticket.
    checks['archiveAppStapled'] = stapled(runner, app)
    checks['archiveAppGatekeeper'] = gatekeeper_app(runner, app)
    checks['dmgStapled'] = stapled(runner, dmg)
    checks['dmgGatekeeper'] = gatekeeper_dmg(runner, dmg)

    checks['cliVersion'] = runner.out(launcher, '--version')
    require(release.version in checks['cliVersion'], f'terminalx --version says {checks["cliVersion"]}')
    checks['localRuntimeVersion'] = runner.out(local_runtime, '--version')
    require(release.version in checks['localRuntimeVersion'], f'terminalx-serve --version says {checks["localRuntimeVersion"]}')
    with tempfile.TemporaryDirectory(prefix='tx-release-') as directory:
        env = dict(os.environ, TERMINALX_HOME=directory, ZDOTDIR=directory, SHELL='/bin/zsh')
        env.pop('TERMINALX_LOCAL_DESKTOP', None)
        result = runner.run([local_runtime, '--runtime-kind', 'local', '--data-dir', directory, '--project-root', directory, '--self-test'],
                            env=env, check=False)
        require(result.code == 0 and '"pty":"ok"' in result.output, f'packaged runtime self-test failed: {result.output[-2000:]}')
        checks['localRuntimeSelfTest'] = 'passed: shell PTY start, output and clean exit in a disposable store'
    browser = agent_browser_version(release.root)
    checks['browserVersion'] = runner.out(app / 'Contents/MacOS/agent-browser', '--version')
    require(browser in checks['browserVersion'], f'agent-browser is {checks["browserVersion"]}, expected {browser}')
    require('arm64' in runner.out('file', app / 'Contents/MacOS/raccoon'), 'the app executable is not arm64')
    checks['updaterSignature'] = updater_signature(release, runner, archive)
    checks['dmgIntegrity'] = runner.out('hdiutil', 'verify', dmg)

    mount = release.record('dmg-mounted')
    mount.mkdir(exist_ok=True)
    runner.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg])
    try:
        mounted_app = mount / 'TerminalX.app'
        runner.run(['codesign', '--verify', '--deep', '--strict', mounted_app])
        checks['dmgAppStapled'] = stapled(runner, mounted_app)
        checks['dmgAppGatekeeper'] = gatekeeper_app(runner, mounted_app)
        packaged, mounted = members(app), members(mounted_app)
        require(packaged == mounted, 'the app in the DMG differs from the app in the updater archive')
        checks['matchingPackagedMembers'] = len(packaged)
        checks['dmgMatchesUpdaterArchive'] = True
    finally:
        runner.run(['hdiutil', 'detach', mount])
    signature = archive.with_name(SIGNATURE)
    checks['artifacts'] = {p.name: {'sha256': sha256(p), 'bytes': p.stat().st_size} for p in [dmg, archive, signature]}
    checks['passed'] = True
    checks['finishedAt'] = now()
    write_json(record, checks)
    return checks


def require_verified(release: Release, source: str) -> dict:
    checks = read_record(release.record('artifact-verification.json'), 'verify')
    require(checks.get('passed') is True and checks.get('sourceCommit') == source, 'the artifacts were not verified at the pinned commit; run the verify step')
    return checks
