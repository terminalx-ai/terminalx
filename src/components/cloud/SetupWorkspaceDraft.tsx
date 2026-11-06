import { useRef, useState } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { errorMessage } from "@/lib/api";
import { createCloudAgentTab, sendToCloudAgent } from "@/lib/cloudAgents";
import { loadSetups, saveSetup } from "@/lib/organizationSetup";

/** Only the admin's own setup record can offer this unsent first message. */
export function SetupWorkspaceDraft({ orgId, workspaceId, client, ready }: { orgId: string; workspaceId: string; client: WorkspaceRpcClient; ready: boolean }) {
  const { status } = useAccount();
  const email = status.identity?.email ?? "";
  const [record, setRecord] = useState(() => loadSetups(email).find((item) => item.organizationId === orgId && item.workspace?.id === workspaceId && item.draft && !item.draft.sent));
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const role = status.organizations?.find((org) => org.id === orgId)?.role;
  if (!record?.draft || record.draft.sent || (role !== "owner" && role !== "admin")) return null;
  const draft = record.draft;
  const update = (patch: Partial<typeof draft>) => {
    const next = { ...record, draft: { ...draft, ...patch } };
    saveSetup(email, next); setRecord(next);
    return next;
  };
  const send = async () => {
    if (flight.current || !ready || !draft.text.trim()) return;
    flight.current = true; setBusy(true); setError(null);
    let kept = record;
    try {
      const scope = { organizationId: orgId, workspaceId };
      const tabId = draft.tabId ?? await createCloudAgentTab(scope, client, { agent: draft.agent, title: "Environment check" });
      kept = update({ tabId, coachDismissed: true });
      await sendToCloudAgent(scope, tabId, draft.text.trim(), client);
      const sent = { ...kept, draft: { ...kept.draft!, sent: true } };
      saveSetup(email, sent); setRecord(sent);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { flight.current = false; setBusy(false); }
  };
  return <section aria-label="Setup workspace draft" className="shrink-0 space-y-3 border-b border-hairline bg-well p-4">
    <h2 className="text-sm font-medium">Check your cloud computer</h2>
    <textarea aria-label="Environment-check draft" className="min-h-32 w-full rounded-md border border-hairline bg-background p-3 text-sm" value={draft.text} disabled={busy} onChange={(event) => update({ text: event.target.value })} />
    <div className="flex items-center gap-3">
      <Button aria-describedby={!draft.coachDismissed ? "setup-send-coach" : undefined} disabled={busy || !ready || !draft.text.trim()} onClick={() => void send()}>Send</Button>
      {!draft.coachDismissed && <div id="setup-send-coach" role="status" className="rounded-md border border-accent/40 px-3 py-2 text-xs">
        Edit this draft, then press Send to check your environment.
        <Button size="xs" variant="ghost" onClick={() => update({ coachDismissed: true })}>Got it</Button>
      </div>}
      {!ready && <span className="text-xs text-muted-foreground">Waiting for the computer to connect…</span>}
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
