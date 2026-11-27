#!/usr/bin/env python3
"""Say which parts of CI a pull request needs, from both sides of its merge base.

Five answers, each `true` or `false`, written to $GITHUB_OUTPUT:

- `required`: the macOS job (Swift tests, icons, the helper, the Apple-only and
  system-dependent Rust tests);
- `rust`: the Rust jobs on Linux;
- `frontend`: the frontend jobs (TypeScript, Vitest, the WebKit checks on Linux);
- `phone`: the phone app's own checks;
- `mac-webkit`: the WebKit checks that run on macOS alone (`run-all.mjs`
  `macOnly`): their scripts, what those load, and the product they render.

No GitHub API permissions are needed. Paths and source are read from Git
objects, so deleted and renamed files still count. This is a coverage selector,
not a security boundary for self-hosted runners. docs/CI-RUNNERS.md "What a
pull request runs" says what each rule leaves to `main`.
"""

import argparse
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tomllib


APPLE_CFG = re.compile(rb'target_(?:os\s*=\s*"macos"|vendor\s*=\s*"apple")')

# A change to the workflow, or to this selector and its policy tests, runs
# everything: nothing else would show that the jobs still work.
EVERYTHING = (".github/workflows/ci.yml", "infra/ci-runners/")

# Modules that are compiled only for Apple systems: a file or folder behind a
# `#[cfg(target_os = "macos")] mod …;`, a file holding such a module inline, or
# one named for macOS. test_macos_rust.py fails when the source has one that is
# not here.
APPLE_ONLY = (
    "src-tauri/serve/tests/local_platform.rs",
    "src-tauri/src/computer/code_identity.rs",
    "src-tauri/src/computer/macos_native.rs",
    "src-tauri/src/dictation.rs",
    "src-tauri/src/harness/codex/browser_use_macos",
    # The dormant approved-command executor and its policy (PRO-220): macOS enforcement, no caller yet.
    "src-tauri/src/host_command_",
    "src-tauri/src/local_runtime/platform",
    "src-tauri/src/machine_host/window_consent_tests.rs",
    "src-tauri/src/power.rs",
    "src-tauri/src/remote/port_listeners.rs",
    "src-tauri/src/startup/macos",
    "src-tauri/src/transcription/engine.rs",
    "src-tauri/src/transcription/live",
    "src-tauri/src/transparency.rs",
)

# What the macOS job builds from or checks besides those modules.
MACOS = EVERYTHING + APPLE_ONLY + (
    "native/",
    "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/serve/Cargo.toml", "src-tauri/build.rs",
    "src-tauri/tauri", "src-tauri/Entitlements", "src-tauri/Info.plist", "src-tauri/icons",
    # The crate roots declare every module, the Apple-only ones among them.
    "src-tauri/src/lib.rs", "src-tauri/src/main.rs",
    "rust-toolchain.toml", "rust-toolchain", ".cargo/", "src-tauri/.cargo/",
    # The scripts the job runs and the ones those import, and the Node version it installs. test_macos_rust.py
    # fails when the job runs a script that is not here.
    "scripts/build-computer-macos.mjs", "scripts/test_icons.py", "scripts/test_packaged_icons.py", "scripts/test_compiled_icons.py",
    "scripts/verify_packaged_icons.py", ".nvmrc",
    "src-tauri/capabilities/",
    # Path dependencies Cargo builds for an Apple target alone (a build.rs and C++ that Linux never compiles).
    # test_macos_rust.py fails when Cargo.toml has one that is not here.
    "src-tauri/src/transcription/native-detector",
    # Approval wrappers depend on shell and loader behaviour on both operating systems.
    "src-tauri/src/harness/read_only",
)

