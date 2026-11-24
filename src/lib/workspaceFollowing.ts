import { useSyncExternalStore } from "react";
import { getAccount, subscribeAccount } from "@/lib/account";
import { privacyEnabled, subscribeDataPrivacy } from "@/lib/dataPrivacy";
import { phase2Ready } from "@/lib/phase2Readiness";

export function preferenceScope(): string | null {
  const { status } = getAccount();
  return !privacyEnabled() && status.state === "signed-in" && status.context
    ? JSON.stringify([status.context.account, status.context.revision])
    : null;
}

interface WorkspaceReassignReceipt {
  scope: string;
  orgId: string;
  workspaceId: string;
  targetName: string;
  reassigned: boolean;
}

let receipt: WorkspaceReassignReceipt | null = null;
let stop: (() => void) | undefined;
const listeners = new Set<() => void>();

function publish(value: WorkspaceReassignReceipt | null) {
  receipt = value;
  for (const listener of listeners) listener();
}

export function dismissWorkspaceReassignReceipt() {
  stop?.();
  stop = undefined;
  if (receipt) publish(null);
}

export function showWorkspaceReassignReceipt(value: WorkspaceReassignReceipt) {
  const available = () => value.scope === preferenceScope() && phase2Ready(getAccount().status, value.orgId, "followReassign");
  if (!available()) return;

  dismissWorkspaceReassignReceipt();
  const check = () => { if (!available()) dismissWorkspaceReassignReceipt(); };
  const unsubscribeAccount = subscribeAccount(check);
  const unsubscribePrivacy = subscribeDataPrivacy(check);
  const timeout = setTimeout(dismissWorkspaceReassignReceipt, 10_000);
  stop = () => { unsubscribeAccount(); unsubscribePrivacy(); clearTimeout(timeout); };
  publish(value);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useWorkspaceReassignReceipt() {
  return useSyncExternalStore(subscribe, () => receipt);
}
