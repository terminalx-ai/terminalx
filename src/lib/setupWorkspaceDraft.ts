import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { getAccount, subscribeAccount } from "@/lib/account";
import { errorMessage, type CloudWorkspaceLaunch } from "@/lib/api";
import { sendToCloudAgent } from "@/lib/cloudAgents";
import { loadSetups, saveSetup, type OrganizationSetupRecord } from "@/lib/organizationSetup";

const flights = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
export const subscribeSetupDraft = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const publishSetupDraft = () => { for (const listener of listeners) listener(); };

/** The runtime launch already owns the repository-scoped tab. Never create a second tab here.
 * The operation outlives its view; the persisted sending bit also prevents replay after an
 * app restart or an uncertain response. The ordinary session outbox owns delivery/retries. */
export function sendSetupDraft(record: OrganizationSetupRecord, launch: CloudWorkspaceLaunch, client: WorkspaceRpcClient, onSent: () => void): Promise<void> {
  const before = getAccount().status;
  const email = before.identity?.email;
  const account = before.context?.account;
  const revision = before.context?.revision;
  const orgId = record.organizationId;
  const workspaceId = record.workspace?.id;
  if (!email || !account || !orgId || !workspaceId || !launch.tabId || !launch.sessionId || launch.hasPrompt) return Promise.resolve();
  const key = JSON.stringify([account, orgId, workspaceId, record.requestId]);
  const existing = flights.get(key);
  if (existing) return existing;
  let valid = true;
  const current = () => {
    const status = getAccount().status;
    const role = status.organizations?.find((org) => org.id === orgId)?.role;
    valid &&= status.state === "signed-in" && status.context?.account === account && status.context?.revision === revision && (role === "owner" || role === "admin");
    return valid ? loadSetups(email).find((item) => item.requestId === record.requestId && item.organizationId === orgId && item.workspace?.id === workspaceId) : undefined;
  };
  const latest = current();
  if (!latest?.draft || latest.draft.sent || latest.draft.sending || !latest.draft.text.trim()) return Promise.resolve();
  const unsubscribe = subscribeAccount(() => { current(); });
  // Start in a microtask so the map owns even synchronously rejected operations.
  const operation = Promise.resolve().then(async () => {
    try {
      const active = current();
      if (!active?.draft) return;
      // Nothing is marked sending if a context change prevents enqueue altogether.
      saveSetup(email, { ...active, draft: { ...active.draft, sending: true, error: undefined, coachDismissed: true, tabId: launch.tabId! } });
      publishSetupDraft();
      const receipt = await sendToCloudAgent({ organizationId: orgId, workspaceId }, launch.tabId!, active.draft.text.trim(), client);
      const kept = current();
      if (kept?.draft) {
        saveSetup(email, { ...kept, draft: { ...kept.draft, sent: true, sending: false, commandId: receipt.clientCommandId } });
        // The originating view owns navigation; completion still persists after it closes.
        onSent();
      }
    } catch (error) {
      const kept = current();
      if (kept?.draft) {
        const code = typeof error === "string" ? error : error instanceof Error ? error.message : error && typeof error === "object" && "code" in error ? String(error.code) : "";
        // Native enqueue rejects these before post_new creates any outbox entry.
        const notQueued = new Set(["cloud_agent_key_missing", "cloud_agent_key_store_unavailable", "cloud_agent_command_too_large", "cloud_agent_request_invalid", "cloud_agent_encrypt_failed", "cloud_workspace_stopped"]).has(code);
        const message = code === "cloud_agent_key_missing" ? "Reconnect the computer, then try Send again." : code === "cloud_agent_command_too_large" ? "The draft is too large. Shorten it, then try Send again." : notQueued ? `Nothing was sent: ${errorMessage(error)}` : `Could not confirm Send: ${errorMessage(error)}. Check the session's message queue before sending again.`;
        saveSetup(email, { ...kept, draft: { ...kept.draft, sending: !notQueued, error: message } });
      }
    } finally {
      unsubscribe(); flights.delete(key); publishSetupDraft();
    }
  });
  flights.set(key, operation);
  publishSetupDraft();
  return operation;
}