# The Rust tests the macOS job runs on a pull request, as libtest filters (a
# filter matches every test whose name contains it). The Apple-only modules,
# every module with code behind an Apple cfg, and the modules whose behaviour
# is the system's without one: terminals, process groups, paths, the keychain,
# sockets. test_macos_rust.py fails when a file with an Apple cfg is under none
# of them. The full suite runs on main, nightly and manual runs.
MACOS_FILTERS = (
    "account::", "agent_accounts::", "agent_keys::", "agent_local_login::", "browser::", "chat_windows::", "cloud_agent_client::",
    "cloud_mirror", "cloud_resources::", "commands::", "computer::", "container_vm::", "control::", "data_privacy::",
    "dictation::", "direct_endpoints::", "drag_text::", "floating::", "github::", "github_process", "harness::codex::",
    "harness::read_only", "host_command_policy::", "keychain::", "local_runtime::", "local_vm::", "machine_account::", "machine_host::",
    "machine_name::", "machines::", "native_menu::", "notification_permission::", "orchestration_archive::",
    "pairing::", "power::", "pty::", "quit::", "remote::environment", "remote::machine", "remote::port_listeners",
    "secret_clipboard::", "serve::", "serve_cli::", "sidebar_activity::", "skills::", "startup::", "status::",
    "store::activity", "store::environment", "store::settings", "store::managed_configuration", "stray_processes::", "team_artifact_control::", "transcription::",
    "transparency::", "updater::", "worktree_cleanup::",
)

# Rust: the crates, and every path outside them that a Rust test or build
# script reads. test_macos_rust.py fails when a test reads one that is not here.
RUST = EVERYTHING + (
    "src-tauri/", "native/", "skill-guides/", "skills/", "schemas/", ".terminalx/", "index.html",
    "rust-toolchain.toml", "rust-toolchain", ".cargo/",
    "scripts/remote-runtime/", "scripts/release/txrelease/", "scripts/install/", "scripts/local-runtime/",
    "scripts/machine-e2e/", "scripts/machine-compat/", "scripts/build-computer-macos.mjs", "scripts/linux-runtime-probe",
    "packages/portable/src/",
    "src/lib/fixtures/", "src/lib/__fixtures__/", "src/lib/mediaTypes.json", "src/lib/repo.ts",
    "src/lib/reservedAttachmentNames.json", "src/lib/userPreferenceDefaults.json",
    "docs/MACHINES.md", ".github/ISSUE_TEMPLATE/",
)

# The frontend: its sources and tooling, the phone app's sources (a desktop
# test imports from them, and the root Vitest run includes their tests), and
# every Rust or other file a frontend test reads by path. test_macos_rust.py fails
# when a test names one that is not here.
FRONTEND = EVERYTHING + (
    "src/", "packages/", "scripts/", "public/", "patches/", "index.html",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vite.config.ts", "tsconfig", ".nvmrc",
    "mobile/src/",
    ".github/workflows/team-e2e-nightly.yml", "bench/orchestration/", "docs/COMPUTER-USE.md", "native/",
    "schemas/", "skill-guides/",
    "src-tauri/src/agent_accounts", "src-tauri/src/cli.rs", "src-tauri/src/computer/permissions.rs",
    "src-tauri/src/control.rs", "src-tauri/src/fixtures/", "src-tauri/src/pairing/mod.rs",
    "src-tauri/src/pairing/wire.rs", "src-tauri/src/phone/mod.rs", "src-tauri/src/remote/protocol.rs",
    "src-tauri/src/session_names.rs", "src-tauri/src/session_ops.rs", "src-tauri/src/store/settings/schema.rs",
    # What the desktop's own sources import from outside src/ and packages/. test_macos_rust.py fails when a
    # source file imports one that is not here.
    "CHANGELOG.md", "src-tauri/icons/", "src-tauri/src/store/environment_reserved.json",
)

# The phone app, the package it shares with the desktop, and the desktop types it imports.
PHONE = EVERYTHING + (
    "mobile/", "packages/", "patches/", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".nvmrc",
    # Every desktop file a phone source imports. test_macos_rust.py fails when one is not here.
    "src/types/bots", "src/types/botItems", "src/types/configuration",
)

RULES = {"required": MACOS, "rust": RUST, "frontend": FRONTEND, "phone": PHONE}

