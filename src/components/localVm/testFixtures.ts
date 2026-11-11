import { taskMessagePrefix } from "@/lib/localVm";
import type { LocalVmEnvironment, LocalVmTask } from "@/types/localVm";

export const environment: LocalVmEnvironment = {
  id: "01900000-0000-7000-8000-000000000001", name: "Pilot guest", sandbox: "local:pilot",
  generation: "01900000-0000-7000-8000-000000000002", createdAt: "2026-10-24T10:00:00Z", deletedAt: null, keepAwake: false,
};
export const parentSessionId = "01900000-0000-7000-8000-000000000003";
export const parentTabId = "01900000-0000-7000-8000-000000000004";

export function makeTask(patch: Partial<LocalVmTask> = {}): LocalVmTask {
  return {
    target: { environmentId: environment.id, generation: environment.generation, workspaceId: "01900000-0000-7000-8000-000000000005", taskId: "01900000-0000-7000-8000-000000000006" },
    input: { parentSessionId, parentTabId, parentMessageId: `${taskMessagePrefix(null)}card-1`, environmentId: environment.id, prompt: "Verify the guest app", harness: "codex", model: "gpt-6.1-sol", effort: "high", permissionMode: "manual", files: [], desktop: true },
    idempotencyKey: "click-1", inputDigest: "digest", guestCwd: "/Users/lume/.terminalx-local/workspaces/test", workerSessionId: null, workerTabId: null,
    providerConversationId: null, status: "queued", createdAt: "2026-10-24T10:00:00Z", updatedAt: "2026-10-24T10:00:00Z", lastEventSeq: 0, events: [], artifacts: [], outcome: null, detail: null,
    ...patch,
  };
}
