#!/usr/bin/env python3
"""Build and sign private OpenSSH payloads locally. This tool has no uploader."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile

ARCHITECTURES = ("x86_64", "aarch64")
RELEASE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)p(0|[1-9][0-9]*)(?:-terminalx\.([1-9][0-9]*))?\Z")
FILENAME = re.compile(r"openssh-([0-9]+\.[0-9]+p[0-9]+)\.tar\.gz\Z")
COMPONENT = re.compile(r"[a-zA-Z0-9._+\-]+\Z")
SIGNATURE_NAMESPACE = "terminalx-workspace-openssh"
MAX_PAYLOAD = 128 * 1024 * 1024
MAX_UNPACKED = 512 * 1024 * 1024
MAX_ENTRIES = 4096

# glibc and the kernel ABI are supplied by the workspace base image. Other
# dependencies are resolved from explicitly supplied release build libraries.
BASE_LIBRARIES = frozenset({
    "libc.so.6", "libdl.so.2", "libm.so.6", "libpthread.so.0",
    "libresolv.so.2", "librt.so.1", "libutil.so.1",
    "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1",
})


def version_order(version):
    match = RELEASE.fullmatch(version)
    if not match:
        raise ValueError(f"Invalid OpenSSH version: {version}")
    parts = tuple(int(field or "0") for field in match.groups())
    if any(part >= 2**32 for part in parts) or parts[:3] < (9, 6, 1):
        raise ValueError(f"Unsupported OpenSSH version: {version}")
    return parts


def discover(index):
    """Read a local snapshot of the upstream portable-release inventory."""
    filenames = set(re.findall(r"openssh-[0-9]+\.[0-9]+p[0-9]+\.tar\.gz", index))
    versions = []
    for filename in filenames:
        match = FILENAME.fullmatch(filename)
        if not match:
            continue
        version = match[1]
        try:
            order = version_order(version)
        except ValueError:
            continue
        versions.append((order, version))
    if not versions:
        raise ValueError("No supported portable releases in the inventory")
    return max(versions)[1]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_path(name):
    if len(name) > 240 or any(
        part in ("", ".", "..") or not COMPONENT.fullmatch(part)
        for part in name.split("/")
    ):
        raise ValueError(f"Unsafe payload path: {name}")


def artifact_name(version, architecture):
    version_order(version)
    if architecture not in ARCHITECTURES:
        raise ValueError(f"Unsupported architecture: {architecture}")
    return f"openssh-{version}-linux-{architecture}.tar.gz"


def pack(tree, output):
    daemon = tree / "usr/sbin/sshd"
    if not daemon.is_file() or not daemon.stat().st_mode & 0o111:
        raise ValueError("Payload must include an executable usr/sbin/sshd")
    paths = sorted(tree.rglob("*"))
    if len(paths) > MAX_ENTRIES:
        raise ValueError("Too many payload entries")
    # Publish a completed output into the requested local release folder.
    with tempfile.TemporaryDirectory(dir=output.parent) as scratch:
        candidate = Path(scratch) / output.name
        with candidate.open("xb") as raw, gzip.GzipFile(
            filename="", fileobj=raw, mode="wb", mtime=0
        ) as compressed, tarfile.open(
            fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT
        ) as archive:
            total = 0
            for path in paths:
                name = path.relative_to(tree).as_posix()
                validate_path(name)
                info = tarfile.TarInfo(name)
                if path.is_symlink():
                    raise ValueError(f"Symbolic link in payload: {name}")
                if path.is_dir():
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    archive.addfile(info)
                elif path.is_file():
                    metadata = path.stat()
                    info.size = metadata.st_size
                    total += info.size
                    if total > MAX_UNPACKED:
                        raise ValueError("Payload exceeds expanded size limit")
                    info.mode = 0o755 if metadata.st_mode & 0o111 else 0o644
                    with path.open("rb") as stream:
                        archive.addfile(info, stream)
                else:
                    raise ValueError(f"Unsupported payload entry: {name}")
        if candidate.stat().st_size > MAX_PAYLOAD:
            raise ValueError("Payload exceeds compressed size limit")
        os.link(candidate, output)


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True)


def dependencies(binary):
    output = subprocess.check_output(["readelf", "-d", binary], text=True)
    return set(re.findall(r"\(NEEDED\).*?\[([^\]]+)\]", output))


def bundle_libraries(tree, search):
    binaries = sorted(path for path in (tree / "usr").rglob("*") if path.is_file())
    libraries = tree / "usr/lib"
    libraries.mkdir(parents=True, exist_ok=True)
    seen = set(BASE_LIBRARIES)
    pending = list(binaries)
    while pending:
        binary = pending.pop()
        for name in sorted(dependencies(binary) - seen):
            validate_path(name)
            if "/" in name:
                raise ValueError("Unexpected absolute ELF dependency")
            source = next((directory / name for directory in search if (directory / name).is_file()), None)
            if source is None:
                raise ValueError(f"Missing build dependency {name}")
            destination = libraries / name
            shutil.copyfile(source, destination)
            pending.append(destination)
            seen.add(name)
        relative = os.path.relpath(libraries, binary.parent)
        location = "$ORIGIN" if relative == "." else f"$ORIGIN/{relative}"
        run("patchelf", "--force-rpath", "--set-rpath", location, binary)


def extract_source(source, folder, portable):
    # Portable source releases contain this one version directory. Refuse
    # links, special files, absolute paths and parent traversal.
    prefix = f"openssh-{portable}"
    with tarfile.open(source, "r:gz") as archive:
        for member in archive:
            name = member.name.rstrip("/")
            validate_path(name)
            if name.split("/")[0] != prefix:
                raise ValueError("Source member lies outside the expected version directory")
            dest = folder / name
            if member.isdir():
                dest.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                dest.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as stream, dest.open("xb") as output:
                    shutil.copyfileobj(stream, output)
                dest.chmod(0o755 if member.mode & 0o111 else 0o644)
            else:
                raise ValueError(f"Unsupported source member: {name}")
    return folder / prefix


def build(args):
    if platform.system() != "Linux" or platform.machine() != args.arch:
        raise ValueError("Build on a native Linux machine of the selected architecture")
    name = artifact_name(args.version, args.arch)
    if sha256(args.source) != args.source_sha256:
        raise ValueError("Upstream source SHA-256 mismatch")
    portable = args.version.split("-terminalx.", 1)[0]
    if args.source.name != f"openssh-{portable}.tar.gz":
        raise ValueError("Source filename does not match the pinned version")
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        source = extract_source(args.source, scratch, portable)
        prefix = f"/opt/terminalx/openssh/{args.version}/usr"
        run(
            "./configure", f"--prefix={prefix}", f"--sbindir={prefix}/sbin",
            f"--libexecdir={prefix}/libexec",
            "--sysconfdir=/etc/terminalx/workspace-ssh",
            "--with-privsep-path=/var/lib/terminalx/workspace-ssh/empty",
            "--without-pam", "--without-selinux", "--without-kerberos5",
            cwd=source,
        )
        run("make", f"-j{args.jobs}", cwd=source)
        staged = scratch / "install"
        run("make", "install-nokeys", f"DESTDIR={staged}", cwd=source)
        private = staged / prefix.lstrip("/")
        tree = private.parent
        # Only the daemon and its compiled helper programs are needed. Keep
        # their configured version-specific paths and leave system SSH alone.
        shutil.rmtree(private / "bin")
        if (private / "share").exists():
            shutil.rmtree(private / "share")
        bundle_libraries(tree, args.library_dir)
        daemon = private / "sbin/sshd"
        elf = subprocess.check_output(["readelf", "-h", daemon], text=True)
        machine = {"x86_64": "Advanced Micro Devices X86-64", "aarch64": "AArch64"}[args.arch]
        if not re.search(rf"^\s*Machine:\s*{re.escape(machine)}\s*$", elf, re.MULTILINE):
            raise ValueError("Built OpenSSH binary has the wrong architecture")
        banner = subprocess.check_output([daemon, "-V"], stderr=subprocess.STDOUT, text=True)
        if not re.search(rf"^OpenSSH_{re.escape(portable)}(?:[,\s]|$)", banner, re.MULTILINE):
            raise ValueError("Built OpenSSH binary does not report the pinned version")
        pack(tree, args.output / name)


def write_manifest(args):
    artifacts = []
    for arch in sorted(set(args.arch)):
        locator = artifact_name(args.version, arch)
        artifact = args.output / locator
        if artifact.is_symlink() or not artifact.is_file() or not 0 < artifact.stat().st_size <= MAX_PAYLOAD:
            raise ValueError(f"Missing or invalid local artifact: {locator}")
        artifacts.append({"arch": arch, "locator": locator, "sha256": sha256(artifact)})
    encoded = json.dumps({"v": 1, "version": args.version, "artifacts": artifacts}, indent=2).encode() + b"\n"
    manifest = args.output / "manifest.json"
    signature = manifest.with_suffix(".json.sig")
    # Signing happens against an explicit local key. No lookup of a default
    # production signing key and no upload or hosted operations.
    with tempfile.TemporaryDirectory(dir=args.output) as scratch:
        candidate = Path(scratch) / manifest.name
        candidate.write_bytes(encoded)
        if args.signing_key:
            run("ssh-keygen", "-q", "-Y", "sign", "-n", SIGNATURE_NAMESPACE,
                "-f", args.signing_key, candidate)
        if os.path.lexists(manifest) or os.path.lexists(signature):
            raise ValueError("Use a clean local output directory for the manifest")
        os.link(candidate, manifest)
        if args.signing_key:
            os.link(candidate.with_suffix(".json.sig"), signature)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    track = sub.add_parser("track", help="report the newest version in a local upstream inventory")
    track.add_argument("--index", required=True, type=Path)
    builder = sub.add_parser("build", help="compile and package a pinned local portable release")
    builder.add_argument("--version", required=True)
    builder.add_argument("--arch", required=True, choices=ARCHITECTURES)
    builder.add_argument("--source", required=True, type=Path)
    builder.add_argument("--source-sha256", required=True)
    builder.add_argument("--library-dir", action="append", type=Path, default=[])
    builder.add_argument("--jobs", type=int, default=1, choices=range(1, 33), metavar="1..32")
    builder.add_argument("--output", required=True, type=Path)
    assembler = sub.add_parser("manifest", help="write a local manifest and optional detached signature")
    assembler.add_argument("--version", required=True)
    assembler.add_argument("--arch", required=True, action="append", choices=ARCHITECTURES)
    assembler.add_argument("--output", required=True, type=Path)
    assembler.add_argument("--signing-key", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "track":
            print(discover(args.index.read_text()))
        elif args.command == "build":
            build(args)
        else:
            write_manifest(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
