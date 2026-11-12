// `report` subcommand of the orchestration benchmark (PRO-283,
// docs/ORCHESTRATION-BENCH.md): reads result records and writes a Markdown
// report with, for each task shape and arrangement, the runs, the pass rate
// with its 95% Wilson interval, the mean cost per run and the cost per pass,
// a score-against-spend plot as an SVG beside it, and one verdict per shape.
//
//   node scripts/orchestration-bench/cli.mjs report --in <results.jsonl>... [--out report.md]
//
// The verdict rule, written down so nobody reads it off the chart by eye:
//
//   1. Only arrangements with at least MIN_RUNS runs in the shape are judged;
//      the others are listed as too few to judge.
//   2. The judged arrangement with the highest pass rate is the best. Equal
//      rates go to the one with more runs, then to the order of ARRANGEMENTS.
//   3. Every judged arrangement whose Wilson interval overlaps the best one's
//      (closed intervals: touching counts) is tied with it.
//   4. The best alone: it wins. Several tied: the score difference is within
//      run-to-run noise, and the cheapest of the tied ones, by mean cost per
//      run, is named with that cost.
//
// A record whose costUsd is null is a run with unknown cost. It counts as a
// run and as a pass or a failure, never as a cost of zero.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { ARRANGEMENTS, SHAPES, validateResult } from "./schema.mjs";

/** Fewest runs in a shape and arrangement before the pass rate is judged. */
export const MIN_RUNS = 3;
/** z for a two-sided 95% interval. */
export const Z95 = 1.959964;

export const HELP = `Usage: node scripts/orchestration-bench/cli.mjs report --in <results.jsonl>... [--out report.md]

Reads result records (one JSON line per run, docs/ORCHESTRATION-BENCH.md) and
writes a Markdown report: for each task shape and arrangement the runs, the
pass rate with its 95% Wilson interval, the mean cost per run and the cost per
pass, a score-against-spend plot as an SVG beside the report, and one verdict
line per shape.

Options:
  --in <file>...  Results file; repeat it or list several files. At least one.
  --out <file>    Markdown report to write (default: report.md in the current
                  folder). The plot is written beside it with the same name and
                  an .svg extension.
  --help          Show this help.

Verdict rule per shape: the arrangement with the highest pass rate is the
best; every arrangement whose Wilson interval overlaps the best one's is tied
with it. One arrangement alone wins. Several tied: the score difference is
within run-to-run noise, and the cheapest of the tied ones is named with its
mean cost. Arrangements with fewer than ${MIN_RUNS} runs in a shape are listed as too few
to judge and take no part in the verdict. A record whose costUsd is null is a
run with unknown cost, never a cost of zero. The command refuses to write a
report from zero records, and from any line that is not a valid record.
`;

/**
 * The 95% Wilson score interval for `passes` of `runs`. Returns { low, high },
 * both between 0 and 1, or null when there are no runs.
 */
