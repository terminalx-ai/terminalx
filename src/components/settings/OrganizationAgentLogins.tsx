import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type AgentLogin, type AgentLoginProvider, type AgentLoginSource } from "@/lib/api";

/**
 * Agent logins for the organization's cloud workspaces (PRO-79): which
 * agents can run there, and connecting, replacing or disconnecting each.
 * Until now this existed only in the web console's launch dialog.
 *
 * Owners and admins only; the service refuses the list itself to anyone
 * else, and this says so instead of showing controls that would be refused.
 * A login is never typed into or shown by this page: an API key goes into a
 * native secure dialog, and "use this Mac's login" is read by the app, both
 * after the consent below. Once stored it is never shown again.
 */
const AGENTS: { id: AgentLoginProvider; name: string; local: string | null }[] = [
  { id: "claude", name: "Claude Code", local: "Claude Code" },
  // Codex's own login cannot be used without its refresh token, which must not leave this Mac: no local option.
  { id: "codex", name: "Codex", local: null },
  { id: "cursor", name: "Cursor", local: null },
];

type Pending = { agent: AgentLoginProvider; source: AgentLoginSource } | { agent: AgentLoginProvider; source: "disconnect" };

export function agentLoginMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  switch (code) {
    case "organization_admin_required":
      return "Only an organization owner or administrator can manage agent logins.";
    case "cloud_workspace_credential_invalid":
      return "The provider did not accept that login. Nothing was changed.";
    case "cloud_workspace_credential_verification_unavailable":
      return "The login could not be checked with the provider just now. Nothing was changed; try again in a moment.";
    case "cloud_workspace_credential_in_use":
      return "The service did not remove this login: a workspace of this organization still uses it. Delete or archive those workspaces first, or revoke the login in the web console. Nothing was changed.";
    case "cloud_workspace_request_invalid":
      return "That is not a login this agent can use. Nothing was changed.";
    case "cloud_agent_local_login_not_found":
      return "No login for this agent was found on this Mac. Sign in with the agent's own CLI first, or use an API key.";
    case "cloud_agent_local_login_invalid":
      return "The login found on this Mac is not one the service can use. Sign in again with the agent's own CLI, or use an API key.";
    case "cloud_agent_local_login_expired":
      return "The Claude Code sign-in on this Mac has expired or is about to. Run claude once so it renews, then try again.";
    case "cloud_agent_local_login_cancelled":
      return "Canceled in the confirmation. Nothing was sent.";
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
    default:
      return "The request could not be confirmed. Refresh to see what is stored, then try again.";
  }
}

function statusLine(login: AgentLogin | undefined): string {
  if (!login || login.state === "disconnected") return "Not connected";
  const how = login.authKind === "api-key" ? "API key" : "subscription login";
  const who = login.displayIdentity ? ` · ${login.displayIdentity}` : "";
  if (login.state === "revoked") return `Revoked (${how}${who}): workspaces no longer receive it. Replace it to use this agent again.`;
  const scope = login.sharedUse === "managers" ? " · only workspaces created by owners and admins" : "";
  return `Connected · ${how}${who}${scope} · updated ${new Date(login.updatedAt).toLocaleDateString()}`;
}