# The WebKit checks that run on macOS alone are named in run-all.mjs's `macOnly`, read from both sides of the change,
# so a check moved there selects its own script with no change here. Each such script, run-all.mjs, and every file in
# scripts/webkit/ that one of them names by a `./` path (harness.mjs, the stubs it reads) select the job.
RUN_ALL = "scripts/webkit/run-all.mjs"
WEBKIT = "scripts/webkit/"
MAC_ONLY_MAP = re.compile(r"export const macOnly = new Map\(\[(.*?)\n\]\);", re.S)
MAC_ONLY_NAME = re.compile(r'^\s*\["([\w:-]+)",', re.M)
LOCAL_FILE = re.compile(r"""["']\./([\w.-]+\.m?js)["']""")

# What every mac-only check renders: the app's shell, its styles and theme, the platform it reads, and what builds it
# (the Vite config, the packages and their patches, Playwright's WebKit among them, and the Node version).
MAC_WEBKIT_SHELL = (
    "src/App.tsx", "src/main.tsx", "index.html", "src/styles/", "src/lib/glass.ts", "src/lib/theme.ts",
    "src/lib/platform.ts", "src/components/layout/", "src/components/ui/",
    "vite.config.ts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/", ".nvmrc",
)

# And what each one renders besides: the product paths its assertions measure. A name in `macOnly` that is not here
# selects the job on every frontend change (`frontend`'s rules): what cannot be placed is not left out.
# test_macos_rust.py fails when one is missing and when a path here is not in the tree.
MAC_WEBKIT_RENDERS = {
    # The transcript's and the composer's scrollbars, and the prompt map's rail beside them.
    "chat-scrollbar": ("src/components/chat/",),
    # The resource popover (StatusBar, in layout) over a live terminal and chat.
    "app-resources": ("src/components/chat/", "src/components/terminal/"),
    # A lead's workers in the sidebar (RunRows, in layout) and their run marks.
    "run-sidebar": ("src/components/orchestration/", "src/components/session/"),
    # Tooltips, menus, question cards and the recovery banner over the chat and the composer.
    "readable-panels": ("src/components/chat/",),
    # A pull request's conversation in the review panel, scrolled.
    "pr-conversation": ("src/components/changes/",),
    # Holding Right Option to talk: the composer's dictation and the shortcut that holds it.
    "dictation-hold-to-talk": (
        "src/components/chat/", "src/lib/dictation.ts", "src/lib/dictationContext.ts", "src/lib/dictationText.ts",
        "src/lib/shortcuts.ts", "src/lib/shortcutMigration.ts", "src/lib/hotkeys.ts",
    ),
}


def git(*args):
    return subprocess.check_output(["git", *args])


def matches(path, rules):
    return any(path == rule or path.startswith(rule) for rule in rules)


def covered(path, rules):
    """As `matches`, and a folder is covered by a rule for what is in it."""
    return matches(path, rules) or matches(path + "/", rules)


def changed_files(base, head):
    base = git("merge-base", base, head).decode().strip()
    # --no-renames reports both the old deletion and the new addition.
    changed = git("diff", "--no-renames", "--name-only", "-z", base, head).decode().split("\0")
    return base, [path for path in changed if path]


def holds_an_apple_cfg(base, head, paths):
    """The changed Rust files that hold an Apple cfg, before or after the change.

    A line Linux never compiles has no other check before merge, and a change
    anywhere in a file can break its Apple branch (an import, a type, a helper
    the branch calls), so the whole file counts, not the lines near the cfg.
    The names are git's own (`--name-only -z`), so one with a space or a
    non-ASCII character is read as it is. A file that cannot be read on either
    side selects macOS: what cannot be placed is not left out.
    """
    found = []
    for path in paths:
        if not (path.startswith("src-tauri/") and path.endswith(".rs")):
            continue
        sides = [subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True) for rev in (base, head)]
        if all(side.returncode for side in sides) or any(not side.returncode and APPLE_CFG.search(side.stdout) for side in sides):
            found.append(path)
    return sorted(found)


