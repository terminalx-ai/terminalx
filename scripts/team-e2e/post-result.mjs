import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { finalizeRun } from "./results.mjs";

export async function postResult(report, sink, { directory } = {}) {
  if (!sink?.append) throw new Error("Result sink is required");
  if (report.suite !== "two-account" || !/^team-[a-f0-9-]{36}$/.test(report.runId) || !["passed", "failed", "incomplete"].includes(report.status)) throw new Error("Invalid two-account result");
  if (report.status === "passed") {
    if (report.mode !== "real" || report.certification?.state !== "verified" || !directory) throw new Error("Uncertified or synthetic results cannot be posted as a real pass");
    const checked = await finalizeRun(report, directory);
    if (checked.status !== "passed") throw new Error("Execution evidence no longer passes");
  }
  const rows = report.scenarios.map((row) => `| ${row.scenario.replace(/[^a-z-]/g, "")} | ${row.status.replace(/[^a-z-]/g, "")} |`).join("\n");
  await sink.append(`### Two-account E2E: ${report.status}\n\nRun: \`${report.runId}\`\n\n| Scenario | Outcome |\n| --- | --- |\n${rows}\n\n${report.failed} failed assertions/prerequisites. Screenshots and logs are in the run artifact.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [reportPath, sinkPath] = process.argv.slice(2);
  if (!reportPath || !sinkPath) throw new Error("Usage: node post-result.mjs RESULT.json LOCAL_SUMMARY_PATH");
  await postResult(JSON.parse(await readFile(reportPath, "utf8")), { append: (text) => appendFile(sinkPath, text, { mode: 0o600 }) }, { directory: dirname(resolve(reportPath)) });
}
