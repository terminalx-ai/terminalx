import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const OWNER = "terminalx-two-account-v1";
const SECRET_KEY = /token|password|authorization|credential|secret|cookie|verifier|challenge|private.?key/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : redact(item)]));
  if (typeof value === "string") return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/([?&](?:code|token|state|key|secret|password)=)[^&#\s"']*/gi, "$1[redacted]")
    .replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, "$1[redacted]@");
  return value;
}

export async function createRun(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Artifact root must not be a symlink");
  const runId = `team-${randomUUID()}`;
  const directory = join(await realpath(root), runId);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "owner.json"), JSON.stringify({ owner: OWNER, runId, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
  return { runId, directory };
}

export async function saveJson(directory, name, value) {
  if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error("Invalid artifact name");
  await writeFile(join(directory, name), JSON.stringify(redact(value), null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

export async function verifyArtifacts(directory, artifacts) {
  const root = await realpath(directory);
  for (const artifact of artifacts) {
    if (!artifact.path || !["screenshot", "log"].includes(artifact.kind)) throw new Error("Invalid evidence artifact");
    const path = resolve(root, artifact.path);
    const rel = relative(root, await realpath(path));
    if (rel.startsWith("..") || !rel || (await lstat(path)).isSymbolicLink()) throw new Error("Evidence escapes run directory");
    const bytes = await readFile(path);
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw new Error("Evidence size invalid");
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Evidence hash mismatch");
    if (artifact.kind === "screenshot" && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Screenshot must be PNG");
  }
}

/** Retain only our completed run directories; unrelated and active directories are untouched. */
export async function retainRuns(root, { days = 14, count = 30, now = Date.now() } = {}) {
  if (!Number.isInteger(days) || days < 1 || !Number.isInteger(count) || count < 1) throw new Error("Invalid retention bound");
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Artifact root must not be a symlink");
  root = await realpath(root);
  const owned = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^team-[a-f0-9-]{36}$/.test(entry.name)) continue;
    const dir = join(root, entry.name);
    try {
      const marker = JSON.parse(await readFile(join(dir, "owner.json"), "utf8"));
      const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
      if (marker.owner === OWNER && marker.runId === entry.name && result.runId === entry.name && Number.isFinite(marker.createdAt) && result.finishedAt) owned.push({ dir, createdAt: marker.createdAt });
    } catch { /* Unfinished or unrelated directory: retain it. */ }
  }
  owned.sort((a, b) => b.createdAt - a.createdAt);
  const removed = [];
  for (const [index, item] of owned.entries()) {
    if (index >= count || now - item.createdAt > days * 86_400_000) {
      await rm(item.dir, { recursive: true });
      removed.push(item.dir);
    }
  }
  return removed;
}
