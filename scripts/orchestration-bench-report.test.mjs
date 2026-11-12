// @vitest-environment node
// The orchestration benchmark's `report` subcommand (docs/ORCHESTRATION-BENCH.md):
// the Wilson interval, the verdict rule, null costs, and the files it writes.
//
// Every table of records below is TEST INPUT, built to give answers checkable
// by hand. It is not a result and is written nowhere outside this test's
// temporary folder.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "./orchestration-bench/cli.mjs";
import { analyze, intervalsOverlap, main as report, readResults, renderSvg, summarizeCell, verdictFor, verdictLine, wilsonInterval } from "./orchestration-bench/report.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "orchestration-bench/cli.mjs");

const scratch = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "orchestration-bench-report-test-"));
  scratch.push(dir);
  return dir;
};

// TEST INPUT: `rows` is [shape, arrangement, passed, costUsd] per run.
let counter = 0;
const record = (shape, arrangement, passed, costUsd) => ({
  taskId: `task-${counter++ % 7}`,
  shape,
  arrangement,
  passed,
  costUsd,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  wallSeconds: 1,
  attempts: 1,
  sessionIds: ["s"],
  startedAt: "2026-11-12T09:30:00Z",
});
const runs = (shape, arrangement, passed, total, cost) => Array.from({ length: total }, (_, i) => record(shape, arrangement, i < passed, cost));
const lines = (records) => records.map((r) => JSON.stringify(r)).join("\n");

function io(cwd) {
  const out = [];
  const err = [];
  return { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) }, cwd, env: {}, out, err };
}

