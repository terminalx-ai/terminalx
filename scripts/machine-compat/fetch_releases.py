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
SUMS = "SHA256SUMS"
BINARY_IN_ARCHIVE = "TerminalX.app/Contents/Resources/local-runtime/terminalx-serve"
TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
HOW_MANY = 2


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
    match = re.search(rf"pub const {name}: \[&str; \d+\] = \[(.*?)\];", source, re.S)
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


def fetch(repo: str, tag: str, into: Path) -> dict:
    """Download, check and unpack one release's runtime into a fresh folder."""
    if into.exists():
        shutil.rmtree(into)
    downloads = into / "download"
    downloads.mkdir(parents=True)
    gh("release", "download", tag, "-R", repo, "-D", str(downloads), "-p", ARCHIVE, "-p", SUMS)
    expected = listed_sum((downloads / SUMS).read_text(), ARCHIVE)
    actual = sha256(downloads / ARCHIVE)
    if actual != expected:
        fail(f"{tag}: {ARCHIVE} is {actual}, {SUMS} says {expected}; not using it")
    print(f"{tag}: {ARCHIVE} matches {SUMS} ({actual})")

    # Only the runtime comes out of the archive: one regular file, by name.
    binary = into / "runtime" / "terminalx-serve"
    binary.parent.mkdir()
    with tarfile.open(downloads / ARCHIVE, "r:gz") as archive:
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
    return {"binary": str(binary), "binarySha256": sha256(binary), "archiveSha256": actual}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help="an empty folder of its own for the downloads and manifest.json")
    args = parser.parse_args()
    out: Path = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

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
        releases.append({"tag": tag, "version": version, **fetch(repo, tag, out / tag), **contract})
        print(f"{tag}: want {contract['want']}; machine host: {contract['machineHost']}; {len(contract['methods'])} methods")

    manifest = out / "manifest.json"
    manifest.write_text(json.dumps({"build": build_version, "releases": releases}, indent=2) + "\n")
    print(f"wrote {manifest}")


if __name__ == "__main__":
    main()