export function OrganizationAgentLogins({ contextRevision, organizationName }: { contextRevision: string; organizationName?: string | null }) {
  const organization = organizationName?.trim() || "this organization";
  const [logins, setLogins] = useState<AgentLogin[] | null>(null);
  const [adminOnly, setAdminOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [sharing, setSharing] = useState(false);
  const [machines, setMachines] = useState(false);
  const epoch = useRef(0);

  const load = useCallback(async () => {
    const request = ++epoch.current;
    setLoading(true);
    try {
      const result = await api.cloudAgentLogins();
      if (request !== epoch.current) return;
      // A reload after a failed save keeps that failure's message on screen.
      setLogins(result.credentials);
      setAdminOnly(false);
    } catch (failure) {
      if (request !== epoch.current) return;
      setLogins(null);
      const refused = !!failure && typeof failure === "object" && "code" in failure && failure.code === "organization_admin_required";
      setAdminOnly(refused);
      setError(refused ? null : agentLoginMessage(failure));
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }, []);

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
    setError(null);
    setNotice(null);
  };

  const run = async (action: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setPending(null);
      await load();
      setNotice(done);
    } catch (failure) {
      setError(agentLoginMessage(failure));
      await load();
    } finally {
      setBusy(false);
      setSharing(false);
      setMachines(false);
    }
  };

  return (
    <div className="rounded-lg border border-hairline p-3" data-testid="agent-logins">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Agent logins</div>
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
        What the agents in this organization's cloud workspaces sign in with. A login is stored encrypted by the account service and is never shown
        again; workspace machines only ever receive short-lived access made from it.
      </p>

      {loading && !logins && !adminOnly ? (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading agent logins…
        </p>
      ) : adminOnly ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="agent-logins-member">
          Organization owners and administrators connect agent logins. If an agent in a cloud workspace says it needs to sign in, an admin can connect
          it here.
        </p>
      ) : (
        logins && (
          <ul className="mt-2 flex flex-col gap-2 text-xs">
            {AGENTS.map((agent) => {
              const login = logins.find((candidate) => candidate.provider === agent.id);
              const stored = !!login && login.state !== "disconnected";
              const open = pending?.agent === agent.id ? pending : null;
              return (
                <li key={agent.id} className="rounded-md bg-well p-2" data-testid="agent-login" data-agent={agent.id}>
                  {/* The status has the row's full width; the actions go under it, so neither squeezes the other. */}
                  <div className="flex flex-col gap-1.5">
                    <div className="min-w-0">
                      <div className="font-medium">{agent.name}</div>
                      <div className={login?.state === "revoked" ? "text-warning" : "text-muted-foreground"} data-testid="agent-login-status">
                        {statusLine(login)}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="xs" variant="outline" disabled={busy} onClick={() => choose({ agent: agent.id, source: "api-key" })}>
                        {stored ? "Replace with an API key" : "Connect with an API key"}
                      </Button>
                      {agent.local && (
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => choose({ agent: agent.id, source: "local-login" })}>
                          Use this Mac's {agent.local} login
                        </Button>
                      )}
                      {stored && (
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => choose({ agent: agent.id, source: "disconnect" })}>
                          Disconnect
                        </Button>
                      )}
                    </div>
                  </div>

                  {open && open.source !== "disconnect" && (
                    <div className="mt-2 space-y-2 rounded-md border border-hairline bg-background p-2" data-testid="agent-login-consent">
                      <p>
                        {open.source === "local-login"
                          ? `TerminalX will read the ${agent.name} sign-in on this Mac and lend its short-lived access token to ${organization}. The refresh token stays on this Mac, so what is uploaded cannot be renewed: it stops working when it expires, usually within hours, and has to be lent again. Before anything is sent, a confirmation from the app names the organization, the account and the expiry. It is your own subscription: usage in these workspaces counts against it.`
                          : `A secure dialog will ask for the ${agent.name} API key for ${organization}. It is sent to the account service, which checks it with the provider and stores it encrypted.`}
                      </p>
                      <label className="flex items-start gap-2">
                        <input type="checkbox" checked={sharing} disabled={busy} onChange={(event) => setSharing(event.target.checked)} />
                        <span>
                          Agents in <strong>every member's</strong> cloud workspaces of {organization} may run on this login.
                        </span>
                      </label>
                      <label className="flex items-start gap-2">
                        <input type="checkbox" checked={machines} disabled={busy} onChange={(event) => setMachines(event.target.checked)} />
                        <span>
                          Short-lived access made from it is installed on those workspace machines, where anyone who can drive a workspace can read it.
                        </span>
                      </label>
                      <p className="text-muted-foreground">
                        To end it, press Disconnect here. The service refuses while a workspace of the organization still uses the login; delete or archive
                        those first, or revoke it in the web console. Access already handed to a machine lasts until its own expiry.
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          size="xs"
                          disabled={busy || !sharing || !machines}
                          onClick={() =>
                            void run(
                              () =>
                                api.cloudAgentLoginConnect(agent.id, open.source as AgentLoginSource, {
                                  contextRevision,
                                  organizationSharing: sharing,
                                  machineInstallation: machines,
                                }),
                              `${agent.name} is connected for this organization's cloud workspaces.`,
                            )
                          }
                        >
                          {busy && <Loader2 className="animate-spin" />}
                          {open.source === "local-login" ? "Read this Mac's sign-in and confirm" : "Enter the key"}
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
                        Disconnect {agent.name}? The stored login is removed and {agent.name} agents will need a sign-in before they can work again. The
                        service refuses while a workspace of the organization still uses the login. Access already handed to a machine lasts until its own
                        expiry.
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          size="xs"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => void run(() => api.cloudAgentLoginRemove(agent.id, contextRevision), `${agent.name} is disconnected.`)}
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
