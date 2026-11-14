import type { LocalVmDescription, LocalVmEnvironment, LocalVmTask } from "@/types/localVm";
import type { SessionEntry, TabEntry } from "@/types/session";

export const tab: TabEntry = { id: "parent-tab", harness: "codex", model: "gpt-6", effort: "high", permissionMode: "bypassPermissions", status: "idle", created: "", modified: "" };
export const session: SessionEntry = { id: "parent-session", projectPath: "/project", cwd: "/project/worktree", title: "Parent", worktreeRemoved: false, archived: false, pinned: false, tabs: [tab], created: "", modified: "" };
export const environment: LocalVmEnvironment = { id: "env", name: "Local guest", sandbox: "local:guest", generation: "generation-1", createdAt: "2026-10-24T00:00:00Z", deletedAt: null, keepAwake: false };
export const description: LocalVmDescription = { available: true, reason: null, capabilities: ["task.submit"], harnesses: [{ id: tab.harness, models: [{ id: tab.model, efforts: ["high"] }], permissionModes: [tab.permissionMode] }] };
export function task(overrides: Partial<LocalVmTask> = {}): LocalVmTask {
  return {
    target: { environmentId: environment.id, generation: environment.generation, workspaceId: "workspace", taskId: "task" },
    input: { parentSessionId: session.id, parentTabId: tab.id, parentMessageId: "local-vm::message", environmentId: environment.id, prompt: "Selected task", harness: tab.harness, model: tab.model, effort: tab.effort ?? null, permissionMode: tab.permissionMode, files: [], desktop: true },
    idempotencyKey: "submission", inputDigest: "digest", guestCwd: "/Users/guest/task", workerSessionId: null, workerTabId: null, providerConversationId: null,
    status: "running", createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:01Z", lastEventSeq: 0, events: [], artifacts: [], outcome: null, detail: null,
    ...overrides,
  };
}
