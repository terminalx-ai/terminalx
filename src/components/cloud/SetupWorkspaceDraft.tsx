import { useEffect, useMemo, useReducer } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { type CloudWorkspaceLaunch } from "@/lib/api";
import { loadSetups, saveSetup } from "@/lib/organizationSetup";
import { selectCloudSession } from "@/lib/sessions";
import { cloudSessionKey } from "@/types/target";
import { publishSetupDraft, sendSetupDraft, subscribeSetupDraft } from "@/lib/setupWorkspaceDraft";

/** Only the admin's own setup record can offer this unsent first message. */
export function SetupWorkspaceDraft({ orgId, workspaceId, client, ready, launch }: { orgId: string; workspaceId: string; client: WorkspaceRpcClient; ready: boolean; launch?: CloudWorkspaceLaunch | null }) {
  const { status } = useAccount();
  const email = status.identity?.email ?? "";
  const owner = useMemo(() => ({ active: true }), [orgId, workspaceId, status.context?.account]);
  useEffect(() => { owner.active = true; return () => { owner.active = false; }; }, [owner]);
  const [, refresh] = useReducer((value) => value + 1, 0);
  useEffect(() => subscribeSetupDraft(refresh), []);
  const record = loadSetups(email).find((item) => item.organizationId === orgId && item.workspace?.id === workspaceId && item.draft && !item.draft.sent);
  const role = status.organizations?.find((org) => org.id === orgId)?.role;
  if (status.state !== "signed-in" || !record?.draft || (role !== "owner" && role !== "admin")) return null;
  const draft = record.draft;
  const canSend = ready && !!launch?.tabId && !!launch.sessionId && !launch.hasPrompt;
  const update = (patch: Partial<typeof draft>) => {
    saveSetup(email, { ...record, draft: { ...draft, ...patch } }); publishSetupDraft();
  };
  return <section aria-label="Setup workspace draft" className="shrink-0 space-y-3 border-b border-hairline bg-well p-4">
    <h2 className="text-sm font-medium">Check your cloud computer</h2>
    <textarea aria-label="Environment-check draft" className="min-h-32 w-full rounded-md border border-hairline bg-background p-3 text-sm" value={draft.text} disabled={draft.sending} onChange={(event) => update({ text: event.target.value })} />
    <div className="flex items-center gap-3">
      <Button aria-describedby={!draft.coachDismissed ? "setup-send-coach" : undefined} disabled={draft.sending || !canSend || !draft.text.trim()} onClick={() => { void sendSetupDraft(record, launch!, client, () => { if (owner.active) selectCloudSession(cloudSessionKey(orgId, workspaceId, launch!.sessionId!)); }); }}>Send</Button>
      {!draft.coachDismissed && <div id="setup-send-coach" role="status" className="rounded-md border border-accent/40 px-3 py-2 text-xs">
        Edit this draft, then press Send to check your environment.
        <Button size="xs" variant="ghost" onClick={() => update({ coachDismissed: true })}>Got it</Button>
      </div>}
      {draft.sending ? <span className="text-xs text-muted-foreground">Send started. Check the session's message queue for delivery.</span> : !canSend && <span className="text-xs text-muted-foreground">Waiting for the setup agent to connect…</span>}
    </div>
    {draft.error && <p role="alert" className="text-xs text-destructive">{draft.error}</p>}
  </section>;
}
