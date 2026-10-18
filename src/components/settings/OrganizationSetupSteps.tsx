import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type AgentLogin, type AgentLoginProvider, type CloudWorkspaceQuote } from "@/lib/api";
import { createErrorMessage, createWorkspace, failureMessage, isClientError, launchInput, preflightCreate, repositoriesInput, CreateRefused, type CreateForm, type PendingCreate } from "@/lib/cloudCreate";
import { creatableProviders } from "@/lib/hiddenProviders";
import { formatMicros } from "@/lib/organizationCompute";
import { organizationGithubApp } from "@/lib/organizationGithubApp";
import { openAgentLogins, openOrganizationSettings } from "@/lib/settingsLinks";
import { AgentLoginsLink } from "@/components/cloud/AgentLoginsLink";
import { agentLoginUsable, OrganizationAgentLogins } from "./OrganizationAgentLogins";
import {
  ENVIRONMENT_CHECK_PROMPT,
  reconcileSetup,
  resendable,
  setupWorkspace,
  unsettledRequest,
  STEP_LABELS,
  type OrganizationSetupRecord,
  type SetupFacts,
  type SetupStep,
} from "@/lib/organizationSetup";

const SHOWN: readonly (keyof typeof STEP_LABELS)[] = ["compute", "logins", "repository", "workspace", "runtime", "agent"];
const ORDER: readonly SetupStep[] = ["create", "select", "compute", "logins", "repository", "workspace", "runtime", "agent", "done"];
/** Agents a setup workspace can be checked with. */
const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

/** Every agent an organization keeps a login for (PRO-107), in the order its page lists them. */
const LOGIN_AGENTS: readonly { id: AgentLoginProvider; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
];

/** The agents whose stored login a workspace can use now. */
function usableAgents(logins: readonly AgentLogin[]): AgentLoginProvider[] {
  return LOGIN_AGENTS.filter((agent) => agentLoginUsable(logins.find((login) => login.provider === agent.id))).map((agent) => agent.id);
}

