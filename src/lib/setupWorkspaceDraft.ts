import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { getAccount, subscribeAccount } from "@/lib/account";
import { errorMessage, type CloudWorkspaceLaunch } from "@/lib/api";
import { sendToCloudAgent } from "@/lib/cloudAgents";
import { loadSetups, saveSetup, type OrganizationSetupRecord } from "@/lib/organizationSetup";
import { selectCloudSession } from "@/lib/sessions";
import { cloudSessionKey } from "@/types/target";

const flights = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
export const subscribeSetupDraft = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const publishSetupDraft = () => { for (const listener of listeners) listener(); };

/** The runtime launch already owns the repository-scoped tab. Never create a second tab here.
 * The operation outlives its view; the persisted sending bit also prevents replay after an
 * app restart or an uncertain response. The ordinary session outbox owns delivery/retries. */
export function sendSetupDraft(record: OrganizationSetupRecord, launch: CloudWorkspaceLaunch, client: WorkspaceRpcClient): Promise<void> {
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
  const pending = { ...latest, draft: { ...latest.draft, sending: true, coachDismissed: true, tabId: launch.tabId } };
  saveSetup(email, pending);
  // Select only in response to the click, never after a late response has arrived.
  selectCloudSession(cloudSessionKey(orgId, workspaceId, launch.sessionId));
  // Start in a microtask so the map owns even synchronously rejected operations.
  const operation = Promise.resolve().then(async () => {
    try {
      if (!current()) return;
      const receipt = await sendToCloudAgent({ organizationId: orgId, workspaceId }, launch.tabId!, pending.draft.text.trim(), client);
      const kept = current();
      if (kept?.draft) saveSetup(email, { ...kept, draft: { ...kept.draft, sent: true, sending: false, commandId: receipt.clientCommandId } });
    } catch (error) {
      // A lost reply may already have queued the message. Never offer another Send.
      if (current()) throw new Error(`Could not confirm Send: ${errorMessage(error)}. Check the session's message queue before sending again.`);
    } finally {
      unsubscribe(); flights.delete(key); publishSetupDraft();
    }
  });
  flights.set(key, operation);
  publishSetupDraft();
  return operation;
}
