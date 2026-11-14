#!/usr/bin/env python3
"""Collect successful CI attempts using read-only gh API calls; report minutes.

Only public run metadata and durations are saved, never runner names or addresses.
Choose non-overlapping date windows for baseline, split CI and Hetzner. Keep PR
and push samples separate, and compare the same job/coverage mix.
"""

import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import statistics
import subprocess
from urllib.parse import urlencode


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def summarize(run, jobs):
    # A rerun can contain only the failed jobs. Combining those with timings
    # from the first attempt would misstate both the total and the job mix.
    if run["run_attempt"] != 1:
        raise ValueError("Partial/retried attempts are not comparable")
    completed = [j for j in jobs if j["conclusion"] == "success"]
    if not completed:
        raise ValueError("Run has no successful jobs")
    minutes = lambda start, end: (timestamp(end) - timestamp(start)).total_seconds() / 60
    return {
        "id": run["id"], "url": run["html_url"], "sha": run["head_sha"],
        "event": run["event"], "started_at": run["run_started_at"],
        "minutes": {
            "Whole run": minutes(run["run_started_at"], max(j["completed_at"] for j in completed)),
            **{j["name"]: minutes(j["started_at"], j["completed_at"]) for j in completed},
        },
    }


def percentile90(values):
    # Nearest rank, so the ninth observation is p90 for ten runs.
    return sorted(values)[math.ceil(0.9 * len(values)) - 1]


def report(runs, label):
    print(f"{label}: {len(runs)} successful first attempts; durations in minutes.\n")
    print("| Job | Runs | Median | p90 (nearest rank) |")
    print("| --- | ---: | ---: | ---: |")
    names = sorted({name for run in runs for name in run["minutes"]})
    for name in names:
        values = [run["minutes"][name] for run in runs if name in run["minutes"]]
        print(f"| {name} | {len(values)} | {statistics.median(values):.1f} | {percentile90(values):.1f} |")
    print("\nSamples:")
    for run in runs:
        print(f"- [{run['id']}]({run['url']}) · {run['started_at']} · `{run['sha'][:12]}`")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="terminalx-ai/terminalx")
    parser.add_argument("--event", choices=("pull_request", "push"), default="pull_request")
    parser.add_argument("--created", help="GitHub date range, e.g. START..END (ISO dates/timestamps)")
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=Path, help="Save sanitized input for a reproducible report")
    parser.add_argument("--input", type=Path, help="Report a previously saved sample without API calls")
    args = parser.parse_args()
    if args.count < 10:
        parser.error("at least 10 runs are required")
    if args.input:
        runs = json.loads(args.input.read_text())
    else:
        runs = []
        page = 1
        while len(runs) < args.count:
            query = {"status": "success", "event": args.event, "per_page": 100, "page": page}
            if args.created:
                query["created"] = args.created
            batch = api(f"repos/{args.repo}/actions/workflows/ci.yml/runs?{urlencode(query)}")["workflow_runs"]
            if not batch:
                break
            for run in batch:
                if run["run_attempt"] != 1:
                    continue
                jobs = []
                job_page = 1
                while True:
                    chunk = api(f"repos/{args.repo}/actions/runs/{run['id']}/attempts/1/jobs?per_page=100&page={job_page}")["jobs"]
                    jobs.extend(chunk)
                    if len(chunk) < 100:
                        break
                    job_page += 1
                runs.append(summarize(run, jobs))
                if len(runs) == args.count:
                    break
            page += 1
    if len(runs) < args.count:
        parser.error(f"only {len(runs)} qualifying runs; need {args.count}. No comparison claimed.")
    if args.output:
        args.output.write_text(json.dumps(runs, indent=2) + "\n")
    report(runs, args.label)


if __name__ == "__main__":
    main()
