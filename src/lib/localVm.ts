import { fs, invoke } from "@/lib/api";
import { assertLocal } from "@/types/target";
import type { LocalVmEnvironment, LocalVmInputFile, LocalVmJson, LocalVmState, LocalVmSubmission, LocalVmTask, LocalVmTaskTarget } from "@/types/localVm";

interface Requests {
  state: { params: Record<string, never>; result: LocalVmState };
  doctor: { params: Record<string, never>; result: LocalVmJson };
  enroll: { params: { name: string; sandbox: string }; result: LocalVmEnvironment };
  "environment.start": { params: { environmentId: string }; result: LocalVmJson };
  "environment.stop": { params: { environmentId: string; confirm: true }; result: LocalVmJson };
  "environment.install": { params: { environmentId: string; runtimePath: string }; result: LocalVmJson };
  "environment.awake": { params: { environmentId: string; enabled: boolean }; result: LocalVmJson };
  "environment.desktop": { params: { environmentId: string }; result: LocalVmJson };
  "task.submit": { params: LocalVmSubmission; result: LocalVmTask };
  "task.cancel": { params: { target: LocalVmTaskTarget }; result: LocalVmJson };
  "task.followup": { params: { target: LocalVmTaskTarget; text: string; idempotencyKey: string }; result: LocalVmJson };
  "task.permission": { params: { target: LocalVmTaskTarget; requestId: string; optionId: string; idempotencyKey: string }; result: LocalVmJson };
}

/** No host fallback and no automatic retries of mutations. */
export function localVmRequest<M extends keyof Requests>(method: M, params: Requests[M]["params"]): Promise<Requests[M]["result"]> {
  try {
    if (method === "task.submit" && "sourceRoot" in params) assertLocal(params.sourceRoot, "local VM context root");
    if (method === "environment.install" && "runtimePath" in params) assertLocal(params.runtimePath, "guest runtime installer");
  } catch (error) { return Promise.reject(error); }
  return invoke("local_vm_request", { method, params });
}

export const LOCAL_VM_STATUS = {
  queued: "Queued for desktop", starting: "Starting", running: "Running", waiting: "Needs attention",
  canceling: "Stopping", completed: "Completed", failed: "Failed", canceled: "Canceled", outcomeUnknown: "Outcome unknown",
} satisfies Record<LocalVmTask["status"], string>;

export function taskFinished(status: LocalVmTask["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

/** The parent-message identity is the durable task card in one conversation. */
export function taskMessagePrefix(conversation: string | null): string {
  return `local-vm:${encodeURIComponent(conversation ?? "")}:`;
}

export function tasksForConversation(state: LocalVmState | null, sessionId: string, tabId: string, conversation: string | null): LocalVmTask[] {
  return Object.values(state?.tasks ?? {}).filter(({ input }) =>
    input.parentSessionId === sessionId && input.parentTabId === tabId && input.parentMessageId.startsWith(taskMessagePrefix(conversation)),
  ).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.target.taskId.localeCompare(b.target.taskId));
}

export function contextPaths(text: string): string[] {
  const paths = [...new Set(text.split(/\r?\n/).map((path) => path.trim()).filter(Boolean))];
  if (paths.length > 64) throw new Error("Select at most 64 context files.");
  for (const path of paths) {
    if (path.includes("\\") || /[\0-\x1f]/.test(path) || /^(?:[a-z][a-z\d+.-]*:|~)/i.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Use an explicit project-relative file path: ${path}`);
    }
  }
  return paths;
}

function assertContextPath(path: string) {
  const parsed = contextPaths(path);
  if (parsed.length !== 1 || parsed[0] !== path) throw new Error(`Use one explicit relative file path: ${path}`);
}

/** Preview supports complete UTF-8 context files. The backend rechecks bytes at export. */
export async function contextManifest(sourceRoot: string, paths: string[]): Promise<LocalVmInputFile[]> {
  assertLocal(sourceRoot, "local VM context root");
  if (!sourceRoot.startsWith("/")) throw new Error("Context needs an absolute host project root.");
  if (!paths.length) return [];
  const root = await fs.inspectPath(sourceRoot, ".");
  const manifest: LocalVmInputFile[] = [];
  let total = 0;
  // Bound concurrent reads and total memory instead of reading every selected file at once.
  for (const path of paths) {
    assertContextPath(path);
    const file = await fs.inspectPath(sourceRoot, path);
    if (file.kind !== "file" || !file.path.startsWith(`${root.path.replace(/\/$/, "")}/`)) throw new Error(`Context file leaves the project or is not a file: ${path}`);
    const read = await fs.readText(file.path);
    const bytes = new TextEncoder().encode(read.content);
    if (!file.text || read.binary || read.truncated || bytes.byteLength !== read.size || read.content.includes("\ufffd")) throw new Error(`Select a complete UTF-8 text file: ${path}`);
    total += bytes.byteLength;
    if (total > 10 * 1024 * 1024) throw new Error("Selected context exceeds 10 MiB.");
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    manifest.push({ path, bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("") });
  }
  return manifest;
}

export interface LocalVmApproval {
  requestId: string;
  title: string;
  input: LocalVmJson;
  options: { id: string; label: string }[];
}

function record(value: LocalVmJson): value is { [key: string]: LocalVmJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Events use the existing normalized permission contract, possibly in an AgentEvent envelope. */
export function pendingTaskApprovals(task: LocalVmTask): LocalVmApproval[] {
  if (taskFinished(task.status)) return [];
  const pending = new Map<string, LocalVmApproval>();
  for (const event of task.events) {
    if (!record(event.payload)) continue;
    const payload = record(event.payload.payload) ? event.payload.payload : event.payload;
    if (typeof payload.requestId !== "string") continue;
    if (payload.type === "permission_decided") pending.delete(payload.requestId);
    if (payload.type !== "permission_requested" || !Array.isArray(payload.options)) continue;
    const options = payload.options.flatMap((option) => record(option) && typeof option.id === "string" && typeof option.label === "string" ? [{ id: option.id, label: option.label }] : []);
    pending.set(payload.requestId, { requestId: payload.requestId, title: typeof payload.title === "string" ? payload.title : typeof payload.toolName === "string" ? payload.toolName : "Guest permission requested", input: payload.input ?? null, options });
  }
  return [...pending.values()];
}
