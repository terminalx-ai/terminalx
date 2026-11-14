import { useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { resolveCloudAttention, type CloudAttentionInput } from "@/lib/cloudAttention";
import { workspaceAuthority, LIFECYCLE_ADMIN_REASON } from "@/lib/cloudCollab";
import { blankIdentity, getCloudCatalog, refreshCloudCatalog, repositoryOf, resumeCloudWorkspace } from "@/lib/cloudCatalog";
import { openAgentLogins, openOrganizationSettings, openSettingRow } from "@/lib/settingsLinks";
import { selectCloudWorkspace, startCloudSessionIn } from "@/lib/sessions";
import { cloudProjectKey, cloudWorkspaceKey } from "@/types/target";
import { lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { errorCode } from "@/lib/cloudTerminals";
import { actionsFor } from "./CloudWorkspaceLifecycle";
import { WorkspaceLifecycleDialog, type LifecycleRequest } from "./WorkspaceActions";

// Keep the explicit sidebar recovery request until its workspace pane mounts.
// Opening its agent view never replays the first prompt or wakes compute.
let sessionRequest: { key: string } | null = null;
const sessionListeners = new Set<() => void>();
const subscribeSessionRequest = (listener: () => void) => {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
};
export function useAttentionSessionRequest() {
  return useSyncExternalStore(subscribeSessionRequest, () => sessionRequest, () => null);
}
export function takeAttentionSessionRequest(request: NonNullable<typeof sessionRequest>) {
  if (sessionRequest !== request) return;
  sessionRequest = null;
  sessionListeners.forEach((listener) => listener());
}
function openAttentionSession(key: string) {
  sessionRequest = { key };
  sessionListeners.forEach((listener) => listener());
  selectCloudWorkspace(key);
}

/** Advice comes from the shared resolver; mutations retain the existing lifecycle authorization and confirmations. */
export function CloudWorkspaceAttention({ item, input = {}, compact = false, onOpenSession }: {
  item: CloudWorkspaceListItem;
  input?: Omit<CloudAttentionInput, "canRetryFirstTask">;
  compact?: boolean;
  onOpenSession?: () => void;
}) {
  const attention = resolveCloudAttention(item, { ...input, canRetryFirstTask: false });
  const [request, setRequest] = useState<LifecycleRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  if (!attention) return null;
  const { workspace } = item;
  const suggested = attention.recovery;
  const operationAction = suggested.operationAction === "suspend" ? "stop" : suggested.operationAction;
  // The existing dialog must offer the requested action; otherwise it silently selects a different action.
  const unavailableOperation = suggested.action === "retry-operation" && operationAction !== "resume"
    && (!operationAction || !actionsFor(item).includes(operationAction));
  const recovery = unavailableOperation
    ? { action: "open-session" as const, label: "Open session", instructions: "Open the workspace to inspect the failed operation. An owner or admin can review its runtime and provider state before retrying." }
    : suggested;
  const manager = workspaceAuthority(workspace).lifecycle;
  const restricted = recovery.action === "retry-operation" || recovery.action === "create-workspace";
  const disabled = busy || (restricted && !manager);
  const open = () => onOpenSession ? onOpenSession() : openAttentionSession(cloudWorkspaceKey(workspace.orgId, workspace.id));
  const act = async () => {
    if (disabled || pending.current) return;
    setError(null);
    switch (recovery.action) {
      case "open-agent-logins": openAgentLogins(workspace.orgId); return;
      case "check-github-access":
      case "open-provider-settings":
      case "contact-provider": openOrganizationSettings(workspace.orgId); return;
      case "update-runtime": openSettingRow("about.checkUpdates"); return;
      case "create-workspace": {
        const repository = repositoryOf(item, getCloudCatalog().createMemory);
        startCloudSessionIn(cloudProjectKey(workspace.orgId, repository?.identity ?? blankIdentity(workspace.name)));
        return;
      }
      case "retry-operation":
        if (operationAction !== "resume") {
          if (!operationAction) return;
          setRequest({ item, action: operationAction });
          return;
        }
        pending.current = true;
        setBusy(true);
        try {
          await resumeCloudWorkspace(item);
          await refreshCloudCatalog(workspace.orgId);
        } catch (e) {
          setError(lifecycleErrorMessage(errorCode(e)));
        } finally {
          pending.current = false;
          setBusy(false);
        }
        return;
      // No supported first-task replay exists in this UI. Never opt into that resolver capability.
      case "retry-first-task":
      case "open-session": open(); return;
    }
  };
  const reason = compact && recovery.action === "open-agent-logins" ? "The agent needs a working login." : compact ? attention.message.split(/(?<=\.)\s/)[0] : attention.message;
  return (
    <div role="status" data-testid={compact ? "cloud-row-attention" : "cloud-workspace-attention"}
      className={compact ? "flex min-w-0 flex-col items-start gap-1 px-2 pb-2 text-[11px]" : "flex shrink-0 flex-col items-start gap-2 border-b border-hairline bg-well px-4 py-3 text-xs"}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <p className="max-w-full whitespace-normal break-words text-destructive" title={attention.message}>{reason}</p>
      {!compact && <p className="text-muted-foreground">{recovery.instructions}</p>}
      <Button type="button" size="xs" variant="outline" className="h-auto max-w-full whitespace-normal py-1 text-left" disabled={disabled}
        title={restricted && !manager ? LIFECYCLE_ADMIN_REASON : recovery.instructions} onClick={() => void act()}>
        {recovery.label}
      </Button>
      {!compact && onOpenSession && recovery.action !== "open-session" && (
        <Button type="button" size="xs" variant="ghost" onClick={open}>Open session</Button>
      )}
      {restricted && !manager && !compact && <p className="text-muted-foreground">{LIFECYCLE_ADMIN_REASON}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {request && <WorkspaceLifecycleDialog request={request} onClose={() => setRequest(null)} />}
    </div>
  );
}