def select(base, head):
    """The changed paths that need the macOS job."""
    base, changed = changed_files(base, head)
    return sorted({path for path in changed if matches(path, MACOS)} | set(holds_an_apple_cfg(base, head, changed)))


def answers(base, head):
    """Each output with the changed paths that asked for it."""
    merge_base, changed = changed_files(base, head)
    found = {name: sorted(path for path in changed if matches(path, rules)) for name, rules in RULES.items()}
    found["required"] = sorted(set(found["required"]) | set(holds_an_apple_cfg(merge_base, head, changed)))
    rules = mac_webkit_rules(merge_base) | mac_webkit_rules(head)
    found["mac-webkit"] = sorted(path for path in changed if matches(path, tuple(rules)))
    return found


def shown(rev, path):
    """The file at `path` in `rev`, or None when it is not there."""
    done = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True)
    return done.stdout.decode(errors="replace") if done.returncode == 0 else None


def mac_only_checks(text):
    """The names in run-all.mjs's `macOnly`, or None when the list cannot be read from `text`."""
    block = MAC_ONLY_MAP.search(text or "")
    names = MAC_ONLY_NAME.findall(block.group(1)) if block else []
    return names or None


def mac_webkit_rules(rev, read=None):
    """The paths that select the macOS WebKit job, as `macOnly` stands in `rev`.

    `read(path)` gives a file's text or None; by default it is read from Git at `rev`. When run-all.mjs is missing or
    its `macOnly` cannot be read, every frontend path selects: the job is never left out on a guess.
    """
    read = read or (lambda path: shown(rev, path))
    rules = set(EVERYTHING) | {RUN_ALL}
    names = mac_only_checks(read(RUN_ALL))
    if names is None:
        return rules | set(FRONTEND)
    pending = [f"{WEBKIT}{name.split(':')[0]}.mjs" for name in names]
    seen = set()
    while pending:
        script = pending.pop()
        if script in seen:
            continue
        seen.add(script)
        pending += [f"{WEBKIT}{name}" for name in LOCAL_FILE.findall(read(script) or "")]
    rules |= seen | set(MAC_WEBKIT_SHELL)
    for name in names:
        rules |= set(MAC_WEBKIT_RENDERS.get(name, FRONTEND))
    return rules


def filter_path(name):
    """Where the modules a test filter names live, as a path prefix."""
    return "src-tauri/src/" + name.rstrip(":").replace("::", "/")


def apple_only_modules(root):
    """Every Apple-only module in the source tree under `root`, as the paths APPLE_ONLY must cover."""
    root = Path(root)
    files = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z", "src-tauri"]).decode().split("\0")
    tracked = set(files)
    found = set()
    for filename in files:
        if not filename.endswith(".rs"):
            continue
        if "macos" in PurePosixPath(filename).name:
            found.add(filename)
        lines = (root / filename).read_text(errors="replace").split("\n")
        for index, line in enumerate(lines):
            text = line.strip()
            if not APPLE_CFG.search(text.encode()) or "not(" in text:
                continue
            if text.startswith("#![cfg("):
                found.add(filename)
            if not text.startswith("#[cfg("):
                continue
            after = index + 1
            while after < len(lines) and (not lines[after].strip() or lines[after].strip().startswith(("#[", "//"))):
                after += 1
            declared = re.match(r"\s*(?:pub(?:\([a-z: ]+\))?\s+)?mod\s+(\w+)\s*([;{])", lines[after]) if after < len(lines) else None
            if not declared:
                continue
            if declared.group(2) == "{":
                found.add(filename)
                continue
            path = PurePosixPath(filename)
            folder = path.parent if path.name in ("mod.rs", "lib.rs", "main.rs") else path.with_suffix("")
            for candidate in (f"{folder}/{declared.group(1)}.rs", f"{folder}/{declared.group(1)}/mod.rs"):
                if candidate in tracked:
                    found.add(candidate)
    return sorted(found)


