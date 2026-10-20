import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { onOpenOrganizationSettings, takeAgentLoginsRequest } from "@/lib/settingsLinks";
import { api, type AgentLogin, type AgentLoginConsent, type AgentLoginProvider, type AgentLoginSource, type ClaudeLoginOutcome, type CodexLoginStatus } from "@/lib/api";

/**
 * Agent logins for an organization's cloud workspaces (PRO-79): which
 * agents can run there, and connecting, replacing or disconnecting each.
 * Until now this existed only in the web console's launch dialog.
 *
 * Each organization has its own (PRO-107): this acts on the one it is given
 * by id, which need not be the active one, and says which one that is.
 *
 * Owners and admins only; the service refuses the list itself to anyone
 * else, and this says so instead of showing controls that would be refused.
 * A login is never typed into or shown by this page: an API key goes into a
 * native secure dialog, and "use this Mac's login" is read by the app, both
 * after the consent below. Once stored it is never shown again.
 *
 * "Log in with ChatGPT" runs Codex's own device-code login on this Mac, in a
 * throwaway home: the one-time code it prints is shown in a dialog here (and
 * nowhere else), and the login it writes is stored by the app, never here.
 */
const AGENTS: { id: AgentLoginProvider; name: string; local: string | null; signIn?: string; launch: string }[] = [
  // Claude has the account service's own sign-in ("Log in with Claude"): the lasting way, and so the first one offered.
  { id: "claude", name: "Claude Code", local: "Claude Code", signIn: "Claude", launch: "claude" },
  // Codex: its own device-code login, run here in a throwaway home; lending this Mac's sign-in is the second choice.
  { id: "codex", name: "Codex", local: "Codex", signIn: "ChatGPT", launch: "codex" },
  // `launch` is the agent as a workspace starts it, which is how the create check names it.
  { id: "cursor", name: "Cursor", local: null, launch: "cursor-agent" },
];

/** What a member is told about an agent: whether a workspace of theirs would get a login. Null: the service did not say. */
type MemberStatus = Partial<Record<AgentLoginProvider, boolean | null>>;

export function memberLoginStatus(agent: string, usable: boolean | null | undefined): string {
  if (usable === true) return `${agent}: a login your workspaces can use is connected.`;
  // The service answers the same way for no login and for one limited to managers, and tells a member no more.
  if (usable === false) return `${agent}: no login your workspaces can use. Either none is connected, or the one stored is limited to workspaces only owners and admins can drive.`;
  return `${agent}: the service did not say.`;
}

type Pending = { agent: AgentLoginProvider; source: AgentLoginSource | "sign-in" } | { agent: AgentLoginProvider; source: "disconnect" };

/** A sign-in that has begun: the attempt to finish, its page, and what the person agreed to when starting it. */
interface SignIn {
  attemptId: string;
  authorizeUrl: string;
  opened: boolean;
  consent: AgentLoginConsent;
  /** Someone stored a login for the agent after this sign-in began: finishing it needs the replace choice made now. */
  replaceAsked?: boolean;
}

/** A Codex sign-in that has begun: its code, what the person agreed to, and how it is going. */
export interface CodexSignIn {
  attemptId: string;
  /** Shown in the sign-in dialog and nowhere else. */
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  consent: AgentLoginConsent;
  /** `unconfirmed`: the login was sent once and the service did not confirm it; it is not sent again. */
  state: "waiting" | "complete" | "expired" | "cancelled" | "failed" | "unconfirmed";
  /** Counts the checks so far; each answer schedules the next. */
  checks: number;
  /** Someone stored a login for Codex after this sign-in began: storing it needs the replace choice made now. */
  replaceAsked?: boolean;
  /** A passing problem, or why it ended. */
  detail?: string;
  credential?: AgentLogin;
}

/** How long between checks on a Codex sign-in. */
export const CODEX_CHECK_MS = 2000;

/** The live status line of the Codex sign-in dialog. */
export function codexSignInLine(signIn: Pick<CodexSignIn, "state" | "credential" | "replaceAsked" | "consent">): { text: string; warn: boolean } {
  switch (signIn.state) {
    case "waiting":
      return signIn.replaceAsked && !signIn.consent.replaceExisting
        ? { text: "Waiting for your choice below before the login is stored.", warn: true }
        : { text: "Waiting for you to sign in to ChatGPT and enter the code…", warn: false };
    case "complete": {
      const who = signIn.credential?.displayIdentity ? ` as ${signIn.credential.displayIdentity}` : "";
      return { text: `Signed in${who}. ${connectedNotice("Codex", signIn.credential)} The account service keeps this login and renews it.`, warn: false };
    }
    case "expired":
      return { text: "This code expired before the sign-in was finished. Nothing was stored. Get a new code to try again.", warn: true };
    case "cancelled":
      return { text: "Sign-in cancelled. Nothing was stored.", warn: false };
    case "unconfirmed":
      return { text: "The account service did not confirm storing this login. Refresh to see whether Codex is connected; if it is not, get a new code.", warn: true };
    default:
      return { text: "Codex could not finish the sign-in. Nothing was stored. Get a new code to try again.", warn: true };
  }
}

