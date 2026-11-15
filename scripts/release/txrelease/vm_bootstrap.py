"""Developer ID signing of the macOS VM guest helper (native/vm-bootstrap).

The helper, its validation probe and the seed tool are signed with the release's own Developer ID
Application identity: the one ``credentials.signing_identity`` gives the app build
(APPLE_SIGNING_IDENTITY, or else the one such identity in the login keychain). Nothing in the
repository names it, and no key, certificate or password is read here: codesign uses the keychain.

``scripts/build-vm-bootstrap.mjs --sign`` does the build and the signing. This step hands it that
identity in APPLE_SIGNING_IDENTITY, exactly as the build step hands it to Tauri, and then checks
each executable itself, as ``verify`` checks the app. The executables are signed and no more:
nothing here is notarized, catalogued, installed or run in a guest.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Mapping

from . import credentials
from .config import ReleaseError
from .proc import Runner, require, sha256

# Each executable and its code signing identifier, as the build script signs it. A test keeps the
# two lists the same.
IDENTIFIERS = {
    'terminalx-vm-bootstrap': 'com.terminalx.next.vm-bootstrap',
    'terminalx-vm-validation-probe': 'com.terminalx.next.vm-validation-probe',
    'terminalx-vm-seed': 'com.terminalx.next.vm-seed',
}
_RUNTIME = re.compile(r'flags=0x[0-9a-f]+\(([^)]*)\)')


def build_command(root: Path, out: Path) -> list[str]:
    return ['node', str(root / 'scripts/build-vm-bootstrap.mjs'), str(out), '--sign']


def build_signed(root: Path, out: Path, runner: Runner, env: Mapping[str, str] = os.environ) -> dict:
    """Build and sign into ``out`` (new or empty) with the release identity, then verify it."""
    identity = credentials.signing_identity(runner, env)
    build_env = dict(env)
    build_env['APPLE_SIGNING_IDENTITY'] = identity
    print(f'Building the Developer ID signed VM guest helper into {out}', flush=True)
    result = runner.run(build_command(root, out), cwd=root, env=build_env, check=False)
    if result.code:
        raise ReleaseError(f'the VM guest helper build exited {result.code}: {result.output[-2000:]}')
    return verify_signed(out, identity, runner)


def verify_signed(out: Path, identity: str, runner: Runner) -> dict:
    """Each executable in ``out`` is the one its manifest records and carries the release identity,
    its team, its identifier, the hardened runtime and a secure timestamp."""
    team = credentials.team_id(identity)
    manifest_path = out / 'manifest.json'
    require(manifest_path.is_file(), f'{manifest_path} is missing: the VM guest helper was not built')
    manifest = json.loads(manifest_path.read_text())
    require(manifest.get('crate') == 'native/vm-bootstrap' and manifest.get('developerIdSigned') is True
            and manifest.get('signingTeam') == team and manifest.get('notarized') is False,
            'the VM guest helper manifest does not record a build signed by the release identity')
    recorded = {artifact.get('name'): artifact for artifact in manifest.get('artifacts', [])}
    executables = {}
    for name, identifier in IDENTIFIERS.items():
        path = out / name
        artifact = recorded.get(name)
        require(artifact is not None and path.is_file() and not path.is_symlink(), f'{name} is missing from the signed build')
        require(sha256(path) == artifact.get('sha256'), f'{name} is not the executable its manifest records')
        runner.run(['codesign', '--verify', '--strict', path])
        details = runner.out('codesign', '-d', '--verbose=4', path).splitlines()
        require(f'Authority={identity}' in details and f'TeamIdentifier={team}' in details,
                f'{name} is not signed by the release identity')
        require(f'Identifier={identifier}' in details, f'{name} is not identified as {identifier}')
        flags = next((match.group(1).split(',') for match in map(_RUNTIME.search, details) if match), [])
        require('runtime' in flags, f'{name} lacks the hardened runtime')
        require(any(line.startswith('Timestamp=') and line != 'Timestamp=' for line in details), f'{name} has no secure timestamp')
        executables[name] = {'sha256': artifact['sha256'], 'identifier': identifier}
    return {'manifest': str(manifest_path), 'signingTeam': team, 'executables': executables,
            'developerIdSigned': True, 'notarized': False}
