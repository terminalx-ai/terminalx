import { fs, invoke } from "@/lib/api";
import { assertLocal } from "@/types/target";
import type { ComputerContext, ComputerInventory, ComputerSelection, ComputerTarget } from "@/types/computer";
import type { LocalVmStatus } from "@/lib/api";
import type { LocalVmArtifactContent, LocalVmCreateRequest, LocalVmDescription, LocalVmEnvironment, LocalVmEnvironmentInspection, LocalVmInputFile, LocalVmJson, LocalVmPatchResult, LocalVmProvisionProposal, LocalVmRecoveryRequest, LocalVmSetupActionRequest, LocalVmSetupAuth, LocalVmSetupHarness, LocalVmSetupReadiness, LocalVmSetupRequest, LocalVmState, LocalVmSubmission, LocalVmTakeoverResult, LocalVmTask, LocalVmTaskTarget } from "@/types/localVm";

interface Requests {
  "computer.inventory": { params: Record<string, never>; result: ComputerInventory };
  "computer.selection": { params: ComputerContext; result: ComputerSelection };
  "computer.select": { params: ComputerContext & { target: ComputerTarget | null }; result: ComputerSelection };
  "computer.viewer": { params: { target: ComputerTarget }; result: LocalVmStatus };
  state: { params: Record<string, never>; result: LocalVmState };
  doctor: { params: Record<string, never>; result: LocalVmJson };
  configure: { params: { enabled: boolean }; result: LocalVmJson };
  enroll: { params: { name: string; sandbox: string }; result: LocalVmEnvironment };
  describe: { params: { environmentId: string; generation?: string }; result: LocalVmDescription };
  "environment.inspect": { params: { environmentId: string; generation?: string; purpose?: "deletion" | "provisionRecovery" }; result: LocalVmEnvironmentInspection };
  "environment.reconcileProvision": { params: Omit<LocalVmProvisionProposal, "observedAt"> & { disposition: "adoptExisting"; confirm: true }; result: LocalVmJson };
  "environment.create": { params: LocalVmCreateRequest; result: LocalVmEnvironment };
  "environment.setup": { params: LocalVmSetupRequest; result: LocalVmJson };
  "environment.setupReadiness": { params: { environmentId: string; generation: string; harness: LocalVmSetupHarness }; result: LocalVmSetupReadiness };
  "environment.setupAction": { params: LocalVmSetupActionRequest; result: LocalVmJson };
  "environment.setupAuth": { params: { environmentId: string; generation: string; idempotencyKey: string }; result: LocalVmSetupAuth };
  "environment.delete": { params: { environmentId: string; generation: string; confirm: true }; result: LocalVmJson };
  "environment.cancelProvision": { params: { environmentId: string }; result: LocalVmJson };
  "environment.start": { params: { environmentId: string }; result: LocalVmJson };
  "environment.stop": { params: { environmentId: string; confirm: true }; result: LocalVmJson };
  "environment.install": { params: { environmentId: string; runtimePath: string }; result: LocalVmJson };
  "environment.awake": { params: { environmentId: string; enabled: boolean }; result: LocalVmJson };
  "environment.desktop": { params: { environmentId: string; target?: LocalVmTaskTarget }; result: LocalVmJson };
  "environment.releaseDesktop": { params: { environmentId: string; confirm: true }; result: LocalVmJson };
  "task.submit": { params: LocalVmSubmission; result: LocalVmTask };
  "task.cancel": { params: { target: LocalVmTaskTarget }; result: LocalVmJson };
  "task.followup": { params: { target: LocalVmTaskTarget; text: string; idempotencyKey: string }; result: LocalVmJson };
  "task.recover": { params: LocalVmRecoveryRequest; result: LocalVmJson };
  "task.takeover": { params: { target: LocalVmTaskTarget; confirm: true }; result: LocalVmTakeoverResult };
  "task.permission": { params: { target: LocalVmTaskTarget; requestId: string; optionId: string; idempotencyKey: string }; result: LocalVmJson };
  "task.artifact": { params: { target: LocalVmTaskTarget; artifactId: string }; result: LocalVmArtifactContent };
  "task.applyPatch": { params: { target: LocalVmTaskTarget; artifactId: string; destinationRoot: string; confirm: true }; result: LocalVmPatchResult };
}