export function wilsonInterval(passes, runs, z = Z95) {
  if (!(runs > 0)) return null;
  const p = passes / runs;
  const z2 = z * z;
  const denominator = 1 + z2 / runs;
  const centre = (p + z2 / (2 * runs)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / runs + z2 / (4 * runs * runs))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** True when two closed intervals share a point. */
export function intervalsOverlap(a, b) {
  return a.low <= b.high && b.low <= a.high;
}

/** One cell of the report: every record of one shape under one arrangement. */
export function summarizeCell(records) {
  const runs = records.length;
  const passes = records.filter((record) => record.passed).length;
  const known = records.filter((record) => typeof record.costUsd === "number");
  const knownCost = known.reduce((sum, record) => sum + record.costUsd, 0);
  const knownPasses = known.filter((record) => record.passed).length;
  return {
    runs,
    passes,
    passRate: runs ? passes / runs : null,
    interval: wilsonInterval(passes, runs),
    tasks: new Set(records.map((record) => record.taskId)).size,
    unknownCost: runs - known.length,
    // Over the runs whose cost is known only.
    meanCost: known.length ? knownCost / known.length : null,
    costPerPass: knownPasses ? knownCost / knownPasses : null,
  };
}

/**
 * Groups records by shape, then arrangement, and gives the verdict per shape.
 * Shapes and arrangements come out in the order of SHAPES and ARRANGEMENTS;
 * only those with at least one record appear.
 */
export function analyze(records) {
  return SHAPES.filter((shape) => records.some((record) => record.shape === shape)).map((shape) => {
    const cells = ARRANGEMENTS.filter((arrangement) => records.some((record) => record.shape === shape && record.arrangement === arrangement)).map((arrangement) => ({
      arrangement,
      ...summarizeCell(records.filter((record) => record.shape === shape && record.arrangement === arrangement)),
    }));
    return { shape, cells, verdict: verdictFor(cells) };
  });
}

/** The verdict for one shape's cells, by the rule at the top of this file. */
export function verdictFor(cells) {
  const tooFew = cells.filter((cell) => cell.runs < MIN_RUNS).map((cell) => cell.arrangement);
  const judged = cells.filter((cell) => cell.runs >= MIN_RUNS);
  if (!judged.length) return { kind: "none", tooFew, best: null, tied: [], cheapest: null };
  const order = (cell) => ARRANGEMENTS.indexOf(cell.arrangement);
  const best = [...judged].sort((a, b) => b.passRate - a.passRate || b.runs - a.runs || order(a) - order(b))[0];
  const tied = judged.filter((cell) => cell === best || intervalsOverlap(cell.interval, best.interval)).sort((a, b) => order(a) - order(b));
  if (tied.length === 1) return { kind: "winner", tooFew, best, tied, cheapest: null };
  const priced = tied.filter((cell) => cell.meanCost !== null);
  const cheapest = priced.length ? priced.reduce((low, cell) => (cell.meanCost < low.meanCost ? cell : low)) : null;
  return { kind: "tie", tooFew, best, tied, cheapest };
}

const percent = (value) => `${(value * 100).toFixed(0)}%`;
const dollars = (value) => (value === null ? "n/a" : `$${value.toFixed(value < 0.1 ? 4 : 2)}`);
const interval = (cell) => `${percent(cell.interval.low)}–${percent(cell.interval.high)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The one-line verdict for a shape. */
export function verdictLine(shapeAnalysis) {
  const { shape, verdict } = shapeAnalysis;
  const tooFew = verdict.tooFew.length ? ` Too few to judge (fewer than ${MIN_RUNS} runs): ${verdict.tooFew.join(", ")}.` : "";
  if (verdict.kind === "none") {
    return `**${shape}**: no verdict, no arrangement has ${MIN_RUNS} runs yet.${tooFew}`;
  }
  const { best } = verdict;
  if (verdict.kind === "winner") {
    return `**${shape}**: ${best.arrangement} wins, ${percent(best.passRate)} passed (${best.passes}/${best.runs}), interval ${interval(best)}; no other arrangement's interval overlaps it.${tooFew}`;
  }
  const names = verdict.tied.map((cell) => cell.arrangement).join(", ");
  const cheapest = verdict.cheapest
    ? `Cheapest of them: ${verdict.cheapest.arrangement} at ${dollars(verdict.cheapest.meanCost)} mean per run.`
    : "Cost is unknown for all of them, so no cheapest can be named.";
  return `**${shape}**: the score difference is within run-to-run noise between ${names}. ${cheapest}${tooFew}`;
}

const cellRow = (cell) => {
  const cost = cell.meanCost === null ? "n/a" : `${dollars(cell.meanCost)}${cell.unknownCost ? ` (${cell.unknownCost} unknown)` : ""}`;
  const perPass = cell.costPerPass === null ? "n/a" : dollars(cell.costPerPass);
  const flag = cell.runs < MIN_RUNS ? " (too few)" : "";
  return `| ${cell.arrangement} | ${cell.runs}${flag} | ${cell.tasks} | ${cell.passes} | ${percent(cell.passRate)} | ${interval(cell)} | ${cost} | ${perPass} |`;
};

/** The Markdown report. `plotFile` is the SVG's file name beside the report. */
export function renderMarkdown(analysis, { sources, plotFile, runCount }) {
  const lines = ["# Orchestration benchmark report", ""];
  lines.push(`${plural(runCount, "run")} from ${plural(sources.length, "results file")}: ${sources.map((source) => `\`${source}\``).join(", ")}.`, "");
  lines.push("## Verdict per task shape", "");
  for (const shape of analysis) lines.push(`- ${verdictLine(shape)}`);
  lines.push("", "## Score against spend", "", `![Pass rate against mean cost per run, by arrangement and shape](${plotFile})`, "");
  const unplotted = analysis.flatMap((shape) => shape.cells.filter((cell) => cell.meanCost === null).map((cell) => `${shape.shape} / ${cell.arrangement}`));
  if (unplotted.length) lines.push(`Not plotted, cost unknown for every run: ${unplotted.join(", ")}.`, "");
  lines.push("## Results by shape and arrangement", "");
  for (const shape of analysis) {
    lines.push(`### ${shape.shape}`, "");
    lines.push("| Arrangement | Runs | Tasks | Passed | Pass rate | 95% Wilson interval | Mean cost per run | Cost per pass |");
    lines.push("| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |");
    for (const cell of shape.cells) lines.push(cellRow(cell));
    lines.push("");
  }
  lines.push(
    "## How to read this",
    "",
    "- The pass rate is passed runs over runs. The interval is the 95% Wilson score interval for it.",
    `- Verdict rule: the arrangement with the highest pass rate is the best; every arrangement whose interval overlaps the best one's is tied with it. One alone wins. Several tied: the score difference is within run-to-run noise, and the cheapest of the tied ones is named. Arrangements with fewer than ${MIN_RUNS} runs in a shape take no part.`,
    "- Mean cost per run and cost per pass use only runs with a known cost; a run whose cost is null is counted as unknown, never as $0. Cost per pass is the known cost spent divided by the passes among those runs.",
    "",
  );
  return lines.join("\n");
}

