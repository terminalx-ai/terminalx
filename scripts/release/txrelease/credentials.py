"""The release's credentials, read from where they already live outside the repository.

Nothing in this repository holds a key, key ID, issuer ID, password or signing identity: each one is
read here at run time and a missing one stops the release with a message naming the file or
variable to provide (docs/RELEASING.md, One-time setup).
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .config import ReleaseError
from .proc import Runner

NOTARY_CONFIG = Path('~/.appstoreconnect/terminalx-notary.json')
UPDATER_KEY = Path('~/.tauri/raccoon.key')
SETTINGS = Path('~/.raccoon/settings.json')


@dataclass(frozen=True)
class NotaryKey:
    key_path: Path
    key_id: str
    issuer_id: str

    def notarytool_args(self) -> list[str]:
        return ['--key', str(self.key_path), '--key-id', self.key_id, '--issuer', self.issuer_id]

    def tauri_env(self) -> dict[str, str]:
        # Tauri notarizes and staples the app with these before it packages the DMG and the
        # updater archive.
        return {'APPLE_API_KEY': self.key_id, 'APPLE_API_ISSUER': self.issuer_id, 'APPLE_API_KEY_PATH': str(self.key_path)}


def _home(path: Path, env: Mapping[str, str]) -> Path:
    home = env.get('HOME')
    return Path(home) / path.relative_to('~') if home else path.expanduser()


def notary_key(env: Mapping[str, str] = os.environ) -> NotaryKey:
    """The App Store Connect API key used to notarize: its .p8 file stays on disk, and only its
    path, key ID and issuer ID are read from the notary config."""
    config = Path(env['TERMINALX_NOTARY_CONFIG']).expanduser() if env.get('TERMINALX_NOTARY_CONFIG') else _home(NOTARY_CONFIG, env)
    if not config.is_file():
        raise ReleaseError(
            f'App Store Connect notary config not found at {config}. Create it (outside the repository) as '
            '{"keyPath": "<path to AuthKey_….p8>", "keyId": "<key ID>", "issuerId": "<issuer ID>"}, '
            'or point TERMINALX_NOTARY_CONFIG at it. See docs/RELEASING.md, One-time setup.')
    try:
        data = json.loads(config.read_text())
    except json.JSONDecodeError as error:
        raise ReleaseError(f'notary config {config} is not valid JSON: {error.msg} at line {error.lineno}') from None
    missing = [name for name in ('keyPath', 'keyId', 'issuerId') if not isinstance(data.get(name), str) or not data[name].strip()]
    if missing:
        raise ReleaseError(f'notary config {config} lacks {", ".join(missing)}')
    key_path = Path(data['keyPath']).expanduser()
    if not key_path.is_file() or key_path.suffix != '.p8':
        raise ReleaseError(f'the App Store Connect key file named by {config} (keyPath) is missing or is not a .p8 file')
    return NotaryKey(key_path=key_path, key_id=data['keyId'].strip(), issuer_id=data['issuerId'].strip())


def updater_key(env: Mapping[str, str] = os.environ) -> str:
    """The updater signing key's contents (minisign, made by `tauri signer generate`)."""
    path = Path(env['TERMINALX_UPDATER_KEY']).expanduser() if env.get('TERMINALX_UPDATER_KEY') else _home(UPDATER_KEY, env)
    if not path.is_file():
        raise ReleaseError(
            f'updater signing key not found at {path}. It is made once with `pnpm tauri signer generate -w {UPDATER_KEY}`; '
            'shipped builds only accept updates signed by the key whose public half is in tauri.conf.json. '
            'Point TERMINALX_UPDATER_KEY at it if it lives elsewhere.')
    text = path.read_text().strip()
    if not text:
        raise ReleaseError(f'updater signing key {path} is empty')
    return text


def updater_key_password(env: Mapping[str, str] = os.environ) -> str:
    """Passed to Tauri as TAURI_SIGNING_PRIVATE_KEY_PASSWORD; empty when the variable is unset."""
    return env.get('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', '')


_IDENTITY = re.compile(r'"(Developer ID Application: [^"]+ \([A-Z0-9]{10}\))"')


def signing_identity(runner: Runner, env: Mapping[str, str] = os.environ) -> str:
    """The Developer ID Application identity: APPLE_SIGNING_IDENTITY, or else the one such identity
    in the login keychain."""
    named = env.get('APPLE_SIGNING_IDENTITY', '').strip()
    if named:
        if not _IDENTITY.fullmatch(f'"{named}"'):
            raise ReleaseError(f'APPLE_SIGNING_IDENTITY must be a "Developer ID Application: Name (TEAMID)" identity, got {named!r}')
        return named
    listing = runner.out('security', 'find-identity', '-v', '-p', 'codesigning', check=False)
    found = sorted(set(_IDENTITY.findall(listing)))
    if len(found) != 1:
        raise ReleaseError(
            f'found {len(found)} Developer ID Application identities in the keychain; '
            + ('install the Developer ID Application certificate and its private key' if not found
               else 'set APPLE_SIGNING_IDENTITY to the one to sign with'))
    return found[0]


def team_id(identity: str) -> str:
    match = re.search(r'\(([A-Z0-9]{10})\)$', identity)
    if not match:
        raise ReleaseError(f'cannot read a team ID from signing identity {identity!r}')
    return match.group(1)


def local_secrets(runner: Runner, env: Mapping[str, str] = os.environ) -> dict[str, str]:
    """This machine's own secrets, for the secret scan to look for. Values are never printed or
    written; only the label of one that matched is."""
    needles: dict[str, str] = {}
    notary = notary_key(env)
    needles['notary key id'] = notary.key_id
    needles['notary issuer id'] = notary.issuer_id
    body = [line for line in notary.key_path.read_text().splitlines() if line.strip() and not line.startswith('-----')]
    for i, line in enumerate(body):
        needles[f'notary key body line {i + 1}'] = line.strip()
    key = updater_key(env)
    needles['updater signing key (file)'] = key
    try:
        decoded = base64.b64decode(key, validate=True).decode()
    except (binascii.Error, UnicodeDecodeError):
        decoded = ''
    for i, line in enumerate(l for l in decoded.splitlines() if len(l) >= 20 and 'untrusted comment' not in l):
        needles[f'updater signing key line {i + 1}'] = line
    password = updater_key_password(env)
    if password:
        needles['updater key password'] = password
    token = runner.out('gh', 'auth', 'token', check=False)
    if token and ' ' not in token:
        needles['GitHub token'] = token
    settings = _home(SETTINGS, env)
    if settings.is_file():
        try:
            linear = json.loads(settings.read_text()).get('linearApiKey')
        except json.JSONDecodeError:
            linear = None
        if isinstance(linear, str) and linear:
            needles['Linear API key'] = linear
    return {label: value for label, value in needles.items() if value and len(value) >= 8}
