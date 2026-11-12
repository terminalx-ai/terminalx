// The orchestration benchmark's formats (PRO-283, docs/ORCHESTRATION-BENCH.md).
//
// Three things every piece of the benchmark agrees on: a task file, a result
// record, and the names of the arrangements being compared. Each validator
// returns a list of problems, empty when the value is good, so a loader can
// report every mistake in a file at once instead of the first.

/** The kinds of task. A task file lives in a folder named after its shape. */
export const SHAPES = ["search", "feature", "chain"];

/** The ways of running a task that the benchmark compares. */
export const ARRANGEMENTS = ["top-single", "large-single", "lead-mid-workers", "lead-low-escalate"];

/** The longest a single check may run. A check that needs longer is too big for the benchmark. */
export const MAX_CHECK_SECONDS = 2 * 60 * 60;

const TASK_KEYS = ["id", "shape", "title", "prompt", "startCommit", "solution", "check", "source", "notes"];
const CHECK_KEYS = ["run", "timeoutSeconds", "files", "install"];
const SOURCE_KEYS = ["commit", "pr"];
const RESULT_KEYS = ["taskId", "shape", "arrangement", "passed", "costUsd", "tokens", "wallSeconds", "attempts", "sessionIds", "startedAt", "error"];
const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{7,40}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Text in a task is published with the repository: no one's home folder in it.
const HOME_PATH = /(\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;

function unknownKeys(value, allowed, where) {
  return Object.keys(value).filter((key) => !allowed.includes(key)).map((key) => `${where}${key} is not a field of this format`);
}

/**
 * A path inside the repository, written the portable way: relative, forward
 * slashes, no `..`, no leading `./`. `null` when it is one, else why not.
 */
export function relativePathProblem(path) {
  if (!isText(path)) return "must be a non-empty path";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "must be relative, not absolute";
  if (path.includes("\\")) return "must use forward slashes";
  const parts = path.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) return "must not contain '..', '.' or empty segments";
  return null;
}

/** Whether a task's `solution` names a commit (else it names a patch file). */
export const solutionIsCommit = (solution) => FULL_SHA.test(solution);

/** Every problem with a parsed task file; empty when it is a valid task. */
export function validateTask(task) {
  if (!isObject(task)) return ["a task must be a JSON object"];
  const problems = unknownKeys(task, TASK_KEYS, "");
  if (typeof task.id !== "string" || !ID.test(task.id)) problems.push("id must be lowercase letters, digits and dashes, 1 to 80 long, starting with a letter or digit");
  if (!SHAPES.includes(task.shape)) problems.push(`shape must be one of ${SHAPES.join(", ")}`);
  if (!isText(task.title)) problems.push("title must be a non-empty string");
  if (!isText(task.prompt)) problems.push("prompt must be a non-empty string");
  if (typeof task.startCommit !== "string" || !FULL_SHA.test(task.startCommit)) problems.push("startCommit must be a full 40-character commit sha");
  if (typeof task.solution !== "string") problems.push("solution must be a full commit sha or a patch file path next to the task");
  else if (!solutionIsCommit(task.solution)) {
    const why = relativePathProblem(task.solution);
    if (why) problems.push(`solution is neither a full commit sha nor a patch path: it ${why}`);
    else if (!/\.(patch|diff)$/.test(task.solution)) problems.push("solution patch file must end in .patch or .diff");
  } else if (task.solution === task.startCommit) problems.push("solution must differ from startCommit");
  if (task.notes !== undefined && typeof task.notes !== "string") problems.push("notes, when given, must be a string");

  if (!isObject(task.check)) problems.push("check must be an object with run, timeoutSeconds and files");
  else {
    const check = task.check;
    problems.push(...unknownKeys(check, CHECK_KEYS, "check."));
    if (!isText(check.run)) problems.push("check.run must be a non-empty shell command");
    if (!Number.isInteger(check.timeoutSeconds) || check.timeoutSeconds < 1 || check.timeoutSeconds > MAX_CHECK_SECONDS) {
      problems.push(`check.timeoutSeconds must be a whole number from 1 to ${MAX_CHECK_SECONDS}`);
    }
    if (!Array.isArray(check.files)) problems.push("check.files must be a list of paths (it may be empty)");
    else {
      check.files.forEach((file, index) => {
        const why = relativePathProblem(file);
        if (why) problems.push(`check.files[${index}] ${why}`);
      });
      if (new Set(check.files).size !== check.files.length) problems.push("check.files lists a path twice");
    }
    if (check.install !== undefined && typeof check.install !== "boolean") problems.push("check.install, when given, must be true or false");
  }

  if (!isObject(task.source)) problems.push("source must be an object with commit, pr or both");
  else {
    problems.push(...unknownKeys(task.source, SOURCE_KEYS, "source."));
    const { commit, pr } = task.source;
    if (commit === undefined && pr === undefined) problems.push("source must name the commit, the PR or both");
    if (commit !== undefined && (typeof commit !== "string" || !SHORT_SHA.test(commit))) problems.push("source.commit must be a commit sha (7 to 40 hex characters)");
    if (pr !== undefined && (!Number.isInteger(pr) || pr < 1)) problems.push("source.pr must be a pull request number");
  }

  for (const field of ["title", "prompt", "notes"]) {
    if (typeof task[field] === "string" && HOME_PATH.test(task[field])) problems.push(`${field} contains a home folder path; tasks are public`);
  }
  if (isObject(task.check) && typeof task.check.run === "string" && HOME_PATH.test(task.check.run)) problems.push("check.run contains a home folder path; tasks are public");
  return problems;
}

