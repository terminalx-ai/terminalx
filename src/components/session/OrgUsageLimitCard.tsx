import { useEffect, useState } from "react";
import { Copy, Gauge, Sparkles } from "@/icons";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { copyText } from "@/lib/clipboard";

/**
 * A cloud tab on its organization's agent login hit the provider's usage
 * limit (PRO-200, design 17.13): members can't fix that themselves, so the
 * card says an admin has to act, puts a ready request on the clipboard, and
 * offers to go on in the other agent.
 */

/** The agent "Switch to" offers: Codex for Claude Code, Claude Code for anything else. */
export function switchTarget(harness: string): string {
  return harness.toLowerCase() === "claude" ? "codex" : "claude";
}

/** "18:00", in the reader's own time. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Whose login ran out, from its stored name: a lent sign-in carries its expiry after " · ". */
function owner(identity: string | undefined): string | null {
  const who = identity?.split(" · ")[0]?.trim();
  return who || null;
}

export function usageLimitCardText({ agent, organization, resetsAt, who }: { agent: string; organization: string; resetsAt: number | null; who: string | null }): {
  title: string;
  body: string;
  request: string;
} {
  const until = resetsAt ? ` until ${clock(resetsAt)}` : "";
  const body = who
    ? `${who}’s login is out of ${agent} usage${until}. It is the ${agent} login ${organization} set for cloud workspaces. Ask an organization admin to raise it or switch logins.`
    : `The ${agent} login ${organization} set for cloud workspaces is out of usage${until}. Ask an organization admin to raise it or switch logins.`;
  const request = `${agent} in ${organization}’s cloud workspaces has reached its usage limit${until}. Could you raise the limit or switch the ${agent} login in Settings → Organizations → ${organization} → Agent logins?`;
  return { title: `${agent} usage limit reached`, body, request };
}

export function OrgUsageLimitCard({ harness, organizationId, organization, resetsAt, busy, onSwitch }: {
  harness: string;
  organizationId: string;
  organization: string;
  resetsAt: number | null;
  busy: boolean;
  /** Open a tab of the other agent that continues from this conversation; absent where that can't be done. */
  onSwitch?: (harness: string) => void;
}) {
  const agent = cloudAgentLabel(harness);
  const other = switchTarget(harness);
  // Owners and admins may read the organization's logins, and so whose this one is; a member is not told.
  const [who, setWho] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    api.cloudAgentLogins(organizationId).then(
      (list) => { if (live) setWho(owner(list.credentials.find((login) => login.provider === harness.toLowerCase())?.displayIdentity)); },
      () => undefined,
    );
    return () => { live = false; };
  }, [organizationId, harness]);
  const text = usageLimitCardText({ agent, organization, resetsAt, who });
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 bg-chat px-6 pb-2">
      <section aria-label="Usage limit" role="status" data-testid="org-usage-limit"
        className="rounded-xl border border-warning/30 bg-[color-mix(in_oklab,var(--color-warning)_10%,var(--color-chat))] p-3 text-xs shadow-surface">
        <p className="flex items-center gap-2 font-medium"><Gauge className="size-3.5 text-warning" />{text.title}</p>
        <p className="mt-1 text-muted-foreground">{text.body}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onSwitch && (
            <Button size="sm" disabled={busy} onClick={() => onSwitch(other)} data-testid="usage-limit-switch">
              <Sparkles />Switch to {cloudAgentLabel(other)}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void copyText(text.request).then(() => setCopied(true), () => undefined)} data-testid="usage-limit-copy">
            <Copy />{copied ? "Copied" : "Copy request"}
          </Button>
          {onSwitch && <span className="text-muted-foreground">Switch opens a {cloudAgentLabel(other)} tab that continues from this conversation.</span>}
        </div>
      </section>
    </div>
  );
}