const MANAGERS_ONLY = "only workspaces that nobody but owners and admins can drive";

/**
 * Who may use a login that is about to be stored. The page offers no choice
 * of scope, so the app sends none and the account service decides, and a
 * replacement never widens: a first login takes the service's default, one
 * that replaces a login of the same kind keeps that login's scope, and one
 * of another kind gets that scope or a narrower one.
 */
export function agentLoginReach(
  stored: AgentLogin | undefined,
  authKind: AgentLogin["authKind"],
  organization: string,
): { rule: "default" | "kept" | "no-wider"; lead: string; who: string; tail: string; note: string } {
  const replaced = stored && stored.state !== "disconnected" ? stored : undefined;
  const everyone = { who: "every member's", tail: ` cloud workspaces of ${organization}` };
  if (!replaced) {
    return { rule: "default", lead: "By default, agents in ", ...everyone, tail: `${everyone.tail} may run on this login.`, note: " The account service decides this, and the row above says who the login reaches once it is stored." };
  }
  const same = replaced.authKind === authKind;
  // The same kind keeps the scope exactly. Another kind keeps it or gets the service's narrower default for its kind.
  const rule = same ? "kept" : "no-wider";
  const keeps = same ? "This keeps who can use the login now: " : "This keeps who can use the login now, or fewer: at most ";
  const note = same ? "" : " The row above says who the login reaches once it is stored.";
  if (replaced.sharedUse === "managers") return { rule, lead: keeps, who: same ? MANAGERS_ONLY : "workspaces that nobody but owners and admins can drive", tail: ` in ${organization}.`, note };
  // A server from before the scope existed says nothing, and shared every login with the organization.
  if (!replaced.sharedUse || replaced.sharedUse === "organization") return { rule, lead: `${keeps}agents in `, ...everyone, tail: `${everyone.tail}.`, note };
  return { rule, lead: "This keeps ", who: same ? "who can use the login now" : "who can use the login now, or fewer", tail: `, as the account service has it for ${organization}.`, note };
}

/** What the page says once a login is stored: who it reaches, from the service's own answer when there is one. */
export function connectedNotice(agent: string, login: Pick<AgentLogin, "sharedUse"> | null | undefined): string {
  return login?.sharedUse === "managers"
    ? `${agent} is connected for this organization's cloud workspaces: ${MANAGERS_ONLY}.`
    : `${agent} is connected for this organization's cloud workspaces.`;
}

/** What to say after trying to finish a sign-in, and whether the attempt is over. */
export function signInOutcome(outcome: ClaudeLoginOutcome): { done: boolean; over: boolean; text: string } {
  switch (outcome.status) {
    case "complete":
      return { done: true, over: true, text: `${connectedNotice("Claude Code", outcome.credential)} The account service keeps this login and renews it.` };
    case "code-invalid":
      return {
        done: false,
        over: false,
        text: `Claude did not accept that code${typeof outcome.attemptsLeft === "number" ? ` (${outcome.attemptsLeft} ${outcome.attemptsLeft === 1 ? "try" : "tries"} left)` : ""}. Copy the whole code from the Claude page and enter it again.`,
      };
    case "unavailable":
      return { done: false, over: false, text: "Claude could not be reached just now. Nothing was stored; enter the code again in a moment." };
    case "pending":
      return { done: false, over: false, text: "The login is still being stored. Refresh in a moment to see it." };
    case "expired":
      return { done: false, over: true, text: "This sign-in took longer than ten minutes and expired. Nothing was stored; start it again." };
    case "canceled":
      return { done: false, over: true, text: "This sign-in was canceled. Nothing was stored." };
    default:
      return { done: false, over: true, text: "The sign-in could not be finished. Nothing was stored; start it again." };
  }
}