/** Every problem with one result record; empty when it is valid. */
export function validateResult(record) {
  if (!isObject(record)) return ["a result must be a JSON object"];
  const problems = unknownKeys(record, RESULT_KEYS, "");
  if (typeof record.taskId !== "string" || !ID.test(record.taskId)) problems.push("taskId must be a task id");
  if (!SHAPES.includes(record.shape)) problems.push(`shape must be one of ${SHAPES.join(", ")}`);
  if (!ARRANGEMENTS.includes(record.arrangement)) problems.push(`arrangement must be one of ${ARRANGEMENTS.join(", ")}`);
  if (typeof record.passed !== "boolean") problems.push("passed must be true or false");
  if (typeof record.costUsd !== "number" || !Number.isFinite(record.costUsd) || record.costUsd < 0) problems.push("costUsd must be a number of dollars, 0 or more");
  if (!isObject(record.tokens)) problems.push(`tokens must be an object with ${TOKEN_KEYS.join(", ")}`);
  else {
    problems.push(...unknownKeys(record.tokens, TOKEN_KEYS, "tokens."));
    for (const key of TOKEN_KEYS) if (!isCount(record.tokens[key])) problems.push(`tokens.${key} must be a whole number, 0 or more`);
  }
  if (typeof record.wallSeconds !== "number" || !Number.isFinite(record.wallSeconds) || record.wallSeconds < 0) problems.push("wallSeconds must be a number of seconds, 0 or more");
  if (!Number.isInteger(record.attempts) || record.attempts < 1) problems.push("attempts must be a whole number, 1 or more");
  if (!Array.isArray(record.sessionIds) || record.sessionIds.some((id) => !isText(id))) problems.push("sessionIds must be a list of non-empty strings");
  if (typeof record.startedAt !== "string" || !ISO_TIME.test(record.startedAt) || Number.isNaN(Date.parse(record.startedAt))) {
    problems.push("startedAt must be an ISO 8601 time with a zone, such as 2026-11-12T09:30:00Z");
  }
  if (record.error !== undefined && !isText(record.error)) problems.push("error, when given, must be a non-empty string");
  return problems;
}

/** One result as the line the runner appends to its results file. Throws on an invalid record. */
export function formatResultLine(record) {
  const problems = validateResult(record);
  if (problems.length) throw new Error(`invalid result for ${record?.taskId ?? "?"}: ${problems.join("; ")}`);
  return `${JSON.stringify(record)}\n`;
}

/**
 * Every result in a results file's text. Blank lines are skipped; a line that
 * is not valid JSON or not a valid record is reported with its line number.
 */
export function parseResultLines(text) {
  const results = [];
  const problems = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      problems.push(`line ${index + 1}: not JSON (${error.message})`);
      return;
    }
    const why = validateResult(record);
    if (why.length) problems.push(`line ${index + 1}: ${why.join("; ")}`);
    else results.push(record);
  });
  return { results, problems };
}
