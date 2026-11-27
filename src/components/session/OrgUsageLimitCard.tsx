import { useEffect, useState } from "react";
import { Copy, Sparkles } from "@/icons";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { copyText } from "@/lib/clipboard";

/**
 * A cloud tab on its organization's agent login hit the provider's usage
 * limit (PRO-200, design 17.13): members can't fix that themselves, so the
 * recovery card says an admin has to act, puts a ready request on the
 * clipboard, and offers to go on in the other agent. Everything else the
 * card offers at a usage limit (another account, Resend, Retry once the
 * limit resets, Stop) stays: see `RecoveryBanner`'s `orgLimit`.
 */

/** What the recovery card needs to speak of the organization's login. */
export interface OrgLimit {
  harness: string;
  organization: string;
  /** Whose login ran out, when the reader may list the organization's logins. */
  who: string | null;
  /** Open a tab of the other agent that continues from this conversation; absent where that can't be done. */
  onSwitch?: (harness: string) => void;
}

/** The agent "Switch to" offers: Codex for Claude Code, Claude Code for anything else. */
export function switchTarget(harness: string): string {
  return harness.toLowerCase() === "claude" ? "codex" : "claude";
}

/** "18:00", in the reader's own time. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Whose login it is, from its stored name: a lent sign-in carries its expiry
 * after " · ". A Bedrock login's name is its region and model, which is no
 * one's: the organization is named instead.
 */
export function loginOwner(login: { authKind: string; displayIdentity?: string | null } | undefined): string | null {
  if (!login || login.authKind === "bedrock") return null;
  const who = login.displayIdentity?.split(" · ")[0]?.trim();
  return who || null;
}

/** The card's words. `resetsAt` only while it is still ahead: past it the limit has reset and the card offers Retry. */
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

/** Whose login `harness` runs on in the organization: only owners and admins may list them, so a member gets null. */
export function useOrgLoginOwner(organizationId: string | null, harness: string): string | null {
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => {
    setWho(null);
    if (!organizationId) return;
    let live = true;
    api.cloudAgentLogins(organizationId).then(
      (list) => { if (live) setWho(loginOwner(list.credentials.find((login) => login.provider === harness.toLowerCase()))); },
      () => undefined,
    );
    return () => { live = false; };
  }, [organizationId, harness]);
  return who;
}

/** "Switch to <other agent>" and "Copy request", the card's first actions. */
export function OrgLimitActions({ limit, request, busy }: { limit: OrgLimit; request: string; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const other = switchTarget(limit.harness);
  return (
    <>
      {limit.onSwitch && (
        <Button size="sm" disabled={busy} onClick={() => limit.onSwitch?.(other)} data-testid="usage-limit-switch">
          <Sparkles />Switch to {cloudAgentLabel(other)}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => void copyText(request).then(() => setCopied(true), () => undefined)} data-testid="usage-limit-copy">
        <Copy />{copied ? "Copied" : "Copy request"}
      </Button>
    </>
  );
}

/** The line under the actions: what Switch does. */
export function orgLimitHint(limit: OrgLimit): string | null {
  return limit.onSwitch ? `Switch opens a ${cloudAgentLabel(switchTarget(limit.harness))} tab that continues from this conversation.` : null;
}