def apple_cfg_files(root):
    """Every Rust file of the desktop library with an Apple cfg."""
    root = Path(root)
    files = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z", "src-tauri/src"]).decode().split("\0")
    return sorted(f for f in files if f.endswith(".rs") and APPLE_CFG.search((root / f).read_bytes()))


def tracked(root):
    files = [f for f in subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"]).decode().split("\0") if f]
    folders = {str(parent) for f in files for parent in PurePosixPath(f).parents}
    return files, set(files) | folders


def normal(path):
    parts = []
    for part in PurePosixPath(path).parts:
        if part == "..":
            if not parts:
                return None
            parts.pop()
        elif part not in (".", "/"):
            parts.append(part)
    return "/".join(parts)


def rust_reads(root):
    """The tracked paths outside src-tauri that a Rust source names with `..`.

    `include_str!` reads from the file's own folder and CARGO_MANIFEST_DIR from
    the crate's, so a literal is tried against both.
    """
    files, known = tracked(root)
    found = {}
    for filename in files:
        if not (filename.startswith("src-tauri/") and filename.endswith(".rs")):
            continue
        crate = "src-tauri/serve" if filename.startswith("src-tauri/serve/") else "src-tauri"
        for literal in re.findall(r'"/?((?:\.\./)+[^"\s]*)"', (Path(root) / filename).read_text(errors="replace")):
            for base in (str(PurePosixPath(filename).parent), crate):
                path = normal(f"{base}/{literal}")
                if path and path in known and not path.startswith("src-tauri"):
                    found.setdefault(path, filename)
    return found


FRONTEND_TEST = re.compile(r"\.test\.(?:ts|tsx|mjs|js)$")


def frontend_reads(root):
    """The tracked paths that a desktop frontend test names from the repository's root."""
    files, known = tracked(root)
    top = {f.split("/")[0] for f in files if "/" in f}
    found = {}
    for filename in files:
        if not FRONTEND_TEST.search(filename) or filename.startswith("mobile/"):
            continue
        for literal in re.findall(r"""["'`](?:\.\./)*([\w.-]+/[\w./-]+)""", (Path(root) / filename).read_text(errors="replace")):
            path = normal(literal)
            if path and path.split("/")[0] in top and path in known:
                found.setdefault(path, filename)
    return found


IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bimport\s+)["'](\.{1,2}/[^"'\n]+)["']""")
SOURCE = (".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".cjs")


def leaving_imports(root, inside, own):
    """The tracked files outside `own` that a source file under `inside` imports by a relative path.

    Every source file, not only tests: a type or a JSON file imported from
    another tree changes what this tree compiles to.
    """
    files, known = tracked(root)
    found = {}
    for filename in files:
        if not filename.startswith(inside) or not filename.endswith(SOURCE):
            continue
        folder = str(PurePosixPath(filename).parent)
        for literal in IMPORT.findall((Path(root) / filename).read_text(errors="replace")):
            path = normal(f"{folder}/{literal.split('?')[0]}")
            if not path or path.startswith(own):
                continue
            for candidate in (path, *(path + ext for ext in (".ts", ".tsx", ".d.ts", ".mjs", ".js", ".json")), *(f"{path}/index{ext}" for ext in (".ts", ".tsx", ".js"))):
                if candidate in known and candidate in files:
                    found.setdefault(candidate, filename)
                    break
    return found


def apple_path_dependencies(root):
    """The folders of the path dependencies Cargo builds only for an Apple target."""
    found = []
    for manifest in ("src-tauri/Cargo.toml", "src-tauri/serve/Cargo.toml"):
        file = Path(root) / manifest
        if not file.exists():
            continue
        for target, tables in tomllib.loads(file.read_text()).get("target", {}).items():
            if not APPLE_CFG.search(target.encode()):
                continue
            for kind in ("dependencies", "dev-dependencies", "build-dependencies"):
                for dependency in tables.get(kind, {}).values():
                    if isinstance(dependency, dict) and "path" in dependency:
                        found.append(normal(f"{PurePosixPath(manifest).parent}/{dependency['path']}"))
    return sorted(set(found))


def macos_job_scripts(root):
    """The scripts the macOS job's steps run, and the scripts beside them that those import."""
    workflow = Path(root) / ".github/workflows/ci.yml"
    if not workflow.exists():
        return []
    text = workflow.read_text()
    start = text.index("\n  macos-native:")
    job = re.split(r"\n  [\w-]+:\n", text[start + 1:], maxsplit=1)[0]
    files, _ = tracked(root)
    found = {path for path in re.findall(r"\bscripts/[\w./-]+", job) if path in files}
    pending = list(found)
    while pending:
        script = pending.pop()
        if not script.endswith(".py"):
            continue
        for module in re.findall(r"^\s*(?:from|import)\s+([\w.]+)", (Path(root) / script).read_text(errors="replace"), re.M):
            beside = f"{PurePosixPath(script).parent}/{module.split('.')[0]}.py"
            if beside in files and beside not in found:
                found.add(beside)
                pending.append(beside)
    return sorted(found)


