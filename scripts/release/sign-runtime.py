#!/usr/bin/env python3
"""Sign a published TerminalX runtime release.

CI publishes runtime prereleases unsigned (.github/workflows/release-serve.yml):
the signing key never leaves the owner's machine, and nothing secret is on
GitHub. This script downloads a release's assets, checks every one against its
SHA256SUMS, signs SHA256SUMS as an SSH signature
(`ssh-keygen -Y sign -n terminalx-runtime`), checks the signature against
scripts/install/allowed_signers (the key the installer trusts), and uploads it
as SHA256SUMS.sig. scripts/install/install.sh only installs releases that carry
a signature that verifies.

    scripts/release/sign-runtime.py                 # the newest runtime release
    scripts/release/sign-runtime.py runtime-v0.2.27-20261115120000-abcdef0
    scripts/release/sign-runtime.py --dry-run       # sign and check, upload nothing

It needs `gh` (signed in, with write access to the repository) and
`ssh-keygen` (OpenSSH 8.1 or later). The key is read by ssh-keygen only; it
asks for the key's passphrase itself.

`--local-dir DIR` signs a release directory on disk instead (SHA256SUMS and
the assets it lists), with no GitHub access. scripts/install/test.sh uses it
with a throwaway key.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = "terminalx-ai/terminalx"
DEFAULT_KEY = Path.home() / ".tauri" / "terminalx-runtime-signing"
ALLOWED_SIGNERS = Path(__file__).resolve().parent.parent / "install" / "allowed_signers"
NAMESPACE = "terminalx-runtime"
PRINCIPAL = "release@terminalx"
TAG_PATTERN = re.compile(r"^runtime-v(\d+\.\d+\.\d+)-(\d{14})-[0-9a-f]{7}$")
# What every runtime release carries, besides SHA256SUMS itself.
ASSETS = (
    "terminalx-serve-linux-x64",
    "terminalx-serve-linux-arm64",
    "terminalx-serve-macos-arm64",
    "terminalx-serve.json",
)


class SignError(Exception):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_sums(path: Path) -> dict[str, str]:
    sums: dict[str, str] = {}
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](\S+)", line)
        if not match:
            raise SignError(f"SHA256SUMS line {number} is not '<sha256>  <name>': {line!r}")
        name = match.group(2)
        if name in sums:
            raise SignError(f"SHA256SUMS lists {name} twice")
        sums[name] = match.group(1)
    return sums


def check_release_dir(directory: Path, tag: str | None) -> None:
    """Every expected asset is listed in SHA256SUMS, present and matches."""
    sums = read_sums(directory / "SHA256SUMS")
    missing = [name for name in ASSETS if name not in sums]
    if missing:
        raise SignError(f"SHA256SUMS does not list {', '.join(missing)}")
    extra = sorted(set(sums) - set(ASSETS))
    if extra:
        raise SignError(f"SHA256SUMS lists unexpected files: {', '.join(extra)}")
    for name, expected in sums.items():
        path = directory / name
        if not path.is_file():
            raise SignError(f"{name} is listed in SHA256SUMS but missing")
        actual = sha256(path)
        if actual != expected:
            raise SignError(f"{name} does not match SHA256SUMS (listed {expected}, file {actual})")
    manifest = json.loads((directory / "terminalx-serve.json").read_text())
    version = manifest.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SignError(f"terminalx-serve.json has no usable version: {version!r}")
    if tag is not None:
        match = TAG_PATTERN.match(tag)
        if not match:
            raise SignError(f"{tag} is not a runtime release tag")
        if match.group(1) != version:
            raise SignError(f"{tag} is tagged {match.group(1)} but terminalx-serve.json says {version}")
    print(f"Checked {len(sums)} files against SHA256SUMS (version {version}).")


def sign(directory: Path, key: Path, allowed_signers: Path) -> Path:
    if not key.is_file():
        raise SignError(f"no signing key at {key} (see docs/RELEASING.md, 'Signing runtime releases')")
    if not allowed_signers.is_file():
        raise SignError(f"no allowed_signers file at {allowed_signers}")
    sums = directory / "SHA256SUMS"
    signature = directory / "SHA256SUMS.sig"
    signature.unlink(missing_ok=True)
    # ssh-keygen reads the key itself and asks for its passphrase on the terminal.
    result = subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(key), "-n", NAMESPACE, str(sums)])
    if result.returncode != 0 or not signature.is_file():
        raise SignError("ssh-keygen could not sign SHA256SUMS")
    verify(directory, allowed_signers)
    return signature


def verify(directory: Path, allowed_signers: Path) -> None:
    """The signature verifies exactly as the installer checks it."""
    with (directory / "SHA256SUMS").open("rb") as message:
        result = subprocess.run(
            [
                "ssh-keygen", "-Y", "verify",
                "-f", str(allowed_signers),
                "-I", PRINCIPAL,
                "-n", NAMESPACE,
                "-s", str(directory / "SHA256SUMS.sig"),
            ],
            stdin=message,
            capture_output=True,
            text=True,
        )
    if result.returncode != 0:
        raise SignError(
            "the signature does not verify against "
            f"{allowed_signers}; is this the key the installer trusts?\n{result.stdout}{result.stderr}"
        )
    print(f"Signature verifies against {allowed_signers} as {PRINCIPAL}.")


def gh(*args: str) -> str:
    if shutil.which("gh") is None:
        raise SignError("gh is required (https://cli.github.com), signed in with write access")
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise SignError(f"gh {' '.join(args[:2])} failed: {result.stderr.strip()}")
    return result.stdout


def runtime_releases(repo: str) -> list[dict]:
    """Published runtime prereleases, newest commit time first."""
    pages = json.loads(gh("api", "--paginate", "--slurp", f"repos/{repo}/releases?per_page=100"))
    releases = [release for page in pages for release in page]
    runtime = [
        release
        for release in releases
        if release.get("prerelease") and not release.get("draft") and TAG_PATTERN.match(release["tag_name"])
    ]
    return sorted(runtime, key=lambda release: TAG_PATTERN.match(release["tag_name"]).group(2), reverse=True)


def sign_release(args: argparse.Namespace) -> int:
    releases = runtime_releases(args.repo)
    if args.tag:
        chosen = next((release for release in releases if release["tag_name"] == args.tag), None)
        if chosen is None:
            raise SignError(f"{args.tag} is not a published runtime prerelease of {args.repo}")
    elif releases:
        chosen = releases[0]
    else:
        raise SignError(f"{args.repo} has no runtime prereleases")
    tag = chosen["tag_name"]
    names = {asset["name"] for asset in chosen.get("assets", [])}
    if "SHA256SUMS.sig" in names and not args.resign:
        print(f"{tag} is already signed (pass --resign to replace its signature).")
        return 0
    missing = [name for name in (*ASSETS, "SHA256SUMS") if name not in names]
    if missing:
        raise SignError(f"{tag} lacks {', '.join(missing)}")
    print(f"Signing {tag} ({args.repo}).")
    with tempfile.TemporaryDirectory(prefix="terminalx-sign-") as temp:
        directory = Path(temp)
        patterns = [arg for name in (*ASSETS, "SHA256SUMS") for arg in ("--pattern", name)]
        gh("release", "download", tag, "--repo", args.repo, "--dir", str(directory), *patterns)
        check_release_dir(directory, tag)
        signature = sign(directory, args.key, args.allowed_signers)
        if args.dry_run:
            print(f"Dry run: {tag} signed and verified; nothing uploaded.")
            return 0
        upload = ["release", "upload", tag, str(signature), "--repo", args.repo]
        if args.resign:
            upload.append("--clobber")
        gh(*upload)
        # What the installer will download is what was signed here.
        check = directory / "uploaded"
        check.mkdir()
        gh("release", "download", tag, "--repo", args.repo, "--dir", str(check), "--pattern", "SHA256SUMS.sig")
        if (check / "SHA256SUMS.sig").read_bytes() != signature.read_bytes():
            raise SignError(f"the SHA256SUMS.sig {tag} now serves is not the one just made")
    print(f"Uploaded SHA256SUMS.sig to {tag}; the installer now offers it.")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Sign a published TerminalX runtime release (SHA256SUMS.sig).")
    parser.add_argument("tag", nargs="?", help="runtime release tag; default: the newest runtime prerelease")
    parser.add_argument("--key", type=Path, default=DEFAULT_KEY, help=f"the private signing key (default {DEFAULT_KEY})")
    parser.add_argument("--repo", default=REPO, help=f"GitHub repository (default {REPO})")
    parser.add_argument(
        "--allowed-signers",
        type=Path,
        default=ALLOWED_SIGNERS,
        help="allowed_signers the signature must verify against (default scripts/install/allowed_signers)",
    )
    parser.add_argument("--dry-run", action="store_true", help="sign and verify, but upload nothing")
    parser.add_argument("--resign", action="store_true", help="replace an existing SHA256SUMS.sig")
    parser.add_argument("--local-dir", type=Path, help="sign a release directory on disk instead of a GitHub release")
    args = parser.parse_args(argv)
    if shutil.which("ssh-keygen") is None:
        raise SignError("ssh-keygen (OpenSSH 8.1 or later) is required")
    if args.local_dir is not None:
        directory = args.local_dir
        if not (directory / "SHA256SUMS").is_file():
            raise SignError(f"{directory} has no SHA256SUMS")
        check_release_dir(directory, args.tag)
        signature = sign(directory, args.key, args.allowed_signers)
        print(f"Wrote {signature}.")
        return 0
    return sign_release(args)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SignError as error:
        print(f"sign-runtime: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
