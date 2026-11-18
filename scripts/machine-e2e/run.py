#!/usr/bin/env python3
"""The two-machine end-to-end tests (PRO-358), as CI runs them.

    python3 -I scripts/machine-e2e/run.py tests machines_e2e machine_routes
    python3 -I scripts/machine-e2e/run.py breaks

`tests` builds the dev-server's container image (scripts/machine-e2e/Dockerfile)
when this is Linux with Docker, builds terminalx-serve and the named test
targets of src-tauri/serve, checks the binary loads in the image, then runs
each test on its own and times it. The timings (each test, each phase, the
total) go to $GITHUB_STEP_SUMMARY when it is set, else to stdout. It exits
non-zero when anything fails.

`breaks` proves the scenarios still guard what they are for. For each
scripts/machine-e2e/breaks/<name>.patch, which removes one check on purpose:
the patch must apply, the runtime and tests must still build, machines_e2e
must then fail, and its output must hold the marker in <name>.expect (the
message of the assertion that guards that check). The patch is reverted
after each. It exits non-zero when a patch no longer applies or builds, or
the scenarios pass with it, or fail for another reason.

The dev-server runs only from an image named in TERMINALX_E2E_LINUX_IMAGE,
which this sets after building it. With TERMINALX_E2E_REQUIRE_LINUX=1 (CI)
the tests fail without it rather than leave it out. Previous-release
compatibility is the machine-compat job (src-tauri/serve/tests/machine_compat.rs,
PRO-354), not this.
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "scripts" / "machine-e2e"
SERVE = ROOT / "src-tauri" / "serve"
BINARY = ROOT / "src-tauri" / "target" / "debug" / "terminalx-serve"
IMAGE = "terminalx-machine-e2e:local"
BREAKS = HERE / "breaks"


class Failed(Exception):
    pass


class Timings:
    def __init__(self):
        self.rows = []
        self.started = time.monotonic()

    def add(self, what, result, seconds):
        self.rows.append((what, result, seconds))
        print(f"== {what}: {result} in {seconds:.1f} s", flush=True)

    def report(self, title):
        total = time.monotonic() - self.started
        lines = [f"### {title}", "", "| Step | Result | Seconds |", "| --- | --- | ---: |"]
        lines += [f"| {what} | {result} | {seconds:.1f} |" for what, result, seconds in self.rows]
        lines += [f"| **Total** | | **{total:.1f}** |", ""]
        lines.append("Previous-release compatibility is the `machine-compat` job (PRO-354, `src-tauri/serve/tests/machine_compat.rs`).")
        text = "\n".join(lines) + "\n"
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as handle:
                handle.write(text)
        print(text, flush=True)
        return total


def run(command, cwd=ROOT, env=None, capture=False):
    """Run `command`, streaming its output; the output when `capture`."""
    print("$ " + " ".join(str(part) for part in command), flush=True)
    process = subprocess.Popen(
        [str(part) for part in command], cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", bufsize=1
    )
    kept = []
    for line in process.stdout:
        sys.stdout.write(line)
        if capture:
            kept.append(line)
    process.wait()
    sys.stdout.flush()
    return process.returncode, "".join(kept)


def timed(timings, what, command, cwd=ROOT, env=None):
    started = time.monotonic()
    code, _ = run(command, cwd=cwd, env=env)
    timings.add(what, "ok" if code == 0 else f"failed ({code})", time.monotonic() - started)
    if code != 0:
        raise Failed(f"{what} failed with exit code {code}")


def linux_with_docker():
    return platform.system() == "Linux" and shutil.which("docker") is not None


def test_env():
    env = dict(os.environ)
    if linux_with_docker():
        env["TERMINALX_E2E_LINUX_IMAGE"] = IMAGE
    else:
        env.pop("TERMINALX_E2E_LINUX_IMAGE", None)
        print(
            "machine-e2e: no Linux container here (the dev-server runs the binary built on this computer, so it needs Linux and Docker); "
            + ("TERMINALX_E2E_REQUIRE_LINUX=1, so the tests will fail" if env.get("TERMINALX_E2E_REQUIRE_LINUX") == "1" else "its scenarios are left out"),
            flush=True,
        )
    return env


def build_image(timings):
    if linux_with_docker():
        timed(timings, "dev-server image (ubuntu:24.04)", ["docker", "build", "-t", IMAGE, "-f", HERE / "Dockerfile", HERE])


def build_runtime(timings):
    timed(timings, "terminalx-serve build", ["cargo", "build", "--locked", "--bin", "terminalx-serve"], cwd=SERVE)
    if linux_with_docker():
        # The binary from this runner must load in the image: glibc and the
        # libraries it links (a "not found" here would fail every scenario).
        started = time.monotonic()
        script = f'ldd --version | head -n 1; ldd "{BINARY}"; ! ldd "{BINARY}" | grep -q "not found"'
        code, _ = run(["docker", "run", "--rm", "-v", f"{BINARY}:{BINARY}:ro", IMAGE, "sh", "-c", script])
        timings.add("binary loads in the image", "ok" if code == 0 else "missing libraries", time.monotonic() - started)
        if code != 0:
            raise Failed(f"terminalx-serve does not load in {IMAGE}: a library is missing from scripts/machine-e2e/Dockerfile")


def build_tests(timings, targets):
    """Each target's test executable, built."""
    command = ["cargo", "test", "--locked", "--no-run", "--message-format=json-render-diagnostics"]
    for target in targets:
        command += ["--test", target]
    started = time.monotonic()
    print("$ " + " ".join(command), flush=True)
    process = subprocess.run(command, cwd=SERVE, stdout=subprocess.PIPE, text=True, errors="replace")
    timings.add("test build", "ok" if process.returncode == 0 else f"failed ({process.returncode})", time.monotonic() - started)
    if process.returncode != 0:
        raise Failed(f"the tests {targets} do not build")
    executables = {}
    for line in process.stdout.splitlines():
        try:
            message = json.loads(line)
        except ValueError:
            continue
        target = message.get("target") or {}
        if message.get("reason") == "compiler-artifact" and message.get("executable") and "test" in target.get("kind", []) and target.get("name") in targets:
            executables[target["name"]] = message["executable"]
    missing = [target for target in targets if target not in executables]
    if missing:
        raise Failed(f"cargo built no test executable for {missing}")
    return executables


