import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRun, retainRuns, saveJson } from "./artifacts.mjs";
import { inventory, preflight } from "./capabilities.mjs";
import { command } from "./process.mjs";
import { evaluateRun, exitCode } from "./results.mjs";

export async function run(args) {
  const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const known = new Set(["--config", "--artifacts", "--preflight"]);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`Unknown argument ${args[i]}`);
    if (args[i] !== "--preflight" && (!args[++i] || args[i].startsWith("--"))) throw new Error("Missing argument value");
  }
  const config = value("--config") ? JSON.parse(await readFile(value("--config"), "utf8")) : {};
  const root = resolve(value("--artifacts") ?? "artifacts/team-e2e");
  const { runId, directory } = await createRun(root);
  const startedAt = new Date().toISOString();
  const prerequisites = preflight(config);
  let desktopHead = null;
  try {
    const result = await command("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../..", import.meta.url)) });
    if (result.code === 0) desktopHead = result.stdout.trim();
  } catch { prerequisites.push("Could not record desktop source head."); }
  const report = {
    ...evaluateRun({ runId, prerequisites, cleanup: [{ name: "preflight-created-no-app-server-or-provider-resources", ok: true }] }),
    startedAt, finishedAt: new Date().toISOString(), desktopHead, inventory,
    execution: { started: false, reason: "Prerequisites incomplete; no real scenario or deliberate break executed.", activePids: [] },
    nightly: { activated: false, postingVerified: false },
  };
  await saveJson(directory, "result.json", report);
  await retainRuns(root);
  process.stdout.write(`${report.status}: ${directory}/result.json\n`);
  return { report, directory, code: exitCode(report) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(({ code }) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`two-account harness: ${error.message}\n`);
    process.exitCode = 1;
  });
}
