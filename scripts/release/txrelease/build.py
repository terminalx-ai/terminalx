"""The build step: a Developer ID signed build in which Tauri notarizes and staples the app.

Tauri notarizes the .app with the App Store Connect API key and staples its ticket before it
packages the DMG, so the app inside both the DMG and updater archive is the notarized one. A
rejected or failed notarization makes `tauri build` exit non-zero, and the release stops here.

The updater private key (`TAURI_SIGNING_PRIVATE_KEY`) and Windows Authenticode credentials are
never exposed to `pnpm tauri build` (which executes npm, Vite, and Cargo build scripts). Once
the build finishes, `TerminalX.app.tar.gz` is archived and signed in an isolated post-build step.
"""
from __future__ import annotations

import os
import shutil

from . import credentials
from .config import SIGNATURE, Release, ReleaseError
from .proc import Runner, now, write_json
from .source import pinned_source, require_checks_passed

# Sensitive signing variables that must never be exposed to build scripts.
_BUILD_STRIPPED_ENV = (
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'WINDOWS_CERTIFICATE',
    'WINDOWS_CERTIFICATE_PASSWORD',
    'TERMINALX_WINDOWS_CERTIFICATE_THUMBPRINT',
)


def build_command(release: Release) -> list[str]:
    return ['pnpm', 'tauri', 'build', '--ci', '--bundles', 'app,dmg',
            '--config', '{"bundle":{"createUpdaterArtifacts":false}}',
            '--config', str(release.record('signing-config.json')), '--', '--locked']


def build_env(release: Release, runner: Runner, env=os.environ) -> tuple[dict[str, str], str]:
    identity = credentials.signing_identity(runner, env)
    notary = credentials.notary_key(env)
    # Verify the updater key exists upfront before running the long build,
    # without exposing it to the build process environment.
    credentials.updater_key(env)
    build = {k: v for k, v in env.items() if k not in _BUILD_STRIPPED_ENV}
    build.update({
        'CARGO_TARGET_DIR': str(release.target_dir),
        'TERMINALX_MAC_RELEASE': '1',
        'APPLE_SIGNING_IDENTITY': identity,
        **notary.tauri_env(),
    })
    return build, identity


def updater_sign_env(env=os.environ) -> dict[str, str]:
    """Minimal environment for the isolated post-build updater signing step."""
    sign_env = {k: v for k, v in env.items() if k not in _BUILD_STRIPPED_ENV}
    sign_env['TAURI_SIGNING_PRIVATE_KEY'] = credentials.updater_key(env)
    sign_env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = credentials.updater_key_password(env)
    return sign_env


def package_and_sign_updater(release: Release, runner: Runner, env=os.environ) -> None:
    """Archive the notarized `.app` and sign it in isolation after build scripts finish."""
    runner.run(['tar', '-czf', str(release.built_archive), '-C', str(release.built_app.parent), release.built_app.name],
               cwd=release.root)
    sign_env = updater_sign_env(env)
    runner.run(['pnpm', 'tauri', 'signer', 'sign', str(release.built_archive)], cwd=release.root, env=sign_env)
    signature = release.built_archive.with_name(SIGNATURE)
    if not signature.exists():
        raise ReleaseError(f'updater signing did not produce {signature.name}')


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
    for path in (release.built_app, release.built_dmg):
        if not path.exists():
            raise ReleaseError(f'the build did not produce {path.name}')
    package_and_sign_updater(release, runner, env)
    if not release.built_archive.exists():
        raise ReleaseError(f'the build did not produce {release.built_archive.name}')
    return meta
