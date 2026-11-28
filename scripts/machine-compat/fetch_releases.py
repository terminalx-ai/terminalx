#!/usr/bin/env python3
"""Fetch the previous two released TerminalX runtimes for the machine
compatibility matrix (PRO-354, docs/MACHINES.md "Versions and updates").

From this build's version (src-tauri/Cargo.toml), pick the two newest
`vX.Y.Z` releases before it (older, or this version tagged on another commit:
see `previous_releases`), download each one's TerminalX.app.tar.gz
and SHA256SUMS, check the archive against the sums, and take the bundled
`terminalx-serve` out of it. From the release's git tag, read what a desktop
of that version asks a runtime for: its CAPABILITIES, its machine namespaces,
the namespaces a machine withholds, and its RPC method table.

Writes <out>/manifest.json, which src-tauri/serve/tests/machine_compat.rs
reads (TERMINALX_MACHINE_COMPAT). Nothing here runs a downloaded binary.

Needs `gh` with a token that can read the repository's releases (GH_TOKEN).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = "TerminalX.app.tar.gz"
ARCHIVE_SIG = f"{ARCHIVE}.sig"
SUMS = "SHA256SUMS"
TAURI_CONFIG = ROOT / "src-tauri" / "tauri.conf.json"
BINARY_IN_ARCHIVE = "TerminalX.app/Contents/Resources/local-runtime/terminalx-serve"
TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
HOW_MANY = 2

# Pure-Python RFC 8032 Ed25519 verification constants so `python3 -I` can verify
# Tauri/minisign offline updater signatures without third-party dependencies.
_ED25519_P = (1 << 255) - 19
_ED25519_L = (1 << 252) + 27742317777372353535851937790883648493
_ED25519_D = (-121665 * pow(121666, -1, _ED25519_P)) % _ED25519_P
_ED25519_I = pow(2, (_ED25519_P - 1) // 4, _ED25519_P)


def _ed25519_recover_x(y: int, sign: int) -> int | None:
    if y >= _ED25519_P:
        return None
    u = (y * y - 1) % _ED25519_P
    v = (_ED25519_D * y * y + 1) % _ED25519_P
    x2 = (u * pow(v, -1, _ED25519_P)) % _ED25519_P
    if x2 == 0:
        return None if sign == 1 else 0
    x = pow(x2, (_ED25519_P + 3) // 8, _ED25519_P)
    if (x * x - x2) % _ED25519_P != 0:
        x = (x * _ED25519_I) % _ED25519_P
    if (x * x - x2) % _ED25519_P != 0:
        return None
    if (x & 1) != sign:
        x = _ED25519_P - x
    return x


def _ed25519_point_decompress(encoded: bytes) -> tuple[int, int, int, int] | None:
    if len(encoded) != 32:
        return None
    y = int.from_bytes(encoded, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _ed25519_recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, (x * y) % _ED25519_P)


def _ed25519_point_add(
    p1: tuple[int, int, int, int],
    p2: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    x1, y1, z1, t1 = p1
    x2, y2, z2, t2 = p2
    a = ((y1 - x1) * (y2 - x2)) % _ED25519_P
    b = ((y1 + x1) * (y2 + x2)) % _ED25519_P
    c = (t1 * 2 * _ED25519_D * t2) % _ED25519_P
    d = (z1 * 2 * z2) % _ED25519_P
    e = (b - a) % _ED25519_P
    f = (d - c) % _ED25519_P
    g = (d + c) % _ED25519_P
    h = (b + a) % _ED25519_P
    return ((e * f) % _ED25519_P, (g * h) % _ED25519_P, (f * g) % _ED25519_P, (e * h) % _ED25519_P)


def _ed25519_point_mul(scalar: int, point: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    acc = (0, 1, 1, 0)
    cur = point
    while scalar > 0:
        if scalar & 1:
            acc = _ed25519_point_add(acc, cur)
        cur = _ed25519_point_add(cur, cur)
        scalar >>= 1
    return acc


def _ed25519_point_equal(p1: tuple[int, int, int, int], p2: tuple[int, int, int, int]) -> bool:
    if (p1[0] * p2[2] - p2[0] * p1[2]) % _ED25519_P != 0:
        return False
    if (p1[1] * p2[2] - p2[1] * p1[2]) % _ED25519_P != 0:
        return False
    return True


_ED25519_GY = (4 * pow(5, -1, _ED25519_P)) % _ED25519_P
_ED25519_GX = _ed25519_recover_x(_ED25519_GY, 0)
assert _ED25519_GX is not None
_ED25519_G = (_ED25519_GX, _ED25519_GY, 1, (_ED25519_GX * _ED25519_GY) % _ED25519_P)


def ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """Verify an RFC 8032 Ed25519 detached signature."""
    if len(public_key) != 32 or len(signature) != 64:
        return False
    point_a = _ed25519_point_decompress(public_key)
    point_r = _ed25519_point_decompress(signature[:32])
    if point_a is None or point_r is None:
        return False
    scalar_s = int.from_bytes(signature[32:], "little")
    if scalar_s >= _ED25519_L:
        return False
    digest = hashlib.sha512(signature[:32] + public_key + message).digest()
    scalar_h = int.from_bytes(digest, "little") % _ED25519_L
    lhs = _ed25519_point_mul(scalar_s, _ED25519_G)
    rhs = _ed25519_point_add(point_r, _ed25519_point_mul(scalar_h, point_a))
    return _ed25519_point_equal(lhs, rhs)


def load_updater_pubkey(config_path: Path = TAURI_CONFIG) -> str:
    """Read the committed Tauri updater public key from tauri.conf.json."""
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        pubkey = config["plugins"]["updater"]["pubkey"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        fail(f"failed to read updater pubkey from {config_path}: {exc}")
    if not isinstance(pubkey, str) or not pubkey.strip():
        fail(f"empty updater pubkey in {config_path}")
    return pubkey.strip()


def parse_minisign_pubkey(pubkey_encoded: str) -> tuple[bytes, bytes]:
    """Decode a Tauri base64-wrapped (or raw) minisign public key into (key_id, ed25519_pubkey)."""
    text = pubkey_encoded.strip()
    if not text.startswith("untrusted comment:"):
        try:
            text = base64.b64decode(text, validate=True).decode("utf-8")
        except Exception as exc:
            raise ValueError(f"invalid base64 updater public key: {exc}") from exc
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if len(lines) != 2 or not lines[0].startswith("untrusted comment:"):
        raise ValueError("invalid minisign public key format")
    raw = base64.b64decode(lines[1], validate=True)
    if len(raw) != 42 or raw[:2] != b"Ed":
        raise ValueError("invalid minisign public key length or algorithm")
    return raw[2:10], raw[10:42]


def verify_minisign_artifact(artifact_path: Path, sig_path: Path, pubkey_encoded: str) -> str:
    """Verify a Tauri updater minisign `<artifact>.sig` against `pubkey_encoded`.

    Matches `scripts/release/verify-updater.mjs`: checks key ID, Ed/ED signature
    over the artifact (prehashed with BLAKE2b-512 for `ED`), and the trusted
    comment global signature. Returns the verified algorithm (`Ed` or `ED`).
    """
    key_id, ed_pubkey = parse_minisign_pubkey(pubkey_encoded)
    sig_raw_text = sig_path.read_text(encoding="utf-8").strip()
    if sig_raw_text.startswith("untrusted comment:"):
        sig_text = sig_raw_text
    else:
        try:
            sig_text = base64.b64decode(sig_raw_text, validate=True).decode("utf-8")
        except Exception as exc:
            raise ValueError(f"invalid base64 signature file {sig_path.name}: {exc}") from exc
    lines = sig_text.strip().splitlines()
    if len(lines) != 4:
        raise ValueError(f"invalid minisign signature line count: {len(lines)}")
    signature = base64.b64decode(lines[1].strip(), validate=True)
    if len(signature) != 74:
        raise ValueError("invalid minisign signature length")
    algorithm_bytes = signature[:2]
    if algorithm_bytes not in (b"Ed", b"ED"):
        raise ValueError(f"unknown minisign algorithm: {algorithm_bytes!r}")
    if signature[2:10] != key_id:
        raise ValueError("signing key ID mismatch")
    raw_sig = signature[10:74]

    if algorithm_bytes == b"ED":
        digest = hashlib.blake2b(digest_size=64)
        with artifact_path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        message = digest.digest()
    else:
        message = artifact_path.read_bytes()

    if not ed25519_verify(ed_pubkey, message, raw_sig):
        raise ValueError("artifact signature is invalid")

    if not lines[2].startswith("trusted comment: "):
        raise ValueError("missing trusted comment in signature")
    comment = lines[2][len("trusted comment: "):].encode("utf-8")
    global_sig = base64.b64decode(lines[3].strip(), validate=True)
    if len(global_sig) != 64:
        raise ValueError("invalid trusted comment signature length")
    if not ed25519_verify(ed_pubkey, raw_sig + comment, global_sig):
        raise ValueError("trusted comment signature is invalid")
    return algorithm_bytes.decode("ascii")


def fail(message: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"machine-compat: {message}", file=sys.stderr)
    sys.exit(1)


def parse_version(text: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", text.strip())
    if not match:
        fail(f"not a release version: {text!r}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def package_version(cargo_toml: str) -> str:
    """The `[package]` version of a Cargo.toml (the desktop crate's)."""
    in_package = False
    for line in cargo_toml.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_package = stripped == "[package]"
            continue
        match = re.fullmatch(r'version\s*=\s*"([^"]+)"', stripped)
        if in_package and match:
            return match.group(1)
    fail("no [package] version in src-tauri/Cargo.toml")


def gh(*args: str, binary: bool = False) -> str | bytes:
    done = subprocess.run(["gh", *args], capture_output=True, check=False)
    if done.returncode != 0:
        fail(f"gh {' '.join(args)} failed: {done.stderr.decode(errors='replace').strip()}")
    return done.stdout if binary else done.stdout.decode()


def repository() -> str:
    named = os.environ.get("GITHUB_REPOSITORY")
    if named:
        return named
    return str(gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")).strip()


def this_commit() -> str:
    """The commit being built: GITHUB_SHA under CI, else the checkout's HEAD."""
    named = os.environ.get("GITHUB_SHA")
    if named:
        return named
    done = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, check=False)
    if done.returncode != 0:
        fail(f"git rev-parse HEAD failed: {done.stderr.decode(errors='replace').strip()}")
    return done.stdout.decode().strip()


def tag_commit(repo: str, tag: str) -> str:
    return str(gh("api", f"repos/{repo}/commits/{tag}", "-q", ".sha")).strip()


def previous_releases(repo: str, build: tuple[int, int, int], commit: str) -> list[str]:
    """The `HOW_MANY` newest published `vX.Y.Z` releases before this build.

    A release is before this build when its version is older, or when it is
    this build's version and its tag is another commit: main keeps the version
    of the release it last shipped until the next release bumps it, so the
    newest runtime people run has this build's version. A tag on this very
    commit is this build, not a previous one.
    """
    listed = json.loads(str(gh("release", "list", "-R", repo, "--limit", "200", "--exclude-drafts", "--json", "tagName,isPrerelease,isDraft")))
    before = []
    for release in listed:
        match = TAG.match(release["tagName"])
        if not match or release["isPrerelease"] or release["isDraft"]:
            continue
        version = tuple(int(part) for part in match.groups())
        if version < build or (version == build and tag_commit(repo, release["tagName"]) != commit):
            before.append((version, release["tagName"]))
    before.sort(reverse=True)
    if len(before) < HOW_MANY:
        fail(f"only {len(before)} released versions come before {'.'.join(map(str, build))}: {[tag for _, tag in before]}")
    return [tag for _, tag in before[:HOW_MANY]]


def source_at(repo: str, tag: str, path: str) -> str | None:
    """A file of the repository at `tag`, or None when it did not exist."""
    done = subprocess.run(
        ["gh", "api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{path}?ref={tag}"],
        capture_output=True,
        check=False,
    )
    if done.returncode == 0:
        return done.stdout.decode()
    if b"404" in done.stderr or b"Not Found" in done.stderr:
        return None
    fail(f"reading {path} at {tag} failed: {done.stderr.decode(errors='replace').strip()}")


def string_array(source: str, name: str) -> list[str]:
    # An array (`[&str; N] = [`) until 0.2.36, a slice (`&[&str] = &[`) since 0.2.37.
    match = re.search(rf"pub const {name}: (?:\[&str; \d+\] = |&\[&str\] = &)\[(.*?)\];", source, re.S)
    if not match:
        fail(f"no {name} array")
    return re.findall(r'"([^"]+)"', match.group(1))


def desktop_contract(repo: str, tag: str) -> dict:
    """What a desktop of `tag` asks for, and the calls it can make."""
    protocol = source_at(repo, tag, "src-tauri/src/remote/protocol.rs")
    if protocol is None:
        fail(f"{tag} has no src-tauri/src/remote/protocol.rs")
    name = re.search(r'pub const PROTOCOL: &str = "([^"]+)";', protocol)
    if not name:
        fail(f"{tag}: no PROTOCOL")
    capabilities = string_array(protocol, "CAPABILITIES")
    table = re.search(r"pub const METHODS: &\[Method\] = &\[(.*?)\n\];", protocol, re.S)
    if not table:
        fail(f"{tag}: no METHODS table")
    methods = [
        {"name": method, "capability": capability, "authority": authority.lower(), "idempotent": idempotent == "true"}
        for method, capability, authority, idempotent in re.findall(
            r'method\(\s*"([^"]+)",\s*"([^"]+)",\s*(Participate|Manage),\s*(true|false)\s*\)', table.group(1)
        )
    ]
    if not methods:
        fail(f"{tag}: METHODS lists no method")
    machine_source = source_at(repo, tag, "src-tauri/src/remote/machine.rs") or ""
    machine = sorted(set(re.findall(r'pub const MACHINE(?:_\d+)?: &str = "(machine/\d+)";', machine_source)), key=lambda ns: int(ns.split("/")[1]))
    withheld = string_array(machine_source, "WITHHELD") if machine else []
    wire = source_at(repo, tag, "src-tauri/src/machine_wire.rs") or ""
    return {
        "protocol": name.group(1),
        "capabilities": capabilities,
        "machine": machine,
        "withheld": withheld,
        # The desktop's own `want`: every namespace it knows, then the machine's
        # (`machine_client::wanted_capabilities`); before machines, CAPABILITIES.
        "want": capabilities + machine,
        # Whether its runtime opens the direct `/machine/1` listener (PRO-341).
        "machineHost": "TERMINALX_MACHINE_HOST_PORT" in wire,
        "methods": methods,
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def listed_sum(sums: str, name: str) -> str:
    found = {line.split()[1].lstrip("*"): line.split()[0].lower() for line in sums.splitlines() if len(line.split()) == 2}
    if name not in found:
        fail(f"{SUMS} does not list {name}")
    if not re.fullmatch(r"[0-9a-f]{64}", found[name]):
        fail(f"{SUMS} has no SHA-256 for {name}")
    return found[name]


def fetch(repo: str, tag: str, into: Path, *, pubkey: str) -> dict:
    """Download, verify signature + checksum, and unpack one release's runtime into a fresh folder."""
    if into.exists():
        shutil.rmtree(into)
    downloads = into / "download"
    downloads.mkdir(parents=True)
    gh("release", "download", tag, "-R", repo, "-D", str(downloads), "-p", ARCHIVE, "-p", ARCHIVE_SIG, "-p", SUMS)

    archive_path = downloads / ARCHIVE
    sig_path = downloads / ARCHIVE_SIG
    if not sig_path.is_file():
        fail(f"{tag}: missing detached updater signature {ARCHIVE_SIG}")
    try:
        sig_algorithm = verify_minisign_artifact(archive_path, sig_path, pubkey)
    except ValueError as exc:
        fail(f"{tag}: offline updater signature verification failed for {ARCHIVE}: {exc}")

    expected = listed_sum((downloads / SUMS).read_text(), ARCHIVE)
    actual = sha256(archive_path)
    if actual != expected:
        fail(f"{tag}: {ARCHIVE} is {actual}, {SUMS} says {expected}; not using it")
    print(f"{tag}: {ARCHIVE} verified by offline updater signature ({sig_algorithm}) and matches {SUMS} ({actual})")

    # Only the runtime comes out of the archive: one regular file, by name.
    binary = into / "runtime" / "terminalx-serve"
    binary.parent.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        try:
            member = archive.getmember(BINARY_IN_ARCHIVE)
        except KeyError:
            fail(f"{tag}: {ARCHIVE} has no {BINARY_IN_ARCHIVE}")
        if not member.isreg():
            fail(f"{tag}: {BINARY_IN_ARCHIVE} is not a regular file")
        source = archive.extractfile(member)
        assert source is not None
        with binary.open("wb") as out:
            shutil.copyfileobj(source, out)
    binary.chmod(stat.S_IRWXU)
    return {
        "binary": str(binary),
        "binarySha256": sha256(binary),
        "archiveSha256": actual,
        "signatureVerified": True,
        "signatureAlgorithm": sig_algorithm,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help="an empty folder of its own for the downloads and manifest.json")
    parser.add_argument(
        "--pubkey-config",
        type=Path,
        default=TAURI_CONFIG,
        help="path to tauri.conf.json carrying the committed plugins.updater.pubkey",
    )
    args = parser.parse_args()
    out: Path = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    pubkey = load_updater_pubkey(args.pubkey_config.resolve())

    build_version = package_version((ROOT / "src-tauri" / "Cargo.toml").read_text())
    build = parse_version(build_version)
    repo = repository()
    commit = this_commit()
    tags = previous_releases(repo, build, commit)
    print(f"this build is {build_version} ({commit}); checking it against {', '.join(tags)}")

    releases = []
    for tag in tags:
        version = tag[1:]
        tagged = package_version(source_at(repo, tag, "src-tauri/Cargo.toml") or "")
        if tagged != version:
            fail(f"{tag} builds version {tagged}")
        contract = desktop_contract(repo, tag)
        releases.append({"tag": tag, "version": version, **fetch(repo, tag, out / tag, pubkey=pubkey), **contract})
        print(f"{tag}: want {contract['want']}; machine host: {contract['machineHost']}; {len(contract['methods'])} methods")

    manifest = out / "manifest.json"
    manifest.write_text(json.dumps({"build": build_version, "releases": releases}, indent=2) + "\n")
    print(f"wrote {manifest}")


if __name__ == "__main__":
    main()
