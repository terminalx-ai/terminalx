#!/usr/bin/env python3
"""Summarise the phone's measurement marks (issue #989).

Usage: python3 -I analyze.py cold <dir-of-jsonl>   # cold-start step table
       python3 -I analyze.py warm <dir-of-jsonl>   # return-from-background table
       python3 -I analyze.py keepalive <dir-of-jsonl>  # keep-alive sends, answers, losses

Each JSONL file is one launch, written by mobile/src/measure/marks.ts. Every
number this prints is computed from those files, nothing else. Percentiles use
the nearest-rank method: p90 of n values is the ceil(0.9 * n)-th smallest.
"""
import json
import math
import pathlib
import sys


def load(path):
    marks = []
    for line in pathlib.Path(path).read_text().splitlines():
        if line.strip():
            marks.append(json.loads(line))
    return marks


def nearest_rank(values, q):
    ordered = sorted(values)
    return ordered[max(1, math.ceil(q * len(ordered))) - 1]


def median(values):
    ordered = sorted(values)
    n = len(ordered)
    return ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2


def first(marks, name, after=None):
    for m in marks:
        if m["name"] == name and (after is None or m["wall"] >= after):
            return m
    return None


# Cold start: consecutive points from process start to current content.
COLD_POINTS = [
    ("process start", None),
    ("didFinishLaunching", None),
    ("JS module eval", "js.module-eval"),
    ("root render", "01.root-render"),
    ("storage read done", "02.storage-read.end"),
    ("account check done", "03.account-refresh.end"),
    ("initial URL", "05.initial-url"),
    ("credential read", "06.credential-read.end"),
    ("E2EE key loaded", "08.e2ee-key.end"),
    ("race start", "09.race-start"),
    ("relay socket open", "09s.socket-open"),
    ("relay hello", "09r5.relay-hello"),
    ("e2ee_ready", "10.e2ee-ready"),
    ("e2ee_authenticated", "11.e2ee-authenticated"),
    ("connected", "14.connected"),
    ("storage writes done", "15.stored"),
    ("capabilities answered", "18.capabilities.ok"),
    ("summaries answered", "18.summaries.ok"),
    ("list rendered", "18.list-rendered"),
]


def cold_points(marks):
    head = marks[0]
    points = {}
    if head.get("processStartWall"):
        points["process start"] = head["processStartWall"]
    if head.get("didFinishLaunchingWall"):
        points["didFinishLaunching"] = head["didFinishLaunchingWall"]
    for label, name in COLD_POINTS:
        if name:
            m = first(marks, name)
            if m:
                points[label] = m["wall"]
    return points


def cold(directory):
    runs = []
    for path in sorted(pathlib.Path(directory).glob("*.jsonl")):
        marks = load(path)
        runs.append((path.name, cold_points(marks), first(marks, "09.winner")))
    print(f"runs: {len(runs)}")
    for name, _, winner in runs:
        print(f"  {name}: winner path {winner.get('path') if winner else 'none'}")
    # Each run walks the points it has, in order; a step is "previous present point -> this point".
    # A run won by the direct path has no relay-only points, so its steps join around them.
    order = ["process start", "didFinishLaunching"] + [label for label, name in COLD_POINTS if name]
    steps = {}
    for _, p, _ in runs:
        present = [label for label in order if label in p]
        for prev, cur in zip(present, present[1:]):
            steps.setdefault((prev, cur), []).append(p[cur] - p[prev])
    print("| Step (from previous point to this point) | n | median ms | p90 ms |")
    print("| --- | --- | --- | --- |")
    for (prev, cur), deltas in sorted(steps.items(), key=lambda kv: (order.index(kv[0][1]), order.index(kv[0][0]))):
        print(f"| {prev} -> {cur} | {len(deltas)} | {median(deltas):.0f} | {nearest_rank(deltas, 0.9):.0f} |")
    totals = [p["list rendered"] - p["process start"] for _, p, _ in runs if "list rendered" in p and "process start" in p]
    if totals:
        print(f"| total: process start -> list rendered | {len(totals)} | {median(totals):.0f} | {nearest_rank(totals, 0.9):.0f} |")


def within(marks, name, start, end):
    for m in marks:
        if m["name"] == name and start <= m["wall"] < end:
            return m
    return None


def warm(directory):
    """One row per return to the foreground, bounded by the next return."""
    rows = []
    for path in sorted(pathlib.Path(directory).glob("*.jsonl")):
        marks = load(path)
        returns = [m for m in marks if m["name"] == "13.foreground"]
        for i, m in enumerate(returns):
            end = returns[i + 1]["wall"] if i + 1 < len(returns) else float("inf")
            rows.append({
                "lost": bool(m.get("lost")),
                "ok": within(marks, "13.resume-probe.ok", m["wall"], end),
                "failed": within(marks, "13.resume-probe.failed", m["wall"], end),
                "connected": within(marks, "14.connected", m["wall"], end),
            })
    kept = [r for r in rows if not r["lost"]]
    probe = [r["ok"]["rttMs"] for r in kept if r["ok"]]
    print(f"returns: {len(rows)}; connection lost in background: {len(rows) - len(kept)}; kept: {len(kept)}; probe answered: {len(probe)}; probe failed: {sum(1 for r in kept if r['failed'])}")
    if probe:
        print(f"kept connection, resume probe round trip ms: median {median(probe):.0f}, p90 {nearest_rank(probe, 0.9):.0f}, n {len(probe)}")
    marks_by_row = []
    reconnect = []
    for path in sorted(pathlib.Path(directory).glob("*.jsonl")):
        marks = load(path)
        returns = [m for m in marks if m["name"] == "13.foreground"]
        for i, m in enumerate(returns):
            end = returns[i + 1]["wall"] if i + 1 < len(returns) else float("inf")
            c = within(marks, "14.connected", m["wall"], end)
            if (m.get("lost") or within(marks, "13.resume-probe.failed", m["wall"], end)) and c:
                reconnect.append(c["wall"] - m["wall"])
    if reconnect:
        print(f"lost connection, foreground -> reconnected ms: median {median(reconnect):.0f}, p90 {nearest_rank(reconnect, 0.9):.0f}, n {len(reconnect)}")


def keepalive(directory):
    for path in sorted(pathlib.Path(directory).glob("*.jsonl")):
        marks = load(path)
        head = marks[0]
        sent = [m for m in marks if m["name"] == "14.keepalive.sent"]
        ok = [m["rttMs"] for m in marks if m["name"] == "14.keepalive.ok"]
        failed = [m for m in marks if m["name"] == "14.keepalive.failed"]
        lost = [m for m in marks if m["name"] == "conn.lost"]
        span = (marks[-1]["wall"] - marks[0]["wall"]) / 60000
        print(f"{path.name}: keepAliveMs {head.get('keepAliveMs')}, span {span:.1f} min, sent {len(sent)}, answered {len(ok)}, failed {len(failed)}, connection lost {len(lost)}")
        if ok:
            print(f"  round trip ms: median {median(ok):.0f}, p90 {nearest_rank(ok, 0.9):.0f}")
        for m in lost:
            print(f"  lost after {m['connectedForMs'] / 1000:.0f} s connected, path {m['path']}: {m['cause']}")


if __name__ == "__main__":
    {"cold": cold, "warm": warm, "keepalive": keepalive}[sys.argv[1]](sys.argv[2])