const COLORS = { "top-single": "#6d28d9", "large-single": "#0f766e", "lead-mid-workers": "#c2410c", "lead-low-escalate": "#1d4ed8" };
const escapeXml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function marker(shapeIndex, x, y, color) {
  const r = 6;
  if (shapeIndex === 0) return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${color}"/>`;
  if (shapeIndex === 1) return `<rect x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${2 * r}" height="${2 * r}" fill="${color}"/>`;
  return `<polygon points="${x.toFixed(1)},${(y - r - 1).toFixed(1)} ${(x + r + 1).toFixed(1)},${(y + r).toFixed(1)} ${(x - r - 1).toFixed(1)},${(y + r).toFixed(1)}" fill="${color}"/>`;
}

/**
 * The score-against-spend plot as SVG: x is mean cost per run, y is pass rate
 * with its Wilson interval as a vertical bar. Colour is the arrangement and
 * the marker is the shape. Cells with no known cost cannot be placed and are
 * left out (the report says which).
 */
export function renderSvg(analysis) {
  const width = 760;
  const height = 480;
  const plot = { left: 64, right: 24, top: 48, bottom: 136 };
  const innerW = width - plot.left - plot.right;
  const innerH = height - plot.top - plot.bottom;
  const points = analysis.flatMap((shape) => shape.cells.filter((cell) => cell.meanCost !== null).map((cell) => ({ shape: shape.shape, ...cell })));
  const maxCost = Math.max(...points.map((point) => point.meanCost), 0);
  const xMax = maxCost > 0 ? maxCost * 1.1 : 1;
  const x = (cost) => plot.left + (cost / xMax) * innerW;
  const y = (rate) => plot.top + (1 - rate) * innerH;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" font-family="system-ui, -apple-system, Segoe UI, sans-serif">`);
  out.push(`<title>Pass rate against mean cost per run, by arrangement and task shape</title>`);
  out.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  out.push(`<text x="${plot.left}" y="26" font-size="15" font-weight="600" fill="#111827">Pass rate against mean cost per run</text>`);
  for (let tick = 0; tick <= 4; tick += 1) {
    const rate = tick / 4;
    out.push(`<line x1="${plot.left}" y1="${y(rate).toFixed(1)}" x2="${width - plot.right}" y2="${y(rate).toFixed(1)}" stroke="#e5e7eb"/>`);
    out.push(`<text x="${plot.left - 8}" y="${(y(rate) + 4).toFixed(1)}" font-size="12" text-anchor="end" fill="#374151">${percent(rate)}</text>`);
  }
  for (let tick = 0; tick <= 4; tick += 1) {
    const cost = (xMax * tick) / 4;
    out.push(`<line x1="${x(cost).toFixed(1)}" y1="${plot.top}" x2="${x(cost).toFixed(1)}" y2="${plot.top + innerH}" stroke="#f3f4f6"/>`);
    out.push(`<text x="${x(cost).toFixed(1)}" y="${plot.top + innerH + 18}" font-size="12" text-anchor="middle" fill="#374151">${escapeXml(dollars(cost))}</text>`);
  }
  out.push(`<text x="${plot.left + innerW / 2}" y="${plot.top + innerH + 38}" font-size="12" text-anchor="middle" fill="#374151">Mean cost per run (runs with known cost)</text>`);
  out.push(`<text transform="translate(16 ${plot.top + innerH / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="#374151">Pass rate, 95% Wilson interval</text>`);
  out.push(`<rect x="${plot.left}" y="${plot.top}" width="${innerW}" height="${innerH}" fill="none" stroke="#9ca3af"/>`);
  if (!points.length) {
    out.push(`<text x="${plot.left + innerW / 2}" y="${plot.top + innerH / 2}" font-size="13" text-anchor="middle" fill="#374151">No cell has a known cost, so nothing can be placed.</text>`);
  }
  for (const point of points) {
    const color = COLORS[point.arrangement];
    const px = x(point.meanCost);
    const label = `${point.shape} / ${point.arrangement}: ${point.passes}/${point.runs} passed (${interval(point)}), mean cost ${dollars(point.meanCost)}`;
    out.push(`<g opacity="${point.runs < MIN_RUNS ? 0.45 : 1}"><title>${escapeXml(label)}</title>`);
    out.push(`<line x1="${px.toFixed(1)}" y1="${y(point.interval.low).toFixed(1)}" x2="${px.toFixed(1)}" y2="${y(point.interval.high).toFixed(1)}" stroke="${color}" stroke-width="2"/>`);
    out.push(`<line x1="${(px - 4).toFixed(1)}" y1="${y(point.interval.low).toFixed(1)}" x2="${(px + 4).toFixed(1)}" y2="${y(point.interval.low).toFixed(1)}" stroke="${color}" stroke-width="2"/>`);
    out.push(`<line x1="${(px - 4).toFixed(1)}" y1="${y(point.interval.high).toFixed(1)}" x2="${(px + 4).toFixed(1)}" y2="${y(point.interval.high).toFixed(1)}" stroke="${color}" stroke-width="2"/>`);
    out.push(marker(SHAPES.indexOf(point.shape), px, y(point.passRate), color));
    out.push(`</g>`);
  }
  // Legend: colour is the arrangement, marker is the shape.
  const legendTop = plot.top + innerH + 58;
  ARRANGEMENTS.forEach((arrangement, index) => {
    const lx = plot.left + (index % 2) * 300;
    const ly = legendTop + Math.floor(index / 2) * 22;
    out.push(`<rect x="${lx}" y="${ly - 10}" width="14" height="14" fill="${COLORS[arrangement]}"/>`);
    out.push(`<text x="${lx + 22}" y="${ly + 2}" font-size="12" fill="#111827">${escapeXml(arrangement)}</text>`);
  });
  SHAPES.forEach((shape, index) => {
    const lx = plot.left + index * 140;
    const ly = legendTop + 56;
    out.push(marker(index, lx + 7, ly - 3, "#374151"));
    out.push(`<text x="${lx + 22}" y="${ly + 2}" font-size="12" fill="#111827">${escapeXml(shape)}</text>`);
  });
  out.push(`<text x="${plot.left + 3 * 140 + 10}" y="${legendTop + 58}" font-size="11" fill="#6b7280">faded = fewer than ${MIN_RUNS} runs</text>`);
  out.push(`</svg>`);
  return `${out.join("\n")}\n`;
}