describe("wilsonInterval", () => {
  it("matches the closed forms at the edges", () => {
    // 0 of 3: low 0, high z²/(n+z²) = 3.8416/6.8416.
    const none = wilsonInterval(0, 3);
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(0.5615, 3);
    // 3 of 3 is the mirror image.
    const all = wilsonInterval(3, 3);
    expect(all.high).toBe(1);
    expect(all.low).toBeCloseTo(0.4385, 3);
  });

  it("gives the textbook interval for 5 of 10", () => {
    const half = wilsonInterval(5, 10);
    expect(half.low).toBeCloseTo(0.2366, 3);
    expect(half.high).toBeCloseTo(0.7634, 3);
  });

  it("is null with no runs", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it("treats touching intervals as overlapping", () => {
    expect(intervalsOverlap({ low: 0, high: 0.5 }, { low: 0.5, high: 1 })).toBe(true);
    expect(intervalsOverlap({ low: 0, high: 0.4 }, { low: 0.5, high: 1 })).toBe(false);
  });
});

describe("summarizeCell", () => {
  it("never counts a null cost as zero", () => {
    // TEST INPUT: costs 2, 4, unknown; passes true, false, true.
    const cell = summarizeCell([record("feature", "top-single", true, 2), record("feature", "top-single", false, 4), record("feature", "top-single", true, null)]);
    expect(cell.runs).toBe(3);
    expect(cell.passes).toBe(2);
    expect(cell.unknownCost).toBe(1);
    expect(cell.meanCost).toBe(3); // (2 + 4) / 2, not / 3
    expect(cell.costPerPass).toBe(6); // 6 dollars over the one pass with a known cost
  });

  it("has no mean and no cost per pass when every cost is unknown, and no cost per pass without a pass", () => {
    const unknown = summarizeCell(runs("feature", "top-single", 2, 3, null));
    expect(unknown.meanCost).toBeNull();
    expect(unknown.costPerPass).toBeNull();
    const noPass = summarizeCell(runs("feature", "top-single", 0, 3, 1));
    expect(noPass.meanCost).toBe(1);
    expect(noPass.costPerPass).toBeNull();
  });
});

describe("verdict rule", () => {
  const cells = (spec) => analyze(spec.flatMap(([arrangement, passed, total, cost]) => runs("feature", arrangement, passed, total, cost)))[0].cells;

  it("names one arrangement when no other interval overlaps the best", () => {
    // 10/10 has low 0.7225; 0/10 has high 0.2775.
    const verdict = verdictFor(cells([["top-single", 10, 10, 5], ["large-single", 0, 10, 1]]));
    expect(verdict.kind).toBe("winner");
    expect(verdict.best.arrangement).toBe("top-single");
  });

  it("calls overlapping intervals noise and names the cheapest of the tied", () => {
    // 3/3 [0.4385, 1] and 2/3 [0.2077, 0.9385] overlap; 0/3 [0, 0.5615] overlaps 3/3 too.
    const verdict = verdictFor(cells([["top-single", 3, 3, 9], ["large-single", 2, 3, 4], ["lead-mid-workers", 3, 3, 6]]));
    expect(verdict.kind).toBe("tie");
    expect(verdict.tied.map((c) => c.arrangement)).toEqual(["top-single", "large-single", "lead-mid-workers"]);
    expect(verdict.cheapest.arrangement).toBe("large-single");
    const line = verdictLine({ shape: "feature", verdict });
    expect(line).toContain("within run-to-run noise");
    expect(line).toContain("large-single at $4.00 mean per run");
  });

  it("leaves out of the tie an arrangement whose interval does not overlap the best", () => {
    // 10/10 vs 5/10 [0.2366, 0.7634] vs 0/10: only the first two... 10/10 low 0.7225 < 0.7634, so 5/10 ties; 0/10 does not.
    const verdict = verdictFor(cells([["top-single", 10, 10, 8], ["large-single", 5, 10, 2], ["lead-mid-workers", 0, 10, 1]]));
    expect(verdict.tied.map((c) => c.arrangement)).toEqual(["top-single", "large-single"]);
    expect(verdict.cheapest.arrangement).toBe("large-single");
  });

  it("lists cells with fewer than three runs as too few and keeps them out of the verdict", () => {
    // 2/2 would have the top rate but has too few runs.
    const verdict = verdictFor(cells([["top-single", 2, 2, 1], ["large-single", 10, 10, 5], ["lead-mid-workers", 0, 10, 1]]));
    expect(verdict.tooFew).toEqual(["top-single"]);
    expect(verdict.kind).toBe("winner");
    expect(verdict.best.arrangement).toBe("large-single");
    expect(verdictLine({ shape: "feature", verdict })).toContain("Too few to judge (fewer than 3 runs): top-single");
  });

  it("makes no verdict when nothing has three runs", () => {
    const verdict = verdictFor(cells([["top-single", 1, 2, 1]]));
    expect(verdict.kind).toBe("none");
    expect(verdictLine({ shape: "feature", verdict })).toContain("no verdict");
  });

  it("says it cannot name a cheapest when every tied cost is unknown", () => {
    const verdict = verdictFor(cells([["top-single", 3, 3, null], ["large-single", 3, 3, null]]));
    expect(verdict.kind).toBe("tie");
    expect(verdict.cheapest).toBeNull();
    expect(verdictLine({ shape: "feature", verdict })).toContain("no cheapest can be named");
  });

  it("breaks an equal pass rate toward more runs, then the arrangement order", () => {
    const verdict = verdictFor(cells([["large-single", 3, 3, 1], ["top-single", 4, 4, 1]]));
    expect(verdict.best.arrangement).toBe("top-single");
  });
});

describe("readResults", () => {
  it("accepts a null cost and reports bad lines by number", () => {
    const text = `${lines([record("feature", "top-single", true, null)])}\n{not json}\n${JSON.stringify({ ...record("feature", "top-single", true, 1), shape: "bogus" })}\n`;
    const { records, problems } = readResults(text, "r.jsonl");
    expect(records).toHaveLength(1);
    expect(records[0].costUsd).toBeNull();
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^r\.jsonl line 2: not JSON/);
    expect(problems[1]).toMatch(/^r\.jsonl line 3: .*shape must be one of/);
  });
});

