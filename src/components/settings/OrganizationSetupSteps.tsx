import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type CloudWorkspaceQuote } from "@/lib/api";
import { createErrorMessage, createWorkspace, failureMessage, isClientError, launchInput, repositoriesInput, usableProviders, CreateRefused, type CreateForm, type PendingCreate } from "@/lib/cloudCreate";
import { formatMicros } from "@/lib/organizationCompute";
import { organizationGithubApp } from "@/lib/organizationGithubApp";
import {
  ENVIRONMENT_CHECK_PROMPT,
  reconcileSetup,
  setupWorkspace,
  STEP_LABELS,
  type OrganizationSetupRecord,
  type SetupFacts,
  type SetupStep,
} from "@/lib/organizationSetup";

const SHOWN: readonly (keyof typeof STEP_LABELS)[] = ["compute", "repository", "workspace", "runtime", "agent"];
const ORDER: readonly SetupStep[] = ["create", "select", "compute", "repository", "workspace", "runtime", "agent", "done"];
/** Agents a setup workspace can be checked with. */
const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

type Prepared = { form: CreateForm; pending: PendingCreate; quote: CloudWorkspaceQuote };

/** A form is only read for a new create; a resend uses the kept request. */
const RESEND_FORM: CreateForm = { name: "", provider: null, repositories: [], prompt: "", agent: "claude", model: "", effort: "", mode: "", accessMode: "private" };

function failureText(failure: unknown): string {
  if (failure instanceof CreateRefused) return createErrorMessage(failure.code, failure.detail);
  if (isClientError(failure)) return createErrorMessage(failure.code);
  return errorMessage(failure);
}

/**
 * The steps from a selected organization to a working first workspace
 * (PRO-16), read from the server every time this is shown. `record` is that
 * organization's setup record and nobody else's; `onRecord` stores a change.
 */
export function OrganizationSetupSteps({
  record,
  organizationId,
  onRecord,
}: {
  record: OrganizationSetupRecord;
  organizationId: string;
  onRecord: (record: OrganizationSetupRecord) => void;
}) {
  const [facts, setFacts] = useState<SetupFacts>({ activeOrganizationId: organizationId, compute: null, repository: null, workspaces: null });
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
    const [providers, github, list] = await Promise.all([
      api.cloudProviders().then(
        (response) => usableProviders(response.providers),
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

  const step = record.step;
  const reached = (name: SetupStep) => ORDER.indexOf(step) > ORDER.indexOf(name);
  const item = setupWorkspace(record, facts.workspaces);
  const unsent = record.workspace && !record.workspace.id ? record.workspace.pending : null;

  if (step === "done") {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid="organization-setup-done">
        Cloud setup is complete{record.agent === "terminal-only" ? " (terminal only, no agent)" : ""}.
      </p>
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

      {step === "compute" && <p className="mt-2 text-xs text-muted-foreground">Connect a compute provider below, then check again.</p>}
      {step === "repository" && <p className="mt-2 text-xs text-muted-foreground">Connect GitHub and choose at least one repository in the GitHub section below, then check again.</p>}

      {step === "workspace" && unsent && (
        <div className="mt-2 text-xs text-muted-foreground">
          <p>The setup workspace was requested but not confirmed. Resuming sends the same request again: it cannot create a second workspace.</p>
          <Button className="mt-2" size="sm" disabled={busy} onClick={() => void send(RESEND_FORM, unsent)}>
            {busy ? <Loader2 className="animate-spin" /> : "Resume creating the setup workspace"}
          </Button>
        </div>
      )}
      {step === "workspace" && !unsent && !prepared && (
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
      {step === "workspace" && !unsent && prepared && (
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
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