/**
 * Records from results files' text. Lines are checked against schema.mjs, with
 * one exception: costUsd may be null (unknown cost), which validateResult does
 * not allow, so a null is checked as 0 and kept as null.
 */
export function readResults(text, name) {
  const records = [];
  const problems = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      problems.push(`${name} line ${index + 1}: not JSON (${error.message})`);
      return;
    }
    const checked = record && typeof record === "object" && record.costUsd === null ? { ...record, costUsd: 0 } : record;
    const why = validateResult(checked);
    if (why.length) problems.push(`${name} line ${index + 1}: ${why.join("; ")}`);
    else records.push(record);
  });
  return { records, problems };
}

function parseArgs(argv) {
  const options = { inputs: [], out: null, help: false };
  const value = (i, name, what) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`${name} needs ${what}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--in") {
      value(i, "--in", "a results file");
      // Every argument up to the next option is a results file.
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) options.inputs.push(argv[(i += 1)]);
    } else if (arg === "--out") {
      options.out = value(i, "--out", "a file name");
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else throw new Error(`unexpected argument ${arg}; results files go after --in`);
  }
  return options;
}

export async function main(argv, io) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`report: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (!options.inputs.length) {
    io.stderr.write(`report: no results file; give at least one with --in\n\n${HELP}`);
    return 2;
  }
  const records = [];
  const problems = [];
  for (const input of options.inputs) {
    let text;
    try {
      text = readFileSync(resolve(io.cwd, input), "utf8");
    } catch (error) {
      problems.push(`${input}: cannot read (${error.code ?? error.message})`);
      continue;
    }
    const parsed = readResults(text, input);
    records.push(...parsed.records);
    problems.push(...parsed.problems);
  }
  if (problems.length) {
    io.stderr.write(`report: refusing to write a report; ${plural(problems.length, "problem")} in the results:\n${problems.map((problem) => `  ${problem}`).join("\n")}\n`);
    return 1;
  }
  if (!records.length) {
    io.stderr.write(`report: refusing to write a report from zero records in ${options.inputs.join(", ")}\n`);
    return 1;
  }
  const outPath = resolve(io.cwd, options.out ?? "report.md");
  const plotPath = join(dirname(outPath), `${basename(outPath, extname(outPath))}.svg`);
  const analysis = analyze(records);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(plotPath, renderSvg(analysis));
  writeFileSync(outPath, renderMarkdown(analysis, { sources: options.inputs, plotFile: basename(plotPath), runCount: records.length }));
  io.stdout.write(`${analysis.map(verdictLine).join("\n")}\n\nWrote ${outPath} and ${plotPath} from ${plural(records.length, "run")}.\n`);
  return 0;
}
