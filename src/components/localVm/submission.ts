import type { LocalVmSubmission } from "@/types/localVm";
import { contextPaths, taskMessagePrefix } from "@/lib/localVm";
import { assertLocal } from "@/types/target";

export function submissionStorageKey(sessionId: string, tabId: string, conversation: string | null): string {
  return `terminalx.local-vm.pending.v1:${JSON.stringify([sessionId, tabId, conversation])}`;
}

/** Persist only this explicitly selected submission until its durable task is acknowledged. */
export function loadSubmission(key: string, sessionId: string, tabId: string, conversation: string | null): LocalVmSubmission | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value: LocalVmSubmission = JSON.parse(raw);
  const input = value?.input;
  if (!input || typeof value.idempotencyKey !== "string" || typeof value.sourceRoot !== "string" || !value.sourceRoot.startsWith("/") ||
    input.parentSessionId !== sessionId || input.parentTabId !== tabId || typeof input.parentMessageId !== "string" || !input.parentMessageId.startsWith(taskMessagePrefix(conversation)) ||
    typeof input.environmentId !== "string" || typeof input.prompt !== "string" || typeof input.harness !== "string" || typeof input.model !== "string" ||
    !(input.effort === null || typeof input.effort === "string") || typeof input.permissionMode !== "string" || typeof input.desktop !== "boolean" || !Array.isArray(input.files)) {
    throw new Error("The saved VM submission cannot be read. Retain it and check the durable task history before submitting again.");
  }
  assertLocal(value.sourceRoot);
  if (value.target && ((value.target.kind !== "macosGuest" && value.target.kind !== "linuxGuest") || value.target.environmentId !== input.environmentId || typeof value.target.generation !== "string" || !value.target.generation)) {
    throw new Error("The saved VM selection is invalid. Retain it and check the durable task history before submitting again.");
  }
  if ((!value.target || value.target.kind === "macosGuest") && input.desktop !== true) throw new Error("The saved desktop task mode is invalid.");
  if (value.target?.kind === "linuxGuest" && (input.desktop || !["docker", "podman"].includes(value.target.runtime) || !/^[a-f\d]{64}$/i.test(value.target.id))) throw new Error("The saved Linux task binding is invalid.");
  for (const file of input.files) {
    if (!file || typeof file.path !== "string" || !/^[a-f\d]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error("The saved VM context manifest cannot be read.");
    const paths = contextPaths(file.path);
    if (paths.length !== 1 || paths[0] !== file.path) throw new Error("The saved VM context manifest contains an invalid path.");
  }
  if (input.files.length > 64 || new Set(input.files.map((file) => file.path)).size !== input.files.length) throw new Error("The saved VM context manifest contains too many or duplicate paths.");
  return value;
}