export function agentLoginMessage(error: unknown, agent?: AgentLoginProvider): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  switch (code) {
    case "organization_admin_required":
      return "Only an organization owner or administrator can manage agent logins.";
    case "cloud_workspace_credential_invalid":
      return "The provider did not accept that login. Nothing was changed.";
    case "cloud_workspace_credential_verification_unavailable":
      return "The login could not be checked with the provider just now. Nothing was changed; try again in a moment.";
    case "cloud_workspace_credential_in_use":
      // Refused only for a workspace whose setup names this login (the service's `remove`); a running workspace alone does not refuse.
      return "The service did not remove this login: a workspace that was created with this very login chosen for it still exists. Delete or archive that workspace first. Nothing was changed.";
    case "cloud_workspace_request_invalid":
      return "That is not a login this agent can use. Nothing was changed.";
    case "cloud_agent_local_login_not_found":
      return "No login for this agent was found on this Mac. Sign in with the agent's own CLI first, or use an API key.";
    case "cloud_agent_local_login_invalid":
      return "The login found on this Mac is not one the service can use. Sign in again with the agent's own CLI, or use an API key.";
    case "cloud_agent_local_login_expired":
      return agent === "codex"
        ? "The Codex sign-in on this Mac has expired or is about to. Run codex once so it renews, then try again."
        : "The Claude Code sign-in on this Mac has expired or is about to. Run claude once so it renews, then try again.";
    case "cloud_agent_codex_cli_missing":
      return "Codex is not installed on this Mac, so its sign-in cannot run here. Install Codex, or connect with an API key.";
    case "cloud_agent_codex_cli_untrusted":
      return "The codex found on this Mac, or the node it runs on, could be changed by another account on it (it, or its folder, is writable by others), so it was not run. Fix the permissions, or connect with an API key.";
    case "cloud_agent_codex_login_unavailable":
      return "Codex could not start a sign-in just now; it needs to reach OpenAI. Nothing was stored; try again in a moment.";
    case "cloud_agent_local_login_cancelled":
      return "Canceled in the confirmation. Nothing was sent.";
    case "cloud_agent_login_flow_unavailable":
      return "This server does not offer Log in with Claude yet. Use an API key, or lend this Mac's sign-in.";
    case "cloud_agent_login_attempt_gone":
      return "That sign-in is no longer open. Nothing was stored; start it again.";
    case "cloud_workspace_rate_limited":
      return "Too many sign-ins were started in a short time. Wait a while, then try again.";
    case "cloud_agent_login_replace_unconfirmed":
      return "A login is already stored for this agent. Choose to replace it, then try again. Nothing was changed.";
    case "cloud_agent_local_login_denied":
      return "This Mac's login was not read: access to it was not allowed. Nothing was sent.";
    case "cloud_provider_entry_cancelled":
      return "Key entry canceled. Nothing was changed.";
    case "cloud_provider_credential_required":
      return "No key was entered. Nothing was changed.";
    case "cloud_provider_secure_input_unavailable":
      return "The secure key dialog is not available on this computer. Use the web console to enter a key.";
    case "cloud_provider_operation_in_progress":
      return "Another login is being saved. Finish or cancel it first.";
    case "account_context_changed":
      return "The account or organization changed. Refresh before trying again.";
    // PRO-107: a server that keeps agent logins on the active organization, or one this Mac can only reach while active.
    case "active_organization_required":
      return "This server changes an organization's agent logins only while it is the active organization. Make it the active organization, then try again. Nothing was changed.";
    case "cloud_organization_unavailable":
      return "This organization's agent logins can't be reached from here: you may no longer be a member, or this server works only in the active organization. Refresh, or make it the active organization.";
    default:
      return "The request could not be confirmed. Refresh to see what is stored, then try again.";
  }
}

/**
 * A sign-in lent from a Mac says when it stops working in its name
 * ("ada@example.com · lent until 2026-10-03T21:40:00Z"), since the service
 * has no field for it. Null for any other login.
 */
export function lentUntil(login: Pick<AgentLogin, "displayIdentity"> | undefined): { who: string; at: number } | null {
  const match = /^(.*) · lent until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(login?.displayIdentity ?? "");
  const at = match ? Date.parse(match[2]) : NaN;
  return match && Number.isFinite(at) ? { who: match[1], at } : null;
}