/** "Codex", "Codex and Cursor", "Claude Code, Codex and Cursor". */
function listed(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

type Prepared = { form: CreateForm; pending: PendingCreate; quote: CloudWorkspaceQuote };

/** A form is only read for a new create; a resend uses the kept request. */
const RESEND_FORM: CreateForm = { name: "", provider: null, repositories: [], prompt: "", agent: "claude", model: "", effort: "", mode: "", accessMode: "private" };

/** An earlier request is too old to resend and the workspace list could not be read to see what it did. */
const UNSETTLED =
  "An earlier request for the setup workspace was never answered, and the workspace list could not be read to see whether it made one. Check again when the list loads; a new setup workspace is offered only once that is known.";

function failureText(failure: unknown): string {
  // The setup is an owner's or admin's, and the logins are on this same page.
  if (failure instanceof CreateRefused) return createErrorMessage(failure.code, failure.detail, true);
  if (isClientError(failure)) return createErrorMessage(failure.code);
  return errorMessage(failure);
}

/**
 * The steps from a selected organization to a working first workspace
 * (PRO-16), read from the server every time this is shown. `record` is that
 * organization's setup record and nobody else's; `onRecord` stores a change.
 * Right after the compute connection come the organization's agent logins
 * (PRO-107), set here or later on its page.
 */
export function OrganizationSetupSteps({
  record,
  organizationId,
  organizationName,
  contextRevision,
  onRecord,
}: {
  record: OrganizationSetupRecord;
  organizationId: string;
  organizationName: string;
  /** The account's context revision, for the agent logins step. */
  contextRevision: string;
  onRecord: (record: OrganizationSetupRecord) => void;
}) {
  const [facts, setFacts] = useState<SetupFacts>({ activeOrganizationId: organizationId, compute: null, logins: null, repository: null, workspaces: null });
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState("claude");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  // The newest record, for callbacks that outlive a render. It follows the
  // prop only when the prop changes, so a re-render for some other reason
  // cannot put back a record that has since been stored.
  const current = useRef(record);
  const given = useRef(record);
  if (given.current !== record) {
    given.current = record;
    current.current = record;
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Through a ref: the parent's callback is new on every render, and the
  // check below must not run again because of that.
  const report = useRef(onRecord);
  report.current = onRecord;
  const store = useCallback((next: OrganizationSetupRecord) => {
    current.current = next;
    report.current(next);
  }, []);

  // Looking only reads lists: it never wakes or starts a workspace.
  const check = useCallback(async () => {
    setChecking(true);
    const [providers, logins, github, list] = await Promise.all([
      api.cloudProviders().then(
        (response) => creatableProviders(response.providers),
        () => null,
      ),
      api.cloudAgentLogins(organizationId).then(
        (response) => usableAgents(response.credentials),
        () => null,
      ),
      organizationGithubApp.summary().then(
        (summary) => summary.repositories.filter((repository) => repository.state === "accessible" && repository.cloneUrl),
        () => null,
      ),
      api.cloudWorkspaces(null).then(
        (response) => response.workspaces,
        () => null,
      ),
    ]);
    if (!mounted.current) return null;
    const next: SetupFacts = {
      activeOrganizationId: organizationId,
      compute: providers ? providers.length > 0 : null,
      logins,
      repository: github ? github.length > 0 : null,
      workspaces: list,
    };
    setFacts(next);
    setChecking(false);
    const reconciled = reconcileSetup(current.current, next);
    if (reconciled !== current.current) store(reconciled);
    return { providers, github };
  }, [organizationId, store]);

  useEffect(() => {
    void check();
  }, [check]);

  const prepare = async (terminalOnly: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const found = await check();
      // The check above settles an expired request when the list could be
      // read. If it could not, the earlier request may still have made a
      // workspace: nothing new is prepared until that is known.
      if (unsettledRequest(current.current)) throw new Error(UNSETTLED);
      const provider = found?.providers?.[0];
      const repository = found?.github?.[0];
      if (!provider || !repository?.cloneUrl) throw new CreateRefused(provider ? "cloud_workspace_repository_credential_required" : "cloud_provider_connection_required");
      const form: CreateForm = {
        name: "Setup check",
        provider: provider.id,
        repositories: [{ cloneUrl: repository.cloneUrl, fullName: repository.fullName, ref: "" }],
        prompt: terminalOnly ? "" : ENVIRONMENT_CHECK_PROMPT,
        agent,
        model: "",
        effort: "",
        mode: "",
        accessMode: "private",
      };
      // The same checks as any create: the repository, and with a prompt
      // that its agent has a login (PRO-78). Refused here, nothing is quoted.
      await preflightCreate(api, form, null);
      const setup = await api.cloudWorkspaceSetup(provider.id, null);
      const quote = await api.cloudWorkspaceQuote({ provider: provider.id, ...setup.defaults }, null);
      const idempotencyKey = crypto.randomUUID();
      const pending: PendingCreate = {
        idempotencyKey,
        createdAt: Date.now(),
        request: { name: form.name, quoteId: quote.id, accessMode: form.accessMode, confirmProviderSpend: true, idempotencyKey, repositories: repositoriesInput(form), launch: launchInput(form) },
      };
      if (mounted.current) setPrepared({ form, pending, quote });
    } catch (failure) {
      if (mounted.current) setError(failureText(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // The request is stored before it is sent, so a retry after a lost answer
  // (or after quitting the app) resends the same one: one workspace, and its
  // first prompt delivered once.
  const send = async (form: CreateForm, pending: PendingCreate) => {
    // Never over an earlier request whose outcome is still unknown.
    if (unsettledRequest(current.current) && current.current.workspace?.pending !== pending) {
      setPrepared(null);
      setError(UNSETTLED);
      return;
    }
    setBusy(true);
    setError(null);
    const terminalOnly = !pending.request.launch?.prompt;
    store({ ...current.current, agent: terminalOnly ? "terminal-only" : "required", workspace: { pending, id: null } });
    try {
      await createWorkspace(api, form, {
        pending,
        onPending: (kept) => {
          const workspace = current.current.workspace;
          // A definite refusal: nothing was created, so the next try is a new request.
          if (!kept && !workspace?.id) store({ ...current.current, workspace: null });
        },
        onCreated: (snapshot) => store({ ...current.current, workspace: { pending: null, id: snapshot.workspace.id } }),
      });
      if (mounted.current) setPrepared(null);
      await check();
    } catch (failure) {
      if (mounted.current) {
        setPrepared(null);
        setError(failureText(failure));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  /** The person goes on from the agent logins: with one connected, or to set them up later. */
  const passLogins = (logins: "connected" | "later") => store(reconcileSetup({ ...current.current, logins }, facts));

  const step = record.step;
  const reached = (name: SetupStep) => ORDER.indexOf(step) > ORDER.indexOf(name);
  // Which agents have no login yet, once that is known, when the person chose to set them up later: through the
  // remaining steps and at completion. Not for a setup that went on with a login (or finished before the step).
  const missing = facts.logins ? LOGIN_AGENTS.filter((agent) => !facts.logins!.includes(agent.id)).map((agent) => agent.label) : [];
  const missingLogins = missing.length > 0 && record.logins === "later" && (step === "done" || reached("logins")) && (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="organization-setup-missing-logins">
      <span>
        No agent login yet for {listed(missing)} in {organizationName}: {missing.length === 1 ? "its agent" : "their agents"} can't run in its cloud workspaces until one
        is connected.
      </span>
      <Button size="xs" variant="outline" onClick={() => openAgentLogins(organizationId)}>
        Open {organizationName}'s agent logins
      </Button>
    </div>
  );
  const item = setupWorkspace(record, facts.workspaces);
  // Resent only while the server still answers it as the same create.
  const unsent = resendable(record);
  const unsettled = unsettledRequest(record);

  if (step === "done") {
    return (
      <div className="mt-3">
        <p className="text-xs text-muted-foreground" data-testid="organization-setup-done">
          Cloud setup is complete{record.agent === "terminal-only" ? " (terminal only, no agent)" : ""}.
        </p>
        {missingLogins}
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-hairline pt-3" data-testid="organization-setup-steps">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium">Finish cloud setup</div>
        <Button variant="ghost" size="sm" disabled={checking || busy} onClick={() => void check()}>
          {checking ? <Loader2 className="animate-spin" /> : "Check again"}
        </Button>
      </div>
      <ol className="mt-1 space-y-1 text-xs">
        {SHOWN.filter((name) => name !== "agent" || record.agent === "required").map((name) => (
          <li key={name} className={reached(name) ? "text-muted-foreground" : name === step ? "text-foreground" : "text-faint"} aria-current={name === step ? "step" : undefined}>
            <span className="inline-flex w-4 justify-center">{reached(name) ? <Check className="size-3" aria-label="done" /> : name === step ? "→" : "·"}</span> {STEP_LABELS[name]}
          </li>
        ))}
      </ol>

      {/* The provider controls are drawn above these steps, in the same setup section. */}
      {step === "compute" && <p className="mt-2 text-xs text-muted-foreground">Connect a compute provider above, then check again.</p>}
      {step === "logins" && (
        <div className="mt-2 text-xs text-muted-foreground" data-testid="organization-setup-logins">
          <p>
            Connect what the agents in {organizationName}'s cloud workspaces sign in with: Claude Code (Log in with Claude or an API key), Codex (Log in
            with ChatGPT or an API key) or Cursor (an API key), or lend this Mac's sign-in. The logins belong to {organizationName} only. You can also set
            them up later on its page in Settings → Organizations.
          </p>
          <div className="mt-2">
            <OrganizationAgentLogins
              contextRevision={contextRevision}
              organizationId={organizationId}
              organizationName={organizationName}
              reveal={false}
              onLogins={(logins) => setFacts((known) => ({ ...known, logins: logins ? usableAgents(logins) : null }))}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy || !facts.logins?.length} onClick={() => passLogins("connected")}>
              Continue
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => passLogins("later")}>
              Set up later
            </Button>
            {!facts.logins?.length && <span>Continue needs at least one agent connected.</span>}
          </div>
        </div>
      )}
      {missingLogins}
      {/* GitHub is on the organization's own page (PRO-107), not in this section. */}
      {step === "repository" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="organization-setup-repository">
          <span>Connect GitHub and choose at least one repository on {organizationName}'s page in Settings → Organizations, under GitHub, then check again.</span>
          <Button size="xs" variant="outline" onClick={() => openOrganizationSettings(organizationId)}>
            Open {organizationName}'s GitHub settings
          </Button>
        </div>
      )}

      {step === "workspace" && unsent && (
        <div className="mt-2 text-xs text-muted-foreground">
          <p>The setup workspace was requested but not confirmed. Resuming sends the same request again: it cannot create a second workspace.</p>
          <Button className="mt-2" size="sm" disabled={busy} onClick={() => void send(RESEND_FORM, unsent)}>
            {busy ? <Loader2 className="animate-spin" /> : "Resume creating the setup workspace"}
          </Button>
        </div>
      )}
      {step === "workspace" && unsettled && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="organization-setup-unsettled">
          {UNSETTLED}
        </p>
      )}
      {step === "workspace" && !unsent && !unsettled && !prepared && (
        <div className="mt-2 text-xs text-muted-foreground">
          {record.workspace?.id && <p className="mb-1">The setup workspace is no longer in this organization's list. Check again, or create a new one.</p>}
          <p>One small workspace proves the setup works: it clones your first repository and an agent checks the environment. It runs on your provider and costs money while it runs; the price is shown before anything is created.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              Agent
              <select aria-label="Setup agent" className="h-7 rounded-md border border-hairline bg-background px-1 text-xs" value={agent} disabled={busy} onChange={(event) => setAgent(event.target.value)}>
                {AGENTS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" disabled={busy} onClick={() => void prepare(false)}>
              {busy ? <Loader2 className="animate-spin" /> : "Prepare setup workspace"}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void prepare(true)}>
              Terminal only, no agent
            </Button>
          </div>
        </div>
      )}
      {step === "workspace" && !unsent && !unsettled && prepared && (
        <div className="mt-2 text-xs text-muted-foreground" data-testid="organization-setup-confirm">
          <p>
            Create “{prepared.form.name}” from {prepared.form.repositories[0]?.fullName}: {formatMicros(prepared.quote.activeHourlyMicros, prepared.quote.currency)} per hour while it runs.
            {prepared.form.prompt ? ` ${AGENTS.find((option) => option.id === prepared.form.agent)?.label ?? prepared.form.agent} starts with this prompt:` : " No agent is started: you get a terminal."}
          </p>
          {prepared.form.prompt && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-hairline p-2 text-[11px]">{prepared.form.prompt}</pre>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void send(prepared.form, prepared.pending)}>
              {busy ? <Loader2 className="animate-spin" /> : "Create setup workspace"}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPrepared(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {step === "runtime" && (
        <p className="mt-2 text-xs text-muted-foreground">
          {item?.workspace.launch?.category ? failureMessage(item) : "The setup workspace is starting and cloning the repository. This takes a few minutes; check again."}
        </p>
      )}
      {step === "agent" && (
        <div className="mt-2 text-xs text-muted-foreground">
          <p>{item?.workspace.launch?.category ? failureMessage(item) : "The workspace is running. Waiting for the agent to take the environment-check prompt; check again."}</p>
          <Button className="mt-2" variant="ghost" size="sm" disabled={busy} onClick={() => store(reconcileSetup({ ...current.current, agent: "terminal-only" }, facts))}>
            Finish without an agent (terminal only)
          </Button>
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-destructive">
          {error} <AgentLoginsLink message={error} organizationId={organizationId} className="ml-1 align-baseline text-foreground" />
        </p>
      )}
    </div>
  );
}