describe("report command", () => {
  const sample = () => [...runs("feature", "top-single", 3, 3, 9), ...runs("feature", "large-single", 2, 3, 4), ...runs("search", "top-single", 5, 5, 1), ...runs("search", "lead-low-escalate", 0, 5, 0.5)];

  it("writes the Markdown, the SVG beside it and one verdict per shape, reading several files", async () => {
    const dir = tempDir();
    const all = sample();
    writeFileSync(join(dir, "a.jsonl"), lines(all.slice(0, 5)));
    writeFileSync(join(dir, "b.jsonl"), `${lines(all.slice(5))}\n`);
    const ctx = io(dir);
    expect(await report(["--in", "a.jsonl", "b.jsonl", "--out", "out/report.md"], ctx)).toBe(0);
    const md = readFileSync(join(dir, "out/report.md"), "utf8");
    const svg = readFileSync(join(dir, "out/report.svg"), "utf8");
    expect(md).toContain("16 runs from 2 results files");
    expect(md).toContain("![Pass rate against mean cost per run, by arrangement and shape](report.svg)");
    expect(md).toContain("**feature**: the score difference is within run-to-run noise between top-single, large-single. Cheapest of them: large-single at $4.00");
    expect(md).toContain("**search**: top-single wins, 100% passed (5/5)");
    expect(md).toContain("| top-single | 3 | 3 | 3 | 100% | 44%–100% | $9.00 | $9.00 |");
    expect(md).toContain("| large-single | 3 | 3 | 2 | 67% | 21%–94% | $4.00 | $6.00 |");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect(svg).toContain("search / top-single: 5/5 passed");
  });

  it("defaults the report to report.md in the working folder", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "r.jsonl"), lines(sample()));
    expect(await report(["--in", "r.jsonl"], io(dir))).toBe(0);
    expect(existsSync(join(dir, "report.md"))).toBe(true);
    expect(existsSync(join(dir, "report.svg"))).toBe(true);
  });

  it("refuses zero records and writes nothing", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "empty.jsonl"), "\n\n");
    const ctx = io(dir);
    expect(await report(["--in", "empty.jsonl", "--out", "r.md"], ctx)).toBe(1);
    expect(ctx.err.join("")).toContain("zero records");
    expect(existsSync(join(dir, "r.md"))).toBe(false);
    expect(existsSync(join(dir, "r.svg"))).toBe(false);
  });

  it("refuses a results file with an invalid line or a missing file, naming each", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.jsonl"), `${lines(sample().slice(0, 1))}\nnope\n`);
    const ctx = io(dir);
    expect(await report(["--in", "bad.jsonl", "missing.jsonl", "--out", "r.md"], ctx)).toBe(1);
    const message = ctx.err.join("");
    expect(message).toContain("bad.jsonl line 2");
    expect(message).toContain("missing.jsonl: cannot read");
    expect(existsSync(join(dir, "r.md"))).toBe(false);
  });

  it("reports unknown costs and does not plot a cell without any known cost", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "r.jsonl"), lines([...runs("chain", "top-single", 3, 3, null), ...runs("chain", "large-single", 1, 3, 2)]));
    expect(await report(["--in", "r.jsonl", "--out", "r.md"], io(dir))).toBe(0);
    const md = readFileSync(join(dir, "r.md"), "utf8");
    expect(md).toContain("Not plotted, cost unknown for every run: chain / top-single.");
    expect(md).toContain("| top-single | 3 | 3 | 3 | 100% | 44%–100% | n/a | n/a |");
    expect(readFileSync(join(dir, "r.svg"), "utf8")).not.toContain("chain / top-single");
  });

  it("needs --in and rejects unknown options", async () => {
    const a = io(tempDir());
    expect(await report([], a)).toBe(2);
    expect(a.err.join("")).toContain("no results file");
    const b = io(tempDir());
    expect(await report(["--in", "x", "--bogus"], b)).toBe(2);
    expect(b.err.join("")).toContain("unknown option --bogus");
    const c = io(tempDir());
    expect(await report(["--in"], c)).toBe(2);
  });
});

describe("renderSvg", () => {
  it("escapes text and survives a table with no known cost", () => {
    const svg = renderSvg(analyze(runs("feature", "top-single", 1, 3, null)));
    expect(svg).toContain("No cell has a known cost");
    expect(svg.match(/<svg/g)).toHaveLength(1);
  });
});

describe("through the command", () => {
  it("is loaded by cli.mjs and `report --help` exits 0", async () => {
    const ctx = io(tempDir());
    expect(await dispatch(["report", "--help"], ctx)).toBe(0);
    expect(ctx.out.join("")).toContain("--in <file>");
    const run = spawnSync(process.execPath, [CLI, "report", "--help"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Verdict rule per shape");
  });
});