function remaining(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** What the row says about a login, and whether it needs attention. */
export function agentLoginStatus(login: AgentLogin | undefined, now = Date.now()): { text: string; warn: boolean } {
  if (!login || login.state === "disconnected") return { text: "Not connected", warn: false };
  const lent = lentUntil(login);
  const how = login.authKind === "api-key" ? "API key" : lent ? "sign-in lent from a Mac" : "subscription login";
  const who = lent ? ` · ${lent.who}` : login.displayIdentity ? ` · ${login.displayIdentity}` : "";
  if (login.state === "revoked") return { text: `Revoked (${how}${who}): workspaces no longer receive it. Replace it to use this agent again.`, warn: true };
  // The service still calls an expired lend connected; the time in its name says otherwise.
  if (lent && lent.at <= now) {
    return { text: `Expired ${new Date(lent.at).toLocaleString()} (${how}${who}): agents can no longer sign in with it. Connect a login again.`, warn: true };
  }
  // The service's rule for this scope is about who can drive a workspace, not who created it.
  const scope = login.sharedUse === "managers" ? ` · ${MANAGERS_ONLY}` : "";
  if (lent) return { text: `Connected · ${how}${who}${scope} · expires in ${remaining(lent.at - now)} (${new Date(lent.at).toLocaleString()})`, warn: lent.at - now < 60 * 60_000 };
  return { text: `Connected · ${how}${who}${scope} · updated ${new Date(login.updatedAt).toLocaleDateString()}`, warn: false };
}

/** Whether a workspace's agent can sign in with this login now: stored, not revoked, and not a lent sign-in past its expiry. */
export function agentLoginUsable(login: AgentLogin | undefined, now = Date.now()): boolean {
  if (!login || login.state === "disconnected" || login.state === "revoked") return false;
  const lent = lentUntil(login);
  return !lent || lent.at > now;
}

/**
 * The service says the person who connected this login no longer owns or
 * administers the organization. The login is kept (the owner's decision),
 * so the row says so and how to take it over.
 */
export function agentLoginConfigurerLeft(login: AgentLogin | undefined): boolean {
  return login?.configurerLeft === true && login.state === "connected";
}

/**
 * The Codex sign-in: the one-time code, large and copyable, the button that
 * opens OpenAI's page and copies the code, and a status line that follows
 * the sign-in. The code is shown here and nowhere else.
 */
export function CodexSignInDialog({
  signIn,
  organization = "this organization",
  busy,
  onOpenPage,
  onCancel,
  onRestart,
  onClose,
  onReplace,
}: {
  signIn: CodexSignIn;
  /** The organization the login is for, by name. */
  organization?: string;
  busy: boolean;
  onOpenPage: () => void;
  onCancel: () => void;
  onRestart: () => void;
  onClose: () => void;
  onReplace: (replace: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const waiting = signIn.state === "waiting";
  const line = codexSignInLine(signIn);
  const copy = () =>
    void navigator.clipboard?.writeText(signIn.userCode).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  return (
    <Dialog open onOpenChange={(open) => !open && (waiting ? onCancel() : onClose())}>
      <DialogContent width="max-w-[28rem]" showClose={false} data-testid="codex-sign-in">
        <DialogHeader>
          <DialogTitle>Log in with ChatGPT</DialogTitle>
          <DialogDescription>
            {waiting
              ? `Open OpenAI's page, sign in to ChatGPT and enter this code. It works for ${Math.round(signIn.expiresInSeconds / 60)} minutes. Enter it only because you started this sign-in here; if someone else gave you a code, cancel.`
              : `Codex's own sign-in, run on this Mac for the cloud workspaces of ${organization}.`}
          </DialogDescription>
        </DialogHeader>
        {waiting && (
          <div className="flex flex-col items-center gap-3">
            <output
              aria-label="One-time code"
              className="select-all rounded-lg bg-well px-4 py-3 font-mono text-3xl font-semibold tracking-widest"
              data-testid="codex-sign-in-code"
            >
              {signIn.userCode}
            </output>
            <div className="flex flex-wrap justify-center gap-1.5">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  copy();
                  onOpenPage();
                }}
              >
                Open the ChatGPT page and copy the code
              </Button>
              <Button size="sm" variant="outline" onClick={copy}>
                {copied ? "Copied" : "Copy code"}
              </Button>
            </div>
            {/* Where the code goes, as the CLI printed it: visible, and there to open again if the browser tab was closed. */}
            <p className="text-xs text-muted-foreground" data-testid="codex-sign-in-page">
              Enter the code at{" "}
              <a
                href={signIn.verificationUrl}
                className="inline-flex items-center gap-1 break-all text-foreground underline underline-offset-2"
                onClick={(event) => {
                  // Never in this window: the app opens it in the default browser.
                  event.preventDefault();
                  onOpenPage();
                }}
              >
                {signIn.verificationUrl}
                <ExternalLink aria-hidden className="size-3 shrink-0" />
              </a>
            </p>
          </div>
        )}
        {signIn.replaceAsked && waiting && (
          <label className="mt-3 flex items-start gap-2 rounded-md border border-destructive/25 p-2 text-xs" data-testid="agent-login-replace">
            <input type="checkbox" checked={signIn.consent.replaceExisting} disabled={busy} onChange={(event) => onReplace(event.target.checked)} />
            <span>
              <strong>Replace the login now stored for Codex.</strong> It was stored after this sign-in began. The organization has one login per
              agent, so finishing this sign-in removes it.
            </span>
          </label>
        )}
        <p role="status" aria-live="polite" className={`mt-3 text-xs ${line.warn ? "text-warning" : "text-muted-foreground"}`} data-testid="codex-sign-in-status">
          {waiting && !signIn.replaceAsked && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />}
          {line.text}
        </p>
        {signIn.detail && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {signIn.detail}
          </p>
        )}
        <DialogFooter>
          {waiting ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <>
              {signIn.state !== "complete" && (
                <Button size="sm" disabled={busy} onClick={onRestart}>
                  {busy && <Loader2 className="animate-spin" />}
                  Get a new code
                </Button>
              )}
              <Button size="sm" variant={signIn.state === "complete" ? "default" : "ghost"} disabled={busy} onClick={onClose}>
                {signIn.state === "complete" ? "Done" : "Close"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrganizationAgentLogins({
  contextRevision,
  organizationId,
  organizationName,
  reveal: revealOnRequest = true,
  onLogins,
}: {
  contextRevision: string;
  /** The organization whose logins these are: any one the person belongs to (PRO-107). */
  organizationId: string;
  organizationName?: string | null;
  /** Come into view when a message elsewhere asks for this organization's logins. Off where another section of the page shows them too. */
  reveal?: boolean;
  /** Each time the list is read: the logins, or null when they could not be listed (refused to a member, or failed). */
  onLogins?: (logins: AgentLogin[] | null) => void;
}) {
  const organization = organizationName?.trim() || "this organization";
  const reported = useRef(onLogins);
  reported.current = onLogins;
  const [logins, setLogins] = useState<AgentLogin[] | null>(null);
  const [adminOnly, setAdminOnly] = useState(false);
  const [memberStatus, setMemberStatus] = useState<MemberStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [sharing, setSharing] = useState(false);
  const [machines, setMachines] = useState(false);
  const [replace, setReplace] = useState(false);
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  const [codex, setCodex] = useState<CodexSignIn | null>(null);
  // An expiry shown as "in 3 h" is re-read every minute, so it turns to Expired without a refresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const epoch = useRef(0);
  // A message elsewhere sent the person here: the section comes into view, again once its rows have loaded.
  const section = useRef<HTMLDivElement>(null);
  const revealing = useRef(false);
  useEffect(() => {
    if (!revealOnRequest) return;
    const reveal = () => {
      if (takeAgentLoginsRequest(organizationId)) revealing.current = true;
      if (!revealing.current) return;
      section.current?.scrollIntoView?.({ block: "start" });
      if (!loading) revealing.current = false;
    };
    reveal();
    return onOpenOrganizationSettings(reveal);
  }, [loading, organizationId, revealOnRequest]);

  const load = useCallback(async () => {
    const request = ++epoch.current;
    setLoading(true);
    try {
      const result = await api.cloudAgentLogins(organizationId);
      if (request !== epoch.current) return;
      // A reload after a failed save keeps that failure's message on screen.
      setLogins(result.credentials);
      setAdminOnly(false);
      reported.current?.(result.credentials);
    } catch (failure) {
      if (request !== epoch.current) return;
      setLogins(null);
      reported.current?.(null);
      const refused = !!failure && typeof failure === "object" && "code" in failure && failure.code === "organization_admin_required";
      setAdminOnly(refused);
      setError(refused ? null : agentLoginMessage(failure));
      if (refused) {
        // The list is refused to a member. The create check is not: it answers, per agent and with no
        // identity, whether a workspace this person creates would get a login.
        const answers = await Promise.all(
          AGENTS.map(async (agent) => {
            try {
              const preflight = await api.cloudWorkspacePreflight([], organizationId, agent.launch);
              // Only a check that names this agent counts: an older service answers about the setup, not the organization's logins.
              const check = preflight.checks.find((candidate) => candidate.kind === "agent-credential" && candidate.agent === agent.launch);
              return [agent.id, check ? check.status === "verified" : null] as const;
            } catch {
              return [agent.id, null] as const;
            }
          }),
        );
        if (request === epoch.current) setMemberStatus(Object.fromEntries(answers));
      }
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
    };
  }, [load, contextRevision]);

  const choose = (next: Pending | null) => {
    setPending(next);
    setSharing(false);
    setMachines(false);
    setReplace(false);
    setError(null);
    setNotice(null);
  };

  /** Begin "Log in with Claude": the app opens the provider's page; the panel then asks for the code it shows. */
  const startSignIn = async (stored: boolean) => {
    if (busy) return;
    const consent: AgentLoginConsent = { contextRevision, organizationSharing: sharing, machineInstallation: machines, replaceExisting: stored && replace, organizationId };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const started = await api.cloudAgentClaudeLoginStart(consent);
      setSignIn({ attemptId: started.attemptId, authorizeUrl: started.authorizeUrl, opened: started.opened, consent });
    } catch (failure) {
      setError(agentLoginMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  /** Finish it: a native dialog takes the code, and the answer says whether a login was stored. */
  const finishSignIn = async () => {
    if (busy || !signIn) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = signInOutcome(await api.cloudAgentClaudeLoginComplete(signIn.attemptId, signIn.consent));
      if (result.over) {
        setSignIn(null);
        setPending(null);
      }
      await load();
      if (result.done) setNotice(result.text);
      else setError(result.text);
    } catch (failure) {
      const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
      if (code === "cloud_agent_login_attempt_gone") {
        setSignIn(null);
        setPending(null);
      }
      if (code === "cloud_agent_login_replace_unconfirmed") {
        // A login was stored for this agent while the sign-in was open. The sign-in stays; the choice is asked for here.
        setSignIn({ ...signIn, replaceAsked: true });
        await load();
        setError("A login was stored for this agent after you started. Choose to replace it below, then enter the code again. Nothing was changed.");
      } else {
        setError(agentLoginMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelSignIn = async () => {
    if (busy || !signIn) return;
    setBusy(true);
    // Best effort: the attempt expires by itself in ten minutes if this does not reach the service.
    await api.cloudAgentClaudeLoginCancel(signIn.attemptId, contextRevision, organizationId).catch(() => undefined);
    setSignIn(null);
    choose(null);
    setBusy(false);
  };

  /** Begin "Log in with ChatGPT": Codex's own sign-in starts on this Mac and its code is shown in the dialog. */
  const startCodexSignIn = async (consent: AgentLoginConsent) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const started = await api.cloudAgentCodexLoginStart(consent);
      setCodex({ ...started, consent, state: "waiting", checks: 0 });
    } catch (failure) {
      const message = agentLoginMessage(failure, "codex");
      // A new code asked for from the dialog says why there is none in the dialog; the first one, on the page.
      setCodex((current) => (current ? { ...current, detail: message } : current));
      if (!codex) setError(message);
    } finally {
      setBusy(false);
    }
  };

  const applyCodexStatus = useCallback(
    (attemptId: string, result: CodexLoginStatus) => {
      const over = ["complete", "expired", "cancelled", "failed", "unconfirmed"] as const;
      const state: CodexSignIn["state"] = over.find((status) => status === result.status) ?? "waiting";
      const detail = state === "unconfirmed" && result.errorCode ? agentLoginMessage({ code: result.errorCode }, "codex") : undefined;
      setCodex((current) =>
        current?.attemptId === attemptId ? { ...current, state, checks: current.checks + 1, detail, credential: result.credential } : current,
      );
      if (state === "unconfirmed") void load();
      if (state === "complete") {
        setPending(null);
        void load().then(() => setNotice(`${connectedNotice("Codex", result.credential)} The account service keeps this login and renews it.`));
      }
    },
    [load],
  );

  // While the code is shown, ask how the sign-in is going; once Codex has finished, that stores the login.
  useEffect(() => {
    if (!codex || codex.state !== "waiting" || (codex.replaceAsked && !codex.consent.replaceExisting)) return;
    let stopped = false;
    const { attemptId, consent } = codex;
    const timer = setTimeout(() => {
      api.cloudAgentCodexLoginStatus(attemptId, consent).then(
        (result) => {
          if (!stopped) applyCodexStatus(attemptId, result);
        },
        (failure: unknown) => {
          if (stopped) return;
          const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
          setCodex((current) => {
            if (current?.attemptId !== attemptId) return current;
            if (code === "cloud_agent_login_replace_unconfirmed") {
              // A login was stored for Codex while the code was shown. The sign-in stays; the choice is asked for here.
              return { ...current, replaceAsked: true, checks: current.checks + 1, detail: "A login was stored for Codex after you started. Choose to replace it below, or cancel. Nothing was changed." };
            }
            if (code === "cloud_agent_login_attempt_gone" || code === "account_context_changed") {
              return { ...current, state: "failed", detail: agentLoginMessage(failure, "codex") };
            }
            // Anything else may pass: say so, and check again.
            return { ...current, checks: current.checks + 1, detail: agentLoginMessage(failure, "codex") };
          });
          if (code === "cloud_agent_login_replace_unconfirmed") void load();
        },
      );
    }, CODEX_CHECK_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [codex, applyCodexStatus, load]);

  // Leaving Settings with a code shown cancels the sign-in: Codex is stopped on this Mac and its home wiped.
  const openCodex = useRef<string | null>(null);
  openCodex.current = codex?.state === "waiting" ? codex.attemptId : null;
  useEffect(
    () => () => {
      if (openCodex.current) void api.cloudAgentCodexLoginCancel(openCodex.current).catch(() => undefined);
    },
    [],
  );

  const cancelCodexSignIn = async () => {
    if (!codex) return;
    const { attemptId } = codex;
    // The CLI is stopped and its throwaway home wiped on this Mac; nothing was stored.
    await api.cloudAgentCodexLoginCancel(attemptId).catch(() => undefined);
    setCodex((current) => (current?.attemptId === attemptId ? { ...current, state: "cancelled", detail: undefined } : current));
  };

  const closeCodexSignIn = () => {
    const done = codex?.state === "complete";
    setCodex(null);
    if (done) setPending(null);
  };

  const run = async <T,>(action: () => Promise<T>, done: string | ((result: T) => string), agent?: AgentLoginProvider) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      setPending(null);
      await load();
      setNotice(typeof done === "string" ? done : done(result));
    } catch (failure) {
      setError(agentLoginMessage(failure, agent));
      await load();
    } finally {
      setBusy(false);
      setSharing(false);
      setMachines(false);
      setReplace(false);
    }
  };

  return (
    <div ref={section} className="rounded-lg border border-hairline p-3" data-testid="agent-logins">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium" data-testid="agent-logins-title">
          Agent logins for {organization}
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh agent logins" disabled={loading || busy}
          onClick={() => {
            setError(null);
            setNotice(null);
            void load();
          }}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        What the agents in the cloud workspaces of {organization} sign in with: one login per agent, for this organization only. A login is
        stored encrypted by the account service and is never shown again; workspace machines only ever receive short-lived access made from it.
      </p>

      {loading && !logins && !adminOnly ? (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading agent logins…
        </p>
      ) : adminOnly ? (
        <div className="mt-2 text-xs text-muted-foreground" data-testid="agent-logins-member">
          <p>
            Organization owners and administrators connect agent logins. If an agent in a cloud workspace says it needs to sign in, an admin can
            connect it here.
          </p>
          {memberStatus && (
            <ul className="mt-2 flex flex-col gap-1">
              {AGENTS.map((agent) => (
                <li key={agent.id} className={memberStatus[agent.id] === false ? "text-warning" : undefined} data-testid="agent-login-member-status" data-agent={agent.id}>
                  {memberLoginStatus(agent.name, memberStatus[agent.id])}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        logins && (
          <ul className="mt-2 flex flex-col gap-2 text-xs">
            {AGENTS.map((agent) => {
              const login = logins.find((candidate) => candidate.provider === agent.id);
              const stored = !!login && login.state !== "disconnected";
              const status = agentLoginStatus(login, now);
              const storedKind = login?.authKind === "api-key" ? "API key" : "login";
              const open = pending?.agent === agent.id ? pending : null;
              // An API key is one kind of login; the sign-in and the lent sign-in are the other.
              const reach = open && open.source !== "disconnect" ? agentLoginReach(login, open.source === "api-key" ? "api-key" : "oauth-credentials-json", organization) : null;
              return (
                <li key={agent.id} className="rounded-md bg-well p-2" data-testid="agent-login" data-agent={agent.id}>
                  {/* The status has the row's full width; the actions go under it, so neither squeezes the other. */}
                  <div className="flex flex-col gap-1.5">
                    <div className="min-w-0">
                      <div className="font-medium">{agent.name}</div>
                      <div className={status.warn ? "text-warning" : "text-muted-foreground"} data-testid="agent-login-status">
                        {status.text}
                      </div>
                      {agentLoginConfigurerLeft(login) && (
                        <div className="mt-1 text-warning" data-testid="agent-login-configurer-left">
                          The person who connected this login is no longer an owner or admin of {organization}. It keeps working, on their subscription.
                          To take it over, {agent.signIn ? `log in with ${agent.signIn} again` : "connect a login again"}: that replaces it with a login of
                          your own.
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {agent.signIn && (
                        <Button size="xs" disabled={busy || !!signIn || !!codex} onClick={() => choose({ agent: agent.id, source: "sign-in" })}>
                          {stored ? `Replace by logging in with ${agent.signIn}` : `Log in with ${agent.signIn}`}
                        </Button>
                      )}
                      <Button size="xs" variant="outline" disabled={busy || !!signIn || !!codex} onClick={() => choose({ agent: agent.id, source: "api-key" })}>
                        {stored ? "Replace with an API key" : "Connect with an API key"}
                      </Button>
                      {agent.local && (
                        <Button size="xs" variant="outline" disabled={busy || !!signIn || !!codex} onClick={() => choose({ agent: agent.id, source: "local-login" })}>
                          {stored ? `Replace with this Mac's ${agent.local} sign-in (temporary)` : `Lend this Mac's ${agent.local} sign-in (temporary)`}
                        </Button>
                      )}
                      {stored && (
                        <Button size="xs" variant="ghost" disabled={busy || !!signIn || !!codex} onClick={() => choose({ agent: agent.id, source: "disconnect" })}>
                          Disconnect
                        </Button>
                      )}
                    </div>
                  </div>

                  {open?.source === "sign-in" && signIn && (
                    <div className="mt-2 space-y-2 rounded-md border border-hairline bg-background p-2" data-testid="agent-login-code">
                      <p>
                        {signIn.opened ? "The Claude page opened in your browser." : "The Claude page could not be opened by itself; open it with the button below."} Sign
                        in and approve there. Claude then shows a code: copy it, come back and press Enter the code. The sign-in stays open for ten minutes.
                      </p>
                      {signIn.replaceAsked && (
                        <label className="flex items-start gap-2 rounded-md border border-destructive/25 p-2" data-testid="agent-login-replace">
                          <input
                            type="checkbox"
                            checked={signIn.consent.replaceExisting}
                            disabled={busy}
                            onChange={(event) => setSignIn({ ...signIn, consent: { ...signIn.consent, replaceExisting: event.target.checked } })}
                          />
                          <span>
                            <strong>Replace the {storedKind} now stored for {agent.name}.</strong> It was stored after this sign-in began. The organization
                            has one login per agent, so finishing this sign-in removes it.
                          </span>
                        </label>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="xs" disabled={busy || (!!signIn.replaceAsked && !signIn.consent.replaceExisting)} onClick={() => void finishSignIn()}>
                          {busy && <Loader2 className="animate-spin" />}
                          Enter the code
                        </Button>
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => void api.cloudAgentClaudeLoginOpen(signIn.authorizeUrl).catch((failure: unknown) => setError(agentLoginMessage(failure)))}>
                          Open the page again
                        </Button>
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void cancelSignIn()}>
                          Cancel sign-in
                        </Button>
                      </div>
                    </div>
                  )}

                  {open && open.source !== "disconnect" && !(open.source === "sign-in" && (signIn || codex)) && (
                    <div className="mt-2 space-y-2 rounded-md border border-hairline bg-background p-2" data-testid="agent-login-consent">
                      <p>
                        {open.source === "sign-in" && agent.id === "codex"
                          ? `Codex's own sign-in runs on this Mac in a separate, temporary home, so the Codex login you use here is not touched. TerminalX shows a one-time code; you sign in to ChatGPT in your browser, enter the code and approve access for ${organization}. The login Codex receives goes to the account service, which stores it encrypted and keeps it working, and the temporary home is deleted. It is your own subscription: usage in these workspaces counts against it. If you later leave the organization, the login stays until an owner or admin disconnects it.`
                          : open.source === "sign-in"
                          ? `You sign in to Claude in your browser and approve access for ${organization}. The account service receives a login it can renew, stores it encrypted and keeps it working; nothing is read from this Mac. It is your own subscription: usage in these workspaces counts against it. If you later leave the organization, the login stays until an owner or admin disconnects it.`
                          : open.source === "local-login"
                          ? `TerminalX will read the ${agent.name} sign-in on this Mac and lend its short-lived access token to ${organization}. The refresh token stays on this Mac, so what is uploaded cannot be renewed: it stops working when it expires, usually within hours, and has to be lent again. Before anything is sent, a confirmation from the app names the organization, the account and the expiry. It is your own subscription: usage in these workspaces counts against it.`
                          : `A secure dialog will ask for the ${agent.name} API key for ${organization}. It is sent to the account service, which checks it with the provider and stores it encrypted.`}
                      </p>
                      {stored && (
                        <label className="flex items-start gap-2 rounded-md border border-destructive/25 p-2" data-testid="agent-login-replace">
                          <input type="checkbox" checked={replace} disabled={busy} onChange={(event) => setReplace(event.target.checked)} />
                          <span>
                            <strong>Replace the {storedKind} now stored for {agent.name}.</strong> The organization has one login per agent, so this removes
                            it.
                            {open.source === "local-login" &&
                              ` When the lent sign-in expires, ${agent.name} agents in every workspace of ${organization} stop until a login is connected again.`}
                          </span>
                        </label>
                      )}
                      <label className="flex items-start gap-2">
                        <input type="checkbox" checked={sharing} disabled={busy} onChange={(event) => setSharing(event.target.checked)} />
                        <span data-testid="agent-login-reach">
                          {reach?.lead}
                          <strong>{reach?.who}</strong>
                          {reach?.tail}
                          {reach?.note}
                        </span>
                      </label>
                      <label className="flex items-start gap-2">
                        <input type="checkbox" checked={machines} disabled={busy} onChange={(event) => setMachines(event.target.checked)} />
                        <span>
                          Short-lived access made from it is installed on those workspace machines, where anyone who can drive a workspace can read it.
                        </span>
                      </label>
                      <p className="text-muted-foreground">
                        To end it, press Disconnect here. That reaches every workspace of {organization}, running ones included: their agents need a
                        sign-in again once the access already handed to a machine runs out, which lasts until its own expiry. Disconnecting does not sign
                        you out at the provider.
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          size="xs"
                          disabled={busy || !sharing || !machines || (stored && !replace)}
                          onClick={() =>
                            open.source === "sign-in" && agent.id === "codex"
                              ? void startCodexSignIn({ contextRevision, organizationSharing: sharing, machineInstallation: machines, replaceExisting: stored && replace, organizationId })
                              : open.source === "sign-in"
                              ? void startSignIn(stored)
                              : void run(
                              () =>
                                api.cloudAgentLoginConnect(agent.id, open.source as AgentLoginSource, {
                                  contextRevision,
                                  organizationSharing: sharing,
                                  machineInstallation: machines,
                                  replaceExisting: stored && replace,
                                  organizationId,
                                }),
                              (saved) => connectedNotice(agent.name, saved),
                              agent.id,
                            )
                          }
                        >
                          {busy && <Loader2 className="animate-spin" />}
                          {open.source === "sign-in" ? (agent.id === "codex" ? "Get a code to sign in with ChatGPT" : "Open Claude to sign in") : open.source === "local-login" ? "Read this Mac's sign-in and confirm" : "Enter the key"}
                        </Button>
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => choose(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {open?.source === "disconnect" && (
                    <div className="mt-2 space-y-2 rounded-md border border-destructive/25 bg-background p-2" data-testid="agent-login-disconnect">
                      <p>
                        Disconnect {agent.name} from {organization}? The stored login is removed and {agent.name} agents will need a sign-in before they
                        can work again. This reaches every workspace of {organization}, running ones included: nothing is stopped, and access already handed to a machine
                        lasts until its own expiry. The service refuses only while a workspace that was created with this very login chosen for it still
                        exists. Disconnecting does not sign the account out at the provider.
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          size="xs"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => void run(() => api.cloudAgentLoginRemove(agent.id, contextRevision, organizationId), `${agent.name} is disconnected from ${organization}.`)}
                        >
                          {busy && <Loader2 className="animate-spin" />}
                          Disconnect {agent.name}
                        </Button>
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => choose(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )
      )}

      {codex && (
        <CodexSignInDialog
          signIn={codex}
          organization={organization}
          busy={busy}
          onOpenPage={() =>
            void api.cloudAgentCodexLoginOpen(codex.attemptId).catch((failure: unknown) => setCodex((current) => (current ? { ...current, detail: agentLoginMessage(failure, "codex") } : current)))
          }
          onCancel={() => void cancelCodexSignIn()}
          onRestart={() => void startCodexSignIn(codex.consent)}
          onClose={closeCodexSignIn}
          onReplace={(replaceExisting) => setCodex((current) => (current ? { ...current, consent: { ...current.consent, replaceExisting } } : current))}
        />
      )}

      {notice && !error && (
        <p role="status" className="mt-2 text-xs text-muted-foreground" data-testid="agent-logins-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
