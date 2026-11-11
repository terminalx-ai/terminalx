#!/usr/bin/env python3
"""Select PRs needing macOS Rust tests from both sides of the PR's merge base.

No GitHub API permissions are needed. Paths and source are read from Git objects,
so deleted/renamed macOS code still selects the suite. This is a coverage selector,
not a security boundary for self-hosted runners.
"""

import argparse
import os
from pathlib import PurePosixPath
import re
import subprocess


APPLE_CFG = re.compile(rb'target_(?:os\s*=\s*"macos"|vendor\s*=\s*"apple")')
ALWAYS = (
    "native/", ".github/", "infra/ci-runners/", "scripts/", ".cargo/",
    "rust-toolchain.toml", "rust-toolchain", ".nvmrc", "src-tauri/.cargo/",
    "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs",
    "src-tauri/tauri", "src-tauri/capabilities/", "src-tauri/permissions/",
    "src-tauri/Entitlements", "src-tauri/Info.plist",
    "src-tauri/src/lib.rs", "src-tauri/src/main.rs",
    # Approval wrappers depend on shell/loader behavior on both operating systems.
    "src-tauri/src/harness/read_only",
)


def git(*args):
    return subprocess.check_output(["git", *args])


def macos_paths(revision):
    paths = set(ALWAYS)
    files = git("ls-tree", "-r", "--name-only", "-z", revision, "src-tauri").decode().split("\0")
    for filename in filter(None, files):
        path = PurePosixPath(filename)
        if path.name in ("Cargo.toml", "Cargo.lock"):
            paths.add(filename)
        if path.suffix != ".rs":
            continue
        source = git("show", f"{revision}:{filename}")
        if APPLE_CFG.search(source) or "macos" in filename:
            paths.add(filename)
            # Include companion modules and tests without their own cfg. For
            # nested modules, conservatively include their whole directory.
            if str(path.parent) in ("src-tauri", "src-tauri/src"):
                paths.add(str(path.with_suffix("")) + "/")
            else:
                paths.add(str(path.parent) + "/")
    return paths


def select(base, head):
    base = git("merge-base", base, head).decode().strip()
    paths = macos_paths(base) | macos_paths(head)
    # --no-renames reports both the old deletion and the new addition.
    changed = git("diff", "--no-renames", "--name-only", "-z", base, head).decode().split("\0")
    return sorted(p for p in changed if p and any(p == rule or p.startswith(rule) for rule in paths))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--list", action="store_true", help="Print the current coverage paths")
    args = parser.parse_args()
    if args.list:
        print("\n".join(sorted(macos_paths(args.head))))
        return
    selected = select(args.base, args.head)
    result = "true" if selected else "false"
    print(f"macOS Rust suite: {result}")
    for path in selected:
        print(f"  {path}")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            stream.write(f"required={result}\n")


if __name__ == "__main__":
    main()
