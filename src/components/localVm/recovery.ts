import type { LocalVmRecoveryRequest, LocalVmTask, LocalVmTaskTarget } from "@/types/localVm";

export interface PendingLocalVmRecovery {
  request: LocalVmRecoveryRequest;
  afterSeq: number;
}

function sameTarget(left: LocalVmTaskTarget, right: LocalVmTaskTarget): boolean {
  return left.environmentId === right.environmentId && left.generation === right.generation && left.workspaceId === right.workspaceId && left.taskId === right.taskId;
}

export function recoveryStorageKey(target: LocalVmTaskTarget): string {
  return `terminalx.local-vm.recovery.v1:${JSON.stringify([target.environmentId, target.generation, target.workspaceId, target.taskId])}`;
}

export function recoveryInstructionsError(text: string, originalPrompt?: string): string | null {
  if (!text.trim()) return "Enter new, explicit recovery instructions.";
  if (text === originalPrompt) return "Recovery cannot replay the original prompt. Enter new follow-up instructions.";
  if (new TextEncoder().encode(text).byteLength > 256 * 1024) return "Recovery instructions exceed the guest limit of 256 KiB.";
  return null;
}

/** A reload cannot replace ambiguous recovery delivery with different instructions or a new key. */
export function loadRecovery(target: LocalVmTaskTarget): PendingLocalVmRecovery | null {
  const raw = localStorage.getItem(recoveryStorageKey(target));
  if (!raw) return null;
  const saved: PendingLocalVmRecovery = JSON.parse(raw);
  const request = saved?.request;
  if (!request?.target || !sameTarget(request.target, target) || request.confirm !== true ||
    typeof request.text !== "string" || recoveryInstructionsError(request.text) !== null || typeof request.idempotencyKey !== "string" || !request.idempotencyKey || request.idempotencyKey.length > 200 ||
    !Number.isSafeInteger(saved.afterSeq) || saved.afterSeq < 0) {
    throw new Error("The saved recovery request cannot be read. Retain it and inspect task history before requesting recovery again.");
  }
  return saved;
}

/** Only a matching keyed checkpoint in the polled journal acknowledges recovery, never its RPC reply. */
export function recoveryAcknowledged(task: LocalVmTask, pending: PendingLocalVmRecovery): boolean {
  if (!sameTarget(task.target, pending.request.target)) return false;
  return task.events.some((event) => {
    if (event.seq <= pending.afterSeq) return false;
    const payload = event.payload;
    return payload !== null && typeof payload === "object" && !Array.isArray(payload) && payload.type === "taskRecovered" && payload.idempotencyKey === pending.request.idempotencyKey;
  });
}