def list_tests(executable):
    listed = subprocess.run([executable, "--list", "--format", "terse"], cwd=SERVE, stdout=subprocess.PIPE, text=True, check=True)
    return [line[: -len(": test")] for line in listed.stdout.splitlines() if line.endswith(": test")]


def run_tests(timings, executables, env):
    """Run every test of every target on its own. Whether all passed, and
    everything they printed."""
    passed, output = True, []
    for target, executable in executables.items():
        names = list_tests(executable)
        if not names:
            raise Failed(f"{target} has no tests")
        for name in names:
            started = time.monotonic()
            code, printed = run([executable, "--exact", name, "--nocapture", "--test-threads=1"], cwd=SERVE, env=env, capture=True)
            timings.add(f"`{target}::{name}`", "passed" if code == 0 else f"FAILED ({code})", time.monotonic() - started)
            output.append(printed)
            passed = passed and code == 0
    return passed, "".join(output)


def tests(targets):
    timings = Timings()
    try:
        build_image(timings)
        build_runtime(timings)
        executables = build_tests(timings, targets)
        passed, _ = run_tests(timings, executables, test_env())
    except Failed as error:
        print(f"::error::{error}", flush=True)
        passed = False
    total = timings.report("Two machines end to end (PRO-358)")
    if total > 600:
        print(f"::warning::the two-machine tests took {total:.0f} s, more than the ten minutes the job is meant to take", flush=True)
    return 0 if passed else 1


def breaks():
    timings = Timings()
    patches = sorted(BREAKS.glob("*.patch"))
    if not patches:
        print(f"::error::no break patches in {BREAKS}", flush=True)
        return 1
    caught = True
    try:
        build_image(timings)
    except Failed as error:
        print(f"::error::{error}", flush=True)
        timings.report("Machines e2e: deliberate breaks (PRO-358)")
        return 1
    env = test_env()
    for patch in patches:
        name = patch.stem
        expect = patch.with_suffix(".expect")
        marker = expect.read_text(encoding="utf-8").strip() if expect.exists() else ""
        if not marker:
            print(f"::error::{expect.name} is missing or empty: it names the assertion {patch.name} must fail", flush=True)
            caught = False
            continue
        if subprocess.run(["git", "apply", "--check", str(patch)], cwd=ROOT).returncode != 0:
            print(f"::error::{patch.name} no longer applies to this tree: update it to remove the same check", flush=True)
            timings.add(f"{name}: applies", "NO", 0)
            caught = False
            continue
        subprocess.run(["git", "apply", str(patch)], cwd=ROOT, check=True)
        try:
            build_runtime(timings)
            executables = build_tests(timings, ["machines_e2e"])
            passed, output = run_tests(timings, executables, env)
            if passed:
                print(f"::error::with {patch.name} applied the scenarios passed: they no longer guard that check", flush=True)
                timings.add(f"{name}: caught", "NO, the scenarios passed", 0)
                caught = False
            elif marker not in output:
                print(f"::error::with {patch.name} applied the scenarios failed, but not with {marker!r}: they failed for another reason", flush=True)
                timings.add(f"{name}: caught", "NO, another failure", 0)
                caught = False
            else:
                timings.add(f"{name}: caught", f"yes ({marker})", 0)
        except Failed as error:
            print(f"::error::with {patch.name} applied: {error}", flush=True)
            caught = False
        finally:
            subprocess.run(["git", "apply", "-R", str(patch)], cwd=ROOT, check=True)
    timings.report("Machines e2e: deliberate breaks (PRO-358)")
    return 0 if caught else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    run_tests_parser = commands.add_parser("tests", help="build and run test targets of src-tauri/serve, timed")
    run_tests_parser.add_argument("targets", nargs="+", help="test targets, e.g. machines_e2e machine_routes")
    commands.add_parser("breaks", help="each patch in breaks/ must make machines_e2e fail")
    arguments = parser.parse_args()
    if arguments.command == "tests":
        return tests(arguments.targets)
    return breaks()


if __name__ == "__main__":
    sys.exit(main())
