import { useEffect, useRef, useState } from "react";
import { secretStoreShort, secretStoreWord } from "@/lib/platform";
import { Loader2, Pencil, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { agentAccounts, SAVED_KEY_ACCOUNT, type AgentAccount, type AgentAccountAgent, type AgentAccounts, type AgentAccountRunningTab } from "@/lib/agentAccounts";
import { agentLogins, type AgentLoginStatus } from "@/lib/agentLogins";
import type { AgentReadiness } from "@/lib/agentReadiness";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { getSessionStore } from "@/lib/sessions";
import { SignInProgress, signInMessage, useAccountSignIn } from "./AgentAccountSignIn";

const PLANS: Record<string, string> = {
  free: "Free", pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", plus: "Plus", business: "Business", edu: "Edu", go: "Go", api: "API",
};

/** "Max", "Pro": a plan as the person knows it; an unknown one as the agent wrote it. */
export function planName(plan: string | null | undefined): string | null {
  if (!plan) return null;
  return PLANS[plan] ?? plan;
}

const STATES: Record<AgentReadiness["state"], string> = {
  missing: "Not installed",
  signed_out: "Sign in required",
  ready: "Signed in",
  unknown: "Login not checked",
};

/** A running tab, by its session's name (and its own, where the session has several). */
export function tabName(tab: { sessionId: string; tabId: string }): string {
  const session = getSessionStore().sessions.find((candidate) => candidate.id === tab.sessionId);
  const title = session?.title?.trim() || "Untitled session";
  const own = session && session.tabs.length > 1 ? session.tabs.find((candidate) => candidate.id === tab.tabId)?.title?.trim() : null;
  return own ? `${title} · ${own}` : title;
}

/** One account of an agent in Settings → Agents (#980). */
export function AgentAccountRow({ harness, agentName, account, localReadiness, login, onView, onChanged }: {
  harness: AgentAccountAgent;
  agentName: string;
  account: AgentAccount;
  /** This Mac's login as the agent's readiness check reads it. */
  localReadiness: AgentReadiness | null;
  /** The PRO-306 settings, for the saved key's state. */
  login: AgentLoginStatus | null;
  /** The list came back from a change: show it. */
  onView: (view: AgentAccounts) => void;
  /** Something new tabs start with changed (`made default`, or it was removed). */
  onChanged: (what: { kind: "default" | "removed"; account: AgentAccount; view: AgentAccounts }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const [busy, setBusy] = useState<"label" | "default" | "remove" | "tabs" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "problem"; text: string } | null>(null);
  /** Remove asked: the tabs running on it, once they are known. */
  const [confirming, setConfirming] = useState<AgentAccountRunningTab[] | null>(null);
  const [readiness, setReadiness] = useState<AgentReadiness | null>(null);
  const [checked, setChecked] = useState(0);
  const signIn = useAccountSignIn();
  const input = useRef<HTMLInputElement>(null);
  const added = !account.local && account.id !== SAVED_KEY_ACCOUNT;
  const subscription = account.kind === "subscription";

  // An added subscription's login state is its own directory's, asked of the agent there.
  useEffect(() => {
    if (!added || !subscription || account.missing) { setReadiness(null); return; }
    let live = true;
    agentAccounts.readiness(harness, account.id).then((value) => live && setReadiness(value)).catch(() => live && setReadiness(null));
    return () => { live = false; };
  }, [harness, account.id, added, subscription, account.missing, checked]);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const run = async <T,>(what: NonNullable<typeof busy>, work: () => Promise<T>): Promise<T | null> => {
    setBusy(what);
    setMessage(null);
    try { return await work(); }
    catch (e) { setMessage({ tone: "problem", text: errorMessage(e) }); return null; }
    finally { setBusy(null); }
  };

  const saveLabel = async () => {
    if (draft.trim() === account.label) { setEditing(false); return; }
    const view = await run("label", () => agentAccounts.relabel(harness, account.id, draft));
    if (view) { setEditing(false); onView(view); }
  };
  const makeDefault = async () => {
    const view = await run("default", () => agentAccounts.setDefault(harness, account.id));
    if (view) { onView(view); onChanged({ kind: "default", account, view }); }
  };
  const askRemove = async () => {
    const tabs = await run("tabs", async () => {
      try { return (await agentLogins.tabs(harness)).filter((tab) => tab.account === account.id); }
      catch { return []; } // No runtime: nothing runs on it.
    });
    setConfirming(tabs ?? []);
  };
  const remove = async () => {
    const known = confirming ?? [];
    // Confirmed for the tabs shown; with none shown, the command names any that started since.
    const result = await run("remove", () => agentAccounts.remove(harness, account.id, known.length > 0));
    if (!result) return;
    if (!result.removed) { setConfirming(result.runningTabs); return; }
    setConfirming(null);
    onView(result.accounts);
    onChanged({ kind: "removed", account, view: result.accounts });
  };
  const signInAgain = async () => {
    setMessage(null);
    try {
      const end = await signIn.begin(() => agentAccounts.signInAgain(harness, account.id));
      setMessage(signInMessage(end, agentName));
      if (end.status === "signedInAgain") {
        setChecked((n) => n + 1);
        onView(await agentAccounts.list(harness));
      }
    } catch (e) {
      setMessage({ tone: "problem", text: errorMessage(e) });
    }
  };

  const detail = account.local
    ? [localReadiness?.state === "ready" ? localReadiness.account : null, planName(localReadiness?.plan)].filter(Boolean).join(" · ") || null
    : account.kind === "apiKey" ? (account.id === SAVED_KEY_ACCOUNT && login?.variable ? `${login.variable} · ${secretStoreWord}` : secretStoreWord)
    : [account.email, planName(account.plan), account.organization].filter(Boolean).join(" · ") || null;
  const state = account.missing ? "Its folder is gone · sign in again"
    : account.local ? (localReadiness ? STATES[localReadiness.state] : "Checking…")
    : account.kind === "apiKey" ? (account.id === SAVED_KEY_ACCOUNT && login?.verified ? (login.verified.ok ? "Verified" : "Not verified") : null)
    : readiness ? STATES[readiness.state] : "Checking…";
  const signedIn = account.local ? localReadiness?.state === "ready" : subscription ? readiness?.state === "ready" && !account.missing : login?.verified?.ok !== false;
  const locked = !!busy || signIn.busy;

  return <li aria-label={account.label} className="border-b border-hairline px-3 py-2.5 last:border-0">
    <div className="flex items-start gap-2.5">
      <span aria-hidden className={cn("mt-[7px] size-2 shrink-0 rounded-full", signedIn ? "bg-add" : account.missing || readiness?.state === "signed_out" || (account.local && localReadiness?.state === "signed_out") || (account.kind === "apiKey" && login?.verified?.ok === false) ? "bg-warning" : "bg-faint")} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {editing
            ? <input ref={input} aria-label={`Label for ${account.label}`} value={draft} maxLength={60} disabled={busy === "label"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void saveLabel(); if (e.key === "Escape") { setEditing(false); setDraft(account.label); } }}
                className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-card px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
            : <span className="truncate text-[13px] font-medium">{account.label}</span>}
          {!account.local && !editing && <button type="button" aria-label={`Rename ${account.label}`} disabled={locked} onClick={() => { setDraft(account.label); setEditing(true); }}
            className="shrink-0 rounded-sm p-0.5 text-faint hover:text-foreground disabled:cursor-default"><Pencil className="size-3" /></button>}
          {editing && <>
            <Button size="sm" variant="outline" className="shrink-0 whitespace-nowrap" disabled={busy === "label"} onClick={() => void saveLabel()}>{busy === "label" ? <Loader2 className="animate-spin" /> : null} Save</Button>
            <Button size="sm" variant="ghost" className="shrink-0 whitespace-nowrap" disabled={busy === "label"} onClick={() => { setEditing(false); setDraft(account.label); }}>Cancel</Button>
          </>}
          {!editing && <Tag>{account.kind === "apiKey" ? "API key" : "Subscription"}</Tag>}
          {!editing && account.isDefault && <Tag accent>Default</Tag>}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{[detail, state].filter(Boolean).join(" · ")}</div>
      </div>
      {!editing && <div className="flex shrink-0 items-center gap-1">
        {!account.isDefault && <Button size="sm" variant="ghost" className="whitespace-nowrap" aria-label={`Make ${account.label} the default`} disabled={locked || account.missing} onClick={() => void makeDefault()}>
          {busy === "default" ? <Loader2 className="animate-spin" /> : null} Make default
        </Button>}
        {added && subscription && <Button size="sm" variant="ghost" className="whitespace-nowrap" aria-label={`Sign in again to ${account.label}`} disabled={locked} onClick={() => void signInAgain()}>Sign in again</Button>}
        {!account.local && <Button size="sm" variant="ghost" className="whitespace-nowrap text-muted-foreground" aria-label={`Remove ${account.label}`} disabled={locked || !!confirming} onClick={() => void askRemove()}>
          {busy === "tabs" ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove
        </Button>}
      </div>}
    </div>
    {signIn.busy && <div className="ml-[18px]"><SignInProgress started={signIn.started} agentName={agentName} onCancel={signIn.cancel} /></div>}
    {confirming && <div role="group" aria-label={`Remove ${account.label}?`} className="ml-[18px] mt-2 rounded-md bg-muted/60 px-3 py-2.5 text-[12.5px]">
      <p>Remove {account.label}? {subscription ? `${agentName} signs it out first, then its folder is deleted.` : `Its key is deleted from ${secretStoreShort}.`}</p>
      {confirming.length > 0
        ? <>
          <p className="mt-1.5">{confirming.length === 1 ? "1 running tab uses it" : `${confirming.length} running tabs use it`} and stops working on it until restarted on another account:</p>
          <ul aria-label="Running tabs on this account" className="mt-1 list-disc pl-5">{confirming.map((tab) => <li key={`${tab.sessionId}:${tab.tabId}`}>{tabName(tab)}</li>)}</ul>
        </>
        : <p className="mt-1.5 text-muted-foreground">No running tab uses it.</p>}
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" variant="destructive" className="whitespace-nowrap" disabled={busy === "remove"} onClick={() => void remove()}>
          {busy === "remove" ? <Loader2 className="animate-spin" /> : null} Remove account
        </Button>
        <Button size="sm" variant="ghost" className="whitespace-nowrap" disabled={busy === "remove"} onClick={() => setConfirming(null)}>Keep it</Button>
      </div>
    </div>}
    {message && <p role={message.tone === "problem" ? "alert" : "status"} className={cn("ml-[18px] mt-1.5 text-[12px]", message.tone === "problem" ? "text-destructive" : "text-add")}>{message.text}</p>}
  </li>;
}

function Tag({ accent, children }: { accent?: boolean; children: string }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded px-1.5 text-[12px]", accent ? "bg-accent/10 text-accent" : "bg-muted text-muted-foreground")}>{children}</span>;
}