export function submissionUnavailable(description: LocalVmDescription | null, settings: Pick<LocalVmTask["input"], "harness" | "model" | "effort" | "permissionMode">, mode: "desktop" | "shellFiles" = "desktop"): string | null {
  if (!description?.available) return description?.reason || "Guest runtime capabilities are unavailable. Check this environment in Settings.";
  if (!description.capabilities?.includes(mode === "shellFiles" ? "task.submitShell" : "task.submit")) return "The guest has not reported support for selected tasks.";
  const harness = description.harnesses?.find((candidate) => candidate.id === settings.harness);
  if (!harness) return `The guest has not reported support for ${settings.harness}.`;
  const model = harness.models?.find((candidate) => candidate.id === settings.model);
  if (!model) return settings.model === "" ? "The guest has not reported support for provider-default model selection." : `The inherited model ${settings.model} is unavailable in the guest.`;
  if (settings.effort && !model.efforts?.includes(settings.effort)) return `The inherited effort ${settings.effort} is unavailable in the guest.`;
  if (!harness.permissionModes?.includes(settings.permissionMode)) return `The inherited permission mode ${settings.permissionMode} is unavailable in the guest.`;
  return null;
}

/** An empty inherited ID keeps provider-default intent; it is never replaced with a named model. */
export function localVmModelLabel(model: string): string {
  return model === "" ? "Provider default" : model;
}

/** No host fallback and no automatic retries of mutations. */
export function localVmRequest<M extends keyof Requests>(method: M, params: Requests[M]["params"]): Promise<Requests[M]["result"]> {
  return invoke("local_vm_request", { method, params });
}

export const LOCAL_VM_STATUS = {
  queued: "Queued for guest", starting: "Starting", running: "Running", waiting: "Needs attention",
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
    if (path.split("/").some((part) => /^(?:\.git|\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.codex|\.claude|node_modules)$/i.test(part)) || /(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx))$/i.test(path)) {
      throw new Error(`Credential and private configuration files cannot be selected: ${path}`);
    }
  }
  return paths;
}

