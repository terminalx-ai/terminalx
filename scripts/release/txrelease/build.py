"""The build step: a Developer ID signed build in which Tauri notarizes and staples the app.

Tauri notarizes the .app with the App Store Connect API key and staples its ticket before it
packages the DMG and the updater archive, so the app inside both is the notarized one. A rejected
or failed notarization makes `tauri build` exit non-zero, and the release stops here.
"""
from __future__ import annotations

import os
import shutil

from . import credentials
from .config import Release, ReleaseError
from .proc import Runner, now, write_json
from .source import pinned_source, require_checks_passed


def build_command(release: Release) -> list[str]:
    return ['pnpm', 'tauri', 'build', '--ci', '--bundles', 'app,dmg',
            '--config', str(release.record('signing-config.json')), '--', '--locked']


def build_env(release: Release, runner: Runner, env=os.environ) -> tuple[dict[str, str], str]:
    identity = credentials.signing_identity(runner, env)
    notary = credentials.notary_key(env)
    build = dict(env)
    build.update({
        'CARGO_TARGET_DIR': str(release.target_dir),
        'TERMINALX_MAC_RELEASE': '1',
        'APPLE_SIGNING_IDENTITY': identity,
        'TAURI_SIGNING_PRIVATE_KEY': credentials.updater_key(env),
        'TAURI_SIGNING_PRIVATE_KEY_PASSWORD': credentials.updater_key_password(env),
        **notary.tauri_env(),
    })
    return build, identity


def build(release: Release, runner: Runner, env=os.environ) -> dict:
    source = pinned_source(release, runner)
    require_checks_passed(release, source)
    build_environment, identity = build_env(release, runner, env)
    write_json(release.record('signing-config.json'), {'bundle': {'macOS': {'signingIdentity': identity}}})
    # A DMG or archive left by an earlier, failed build must never be mistaken for this one.
    for stale in (release.bundle / 'dmg', release.bundle / 'macos'):
        if stale.exists():
            shutil.rmtree(stale)
    command = build_command(release)
    meta = {'version': release.version, 'sourceCommit': source, 'startedAt': now(), 'variant': 'production',
            'architecture': 'aarch64', 'buildCommand': command, 'notarizationRequested': True,
            'notarizedWith': 'App Store Connect API key'}
    write_json(release.record('build-metadata.json'), meta)
    print(f'Building Developer ID signed TerminalX {release.version} from {source}', flush=True)
    with release.record('build.log').open('w') as log:
        result = runner.run(command, cwd=release.root, env=build_environment, check=False, log=log)
    meta['exitCode'] = result.code
    meta['finishedAt'] = now()
    write_json(release.record('build-metadata.json'), meta)
    if result.code:
        tail = '\n'.join(release.record('build.log').read_text().splitlines()[-40:])
        raise ReleaseError(f'tauri build exited {result.code} (a failed app notarization stops it here); log in build.log:\n{tail}')
    for path in (release.built_app, release.built_dmg, release.built_archive):
        if not path.exists():
            raise ReleaseError(f'the build did not produce {path.name}')
    return meta
