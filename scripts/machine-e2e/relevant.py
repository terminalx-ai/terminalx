#!/usr/bin/env python3
"""Whether the machines-e2e job must test this change (PRO-358).

CI's `check` fails on a skipped job, so `machines-e2e` always runs and asks
this first. It writes `run=true` or `run=false` to $GITHUB_OUTPUT:

- push, schedule and workflow_dispatch: always true;
- pull_request: true when one of the pull request's files (or the name a
  renamed file had) is under one of RELEVANT. The files come from the GitHub
  API with the job's read-only token; if that fails, from the merge commit's
  diff against its first parent (checkout with fetch-depth 2); if both fail,
  true. It never decides false without a full list.

    EVENT_NAME=pull_request REPOSITORY=owner/repo PR_NUMBER=12 GH_TOKEN=... \
        python3 -I scripts/machine-e2e/relevant.py
"""

import json
import os
import subprocess
import sys
import urllib.request

# Prefixes (ending in "/") and exact paths that change how a computer and a
# machine talk, or how they are tested.
RELEVANT = (
    "src-tauri/src/remote/",
    "src-tauri/src/pairing/",
    "src-tauri/src/serve.rs",
    "src-tauri/src/machine_host/",
    "src-tauri/src/machine_host.rs",
    "src-tauri/src/machines/",
    "src-tauri/src/machine_wire.rs",
    "src-tauri/src/relay_e2ee.rs",
    "src-tauri/serve/",
    "src-tauri/Cargo.lock",
    "scripts/machine-e2e/",
    "scripts/remote-runtime/",
    "src/components/machines/",
    "src/lib/machine",
    ".github/workflows/ci.yml",
    ".github/workflows/machines-e2e-breaks.yml",
)

# The API lists at most 3000 files of a pull request.
API_LIMIT = 3000


def relevant(path):
    """A listed path, or a machine view anywhere in the frontend: any file
    under src/ named for machines (MachineNewSession.tsx, AllowNewMachines.tsx,
    src/types/machines.ts, ...)."""
    if any(path == entry or path.startswith(entry) for entry in RELEVANT):
        return True
    return path.startswith("src/") and "machine" in path.rsplit("/", 1)[-1].lower()


def files_from_api(repository, number, token):
    files = []
    for page in range(1, API_LIMIT // 100 + 1):
        request = urllib.request.Request(
            f"https://api.github.com/repos/{repository}/pulls/{number}/files?per_page=100&page={page}",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "ci-machines-e2e",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            batch = json.load(response)
        for entry in batch:
            files.append(entry["filename"])
            if entry.get("previous_filename"):
                files.append(entry["previous_filename"])
        if len(batch) < 100:
            return files
    raise RuntimeError(f"the pull request lists {API_LIMIT} files or more, more than the API returns")


def files_from_git():
    # Checkout's merge commit: its first parent is the base branch.
    listed = subprocess.run(["git", "diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"], capture_output=True, text=True, timeout=60)
    if listed.returncode != 0:
        raise RuntimeError(listed.stderr.strip() or "git diff failed")
    return [line for line in listed.stdout.splitlines() if line]


def decide():
    event = os.environ.get("EVENT_NAME", "")
    if event != "pull_request":
        return True, f"every {event or 'unknown'} event runs the two-machine tests"
    repository, number, token = os.environ.get("REPOSITORY", ""), os.environ.get("PR_NUMBER", ""), os.environ.get("GH_TOKEN", "")
    files, errors = None, []
    try:
        files = files_from_api(repository, number, token)
    except Exception as error:  # noqa: BLE001 - any failure falls back
        errors.append(f"the API: {error}")
    if files is None:
        try:
            files = files_from_git()
        except Exception as error:  # noqa: BLE001 - any failure runs the tests
            errors.append(f"git: {error}")
    if files is None:
        return True, "the pull request's files could not be listed (" + "; ".join(errors) + "), so the tests run"
    touched = sorted({path for path in files if relevant(path)})
    if touched:
        shown = ", ".join(touched[:10]) + (" and more" if len(touched) > 10 else "")
        return True, f"this pull request changes {shown}"
    return False, f"none of this pull request's {len(files)} files touch the machines, so the two-machine tests are not run"


def main():
    run, reason = decide()
    print(f"machines-e2e: run={str(run).lower()}: {reason}", flush=True)
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"run={str(run).lower()}\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(f"**Two machines end to end:** {'run' if run else 'not run'}: {reason}.\n\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