/** Preview supports complete UTF-8 context files. The backend rechecks bytes at export. */
export async function contextManifest(sourceRoot: string, paths: string[]): Promise<LocalVmInputFile[]> {
  assertLocal(sourceRoot, "local VM context root");
  if (!sourceRoot.startsWith("/")) throw new Error("Context needs an absolute host project root.");
  if (!paths.length) return [];
  const selected = contextPaths(paths.join("\n"));
  if (selected.length !== paths.length || selected.some((path, i) => path !== paths[i])) throw new Error("Select distinct project-relative file paths.");
  const root = await fs.inspectPath(sourceRoot, ".");
  const manifest: LocalVmInputFile[] = [];
  let total = 0;
  // Bound concurrent reads and total memory instead of reading every selected file at once.
  for (const path of paths) {
    contextPaths(path);
    const file = await fs.inspectPath(sourceRoot, path);
    if (file.kind !== "file" || !file.path.startsWith(`${root.path.replace(/\/$/, "")}/`)) throw new Error(`Context file leaves the project or is not a file: ${path}`);
    contextPaths(file.path.slice(root.path.replace(/\/$/, "").length + 1));
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

/** Guest collect retains an AgentEvent inside TaskEvent.payload; lifecycle events are direct. */
function taskEventPayload(value: LocalVmJson): { [key: string]: LocalVmJson } | null {
  if (!record(value)) return null;
  return record(value.payload) ? value.payload : value;
}

function progressText(value: LocalVmJson | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim() || null;
}

/** The newest readable event, skipping usage/transport metadata without inventing activity. */
export function latestTaskProgress(task: LocalVmTask): string | null {
  for (let i = task.events.length - 1; i >= 0; i--) {
    const payload = taskEventPayload(task.events[i].payload);
    if (!payload) continue;
    let text: string | null = null;
    switch (payload.type) {
      case "status": text = progressText(payload.text); break;
      case "assistant_text": {
        const message = progressText(payload.text);
        if (message) text = `Agent: ${message}`;
        break;
      }
      case "tool_call_started": {
        const label = progressText(payload.title) ?? progressText(payload.name);
        text = label ? `Tool started: ${label}` : "Tool started";
        break;
      }
      case "tool_call_completed": {
        let label: string | null = null;
        if (typeof payload.callId === "string") {
          for (let j = i - 1; j >= 0; j--) {
            const started = taskEventPayload(task.events[j].payload);
            if (started?.type === "tool_call_started" && started.callId === payload.callId) {
              label = progressText(started.title) ?? progressText(started.name);
              break;
            }
          }
        }
        const result = payload.result !== undefined && record(payload.result) ? payload.result : null;
        const output = progressText(result?.text);
        text = `${result?.isError === true ? "Tool failed" : "Tool finished"}${label ? `: ${label}` : ""}${output ? ` · ${output}` : ""}`;
        break;
      }
      case "permission_requested": {
        const label = progressText(payload.title) ?? progressText(payload.toolName);
        text = `Waiting for permission${label ? `: ${label}` : ""}`;
        break;
      }
      case "questions_asked": text = "Waiting for your answer"; break;
      case "turn_started": text = "Agent turn started"; break;
      case "turn_completed":
        if (payload.authFailed === true) text = "Guest provider sign-in required";
        else if (payload.status === "ok") text = "Agent turn completed";
        else if (payload.status === "error") text = "Agent turn failed";
        else if (payload.status === "aborted") text = "Agent turn stopped";
        break;
      case "error": {
        const message = progressText(payload.message);
        text = message ? `Error: ${message}` : "Agent reported an error";
        break;
      }
      case "queued": text = LOCAL_VM_STATUS.queued; break;
      case "starting": text = LOCAL_VM_STATUS.starting; break;
      case "canceledBeforeStart": text = "Canceled before starting"; break;
      case "canceled": text = LOCAL_VM_STATUS.canceled; break;
      case "outcomeUnknown": text = `${LOCAL_VM_STATUS.outcomeUnknown}${progressText(payload.detail) ? `: ${progressText(payload.detail)}` : ""}`; break;
      case "taskSettled": text = Object.entries(LOCAL_VM_STATUS).find(([status]) => status === payload.status)?.[1] ?? null; break;
    }
    if (text) return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  }
  return null;
}

/** Events use the existing normalized permission contract, possibly in an AgentEvent envelope. */
export function pendingTaskApprovals(task: LocalVmTask): LocalVmApproval[] {
  if (taskFinished(task.status)) return [];
  const pending = new Map<string, LocalVmApproval>();
  for (const event of task.events) {
    const payload = taskEventPayload(event.payload);
    if (!payload) continue;
    if (typeof payload.requestId !== "string") continue;
    if (payload.type === "permission_decided") pending.delete(payload.requestId);
    if (payload.type !== "permission_requested" || !Array.isArray(payload.options)) continue;
    const options = payload.options.flatMap((option) => record(option) && typeof option.id === "string" && typeof option.label === "string" ? [{ id: option.id, label: option.label }] : []);
    pending.set(payload.requestId, { requestId: payload.requestId, title: typeof payload.title === "string" ? payload.title : typeof payload.toolName === "string" ? payload.toolName : "Guest permission requested", input: payload.input ?? null, options });
  }
  return [...pending.values()];
}
