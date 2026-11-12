// Loads the benchmark's task files (docs/ORCHESTRATION-BENCH.md).
//
// Tasks live at bench/orchestration/tasks/<shape>/<id>.json. The loader reads
// every one, validates it against schema.mjs, and checks what a single file
// cannot: the folder matches the shape, the file name matches the id, no id
// is used twice, and a patch solution exists next to its task.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SHAPES, solutionIsCommit, validateTask } from "./schema.mjs";

/** Where tasks live, relative to the repository root. */
export const TASKS_DIR = "bench/orchestration/tasks";

/**
 * Every task under `tasksDir`, and every problem found.
 *
 * Returns `{ tasks, problems }`. Each task is the parsed file plus `file` (its
 * absolute path) and, for a patch solution, `solutionPatch` (the patch's
 * absolute path). A file with problems is left out of `tasks`. With `shape`,
 * only that shape's tasks are returned, but every file is still read, so an id
 * used twice across shapes is still caught.
 */
export function loadTasks(tasksDir, { shape } = {}) {
  const root = resolve(tasksDir);
  const tasks = [];
  const problems = [];
  if (shape !== undefined && !SHAPES.includes(shape)) {
    return { tasks, problems: [`unknown shape ${shape}; one of ${SHAPES.join(", ")}`] };
  }
  if (!existsSync(root)) return { tasks, problems };

  const seen = new Map();
  for (const entry of readdirSync(root).sort()) {
    const folder = join(root, entry);
    if (!statSync(folder).isDirectory()) {
      if (entry !== "README.md" && !entry.startsWith(".")) problems.push(`${entry}: tasks go in a shape folder (${SHAPES.join(", ")}), not at the top`);
      continue;
    }
    if (!SHAPES.includes(entry)) {
      problems.push(`${entry}/: not a shape; folders are ${SHAPES.join(", ")}`);
      continue;
    }
    for (const name of readdirSync(folder).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = join(folder, name);
      const where = relative(root, file);
      let task;
      try {
        task = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        problems.push(`${where}: not JSON (${error.message})`);
        continue;
      }
      const own = validateTask(task).map((problem) => `${where}: ${problem}`);
      if (task && typeof task === "object") {
        if (typeof task.id === "string" && name !== `${task.id}.json`) own.push(`${where}: file name must be ${task.id}.json, the task's id`);
        if (typeof task.shape === "string" && task.shape !== entry) own.push(`${where}: shape is ${task.shape} but the file is in ${entry}/`);
        if (typeof task.id === "string") {
          if (seen.has(task.id)) own.push(`${where}: id ${task.id} is already used by ${seen.get(task.id)}`);
          else seen.set(task.id, where);
        }
      }
      let solutionPatch;
      if (!own.length && !solutionIsCommit(task.solution)) {
        solutionPatch = join(dirname(file), task.solution);
        if (!existsSync(solutionPatch)) own.push(`${where}: solution patch ${task.solution} does not exist next to the task`);
      }
      if (own.length) {
        problems.push(...own);
        continue;
      }
      if (shape === undefined || task.shape === shape) tasks.push({ ...task, file, ...(solutionPatch ? { solutionPatch } : {}) });
    }
  }
  return { tasks, problems };
}