def gaps(root):
    """What the rules above miss in the tree under `root`: empty when they are whole."""
    filters = [filter_path(name) for name in MACOS_FILTERS]
    return {
        "Apple-only modules not in APPLE_ONLY": [m for m in apple_only_modules(root) if not covered(m, APPLE_ONLY)],
        "files with an Apple cfg under no macOS test filter": [
            f for f in apple_cfg_files(root) if not covered(f, MACOS) and not any(f.startswith(prefix) for prefix in filters)
        ],
        "paths a Rust source reads that RUST does not name": sorted(p for p in rust_reads(root) if not covered(p, RUST)),
        "paths a frontend test reads that FRONTEND does not name": sorted(p for p in frontend_reads(root) if not covered(p, FRONTEND)),
        "files the desktop frontend imports that FRONTEND does not name": sorted(
            p for inside in ("src/", "packages/") for p in leaving_imports(root, inside, ("src/", "packages/")) if not covered(p, FRONTEND)
        ),
        "files the phone app imports that PHONE does not name": sorted(p for p in leaving_imports(root, "mobile/", ("mobile/",)) if not covered(p, PHONE)),
        "Apple-only path dependencies that MACOS does not name": [p for p in apple_path_dependencies(root) if not covered(p, MACOS)],
        "scripts the macOS job runs that MACOS does not name": [p for p in macos_job_scripts(root) if not covered(p, MACOS)],
        "mac-only WebKit checks MAC_WEBKIT_RENDERS does not name": [
            name for name in (mac_only_checks(read_tree(root, RUN_ALL)) or []) if name not in MAC_WEBKIT_RENDERS
        ],
    }


def read_tree(root, path):
    file = Path(root) / path
    return file.read_text(errors="replace") if file.exists() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--all", action="store_true", help="Answer true for everything (main, nightly and manual runs)")
    parser.add_argument("--list", action="store_true", help="Print each rule's paths")
    parser.add_argument("--filters", action="store_true", help="Print the macOS job's test filters on one line")
    args = parser.parse_args()
    if args.filters:
        print(" ".join(MACOS_FILTERS))
        return
    if args.list:
        for name, rules in {**RULES, "mac-webkit": mac_webkit_rules("HEAD", lambda path: read_tree(".", path))}.items():
            print(f"{name}:")
            for rule in sorted(rules):
                print(f"  {rule}")
        return
    if args.all:
        found = {name: ["(not a pull request)"] for name in [*RULES, "mac-webkit"]}
    elif args.base:
        found = answers(args.base, args.head)
    else:
        parser.error("--base is required unless --all, --list or --filters is given")
    for name, paths in found.items():
        print(f"{name}: {'true' if paths else 'false'}")
        for path in paths[:20]:
            print(f"  {path}")
        if len(paths) > 20:
            print(f"  … and {len(paths) - 20} more")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            for name, paths in found.items():
                stream.write(f"{name}={'true' if paths else 'false'}\n")


if __name__ == "__main__":
    main()
