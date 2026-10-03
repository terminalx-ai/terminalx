import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Circle, GitBranch, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import {
  api,
  type CloudProviderSummary,
  type CloudSelectedRepository,
  type CloudWorkspaceListItem,
  type CloudWorkspaceProviderId,
  type CloudWorkspaceSnapshot,
} from "@/lib/api";
import {
  CreateRefused,
  PHASES,
  createErrorMessage,
  createWorkspace,
  failureMessage,
  isClientError,
  launchLatency,
  loadPending,
  phaseOf,
  runtimeNotPickedUp,
  RUNTIME_NOT_PICKED_UP,
  savePending,
  settled,
  usableProviders,
  validateForm,
  type CreateForm,
  type CreateStep,
  type PendingCreate,
  type PhaseId,
} from "@/lib/cloudCreate";
import { cloudOrgArg, rememberCreatedWorkspace } from "@/lib/cloudCatalog";
import { errorCode } from "@/lib/cloudTerminals";
import { DEFAULT_PERMISSION_MODE, EFFORT_LABEL, PERMISSION_MODES, modelOptionText, offeredOn, useModels } from "@/lib/models";

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];
const POLL_MS = 2000;
const inputClass = "min-w-0 rounded-md border border-hairline bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

const STEP_TEXT: Record<CreateStep, string> = {
  checking: "Checking repositories and branches…",
  quoting: "Checking your organization's limits…",
  creating: "Creating the workspace…",
};

/**
 * Create a cloud workspace from repositories and a first prompt (PRO-21):
 * the organization's selected repositories (PRO-14) with their base
 * branches, the agent, model, effort and permission mode, and who can see
 * it. The prompt goes into the workspace's launch intent, which its runtime
 * sends to the agent once it is running; this page never sends it itself.
 */
export function CloudCreateWorkspace({
  organizationId,
  onOpen,
  onChanged,
  onProgress,
}: {
  organizationId: string;
  /** Open a session in a workspace whose agent is running. */
  onOpen: (item: CloudWorkspaceListItem) => void;
  /** A workspace was created, canceled or retried: the list is stale. */
  onChanged?: () => void;
  /** Each newer snapshot of the workspace being created, so the list shows what this form shows. */
  onProgress?: (snapshot: CloudWorkspaceSnapshot) => void;
}) {
  const [providers, setProviders] = useState<CloudProviderSummary[] | null>(null);
  const [selected, setSelected] = useState<CloudSelectedRepository[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<CreateForm>({
    name: "",
    provider: null,
    repositories: [],
    prompt: "",
    agent: "claude",
    model: "",
    effort: "",
    mode: DEFAULT_PERMISSION_MODE,
    accessMode: "private",
  });
  const [step, setStep] = useState<CreateStep | null>(null);
  const [error, setError] = useState<{ code: string; message: string; retry: boolean } | null>(null);
  const [pending, setPending] = useState<PendingCreate | null>(() => loadPending(organizationId));
  const [tracked, setTrackedState] = useState<CloudWorkspaceSnapshot | null>(null);
  const progress = useRef(onProgress);
  progress.current = onProgress;
  const setTracked = useCallback((snapshot: CloudWorkspaceSnapshot | null) => {
    setTrackedState(snapshot);
    if (snapshot) progress.current?.(snapshot);
  }, []);
  // Aliases only: this list is the desktop's, and the new workspace's CLI may not run a version pinned from it.
  const models = offeredOn(useModels(form.agent), false);
  const model = models.find((item) => item.id === form.model) ?? null;

  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);
  const loadRepositories = useCallback(() => {
    setRepositoriesError(null);
    api
      .cloudWorkspaceRepositories()
      .then((result) => setSelected(result.repositories.filter((repository) => repository.cloneUrl)))
      .catch((e: unknown) => setRepositoriesError(errorCode(e)));
  }, []);

  useEffect(() => {
    loadRepositories();
    api
      .cloudProviders()
      .then((result) => {
        setProviders(result.providers);
        const usable = usableProviders(result.providers);
        setForm((current) => (current.provider || !usable[0] ? current : { ...current, provider: usable[0].id }));
      })
      .catch((e: unknown) => setLoadError(errorCode(e)));
  }, [loadRepositories]);

  const keep = useCallback(
    (next: PendingCreate | null) => {
      setPending(next);
      savePending(organizationId, next);
    },
    [organizationId],
  );

  const update = <K extends keyof CreateForm>(key: K, value: CreateForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const errors = useMemo(() => validateForm(form), [form]);
  const busy = step !== null;

  const submit = async (retry: boolean) => {
    setError(null);
    try {
      const snapshot = await createWorkspace(api, form, {
        pending: retry ? pending : null,
        onStep: setStep,
        onPending: keep,
        onCreated: (created, request) => rememberCreatedWorkspace(created, request.repositories),
      });
      setTracked(snapshot);
      onChanged?.();
    } catch (e) {
      if (e instanceof CreateRefused) setError({ code: e.code, message: createErrorMessage(e.code, e.detail), retry: false });
      else {
        const code = errorCode(e);
        setError({ code, message: createErrorMessage(code), retry: isClientError(e) && e.retryWithSameIdempotencyKey });
      }
    } finally {
      setStep(null);
    }
  };

  if (tracked) {
    return (
      <CreationProgress
        snapshot={tracked}
        onUpdate={setTracked}
        onOpen={onOpen}
        onChanged={onChanged}
        onDone={() => setTracked(null)}
      />
    );
  }

  const usable = providers ? usableProviders(providers) : [];
  const available = (selected ?? []).filter((repository) => !form.repositories.some((chosen) => chosen.cloneUrl === repository.cloneUrl));
  const addRepository = (cloneUrl: string) => {
    const repository = selected?.find((item) => item.cloneUrl === cloneUrl);
    if (!repository?.cloneUrl) return;
    setForm((current) => ({
      ...current,
      name: current.name || (current.repositories.length === 0 ? repository.fullName.split("/").pop() ?? "" : current.name),
      repositories: [...current.repositories, { cloneUrl: repository.cloneUrl!, fullName: repository.fullName, ref: "" }],
    }));
  };

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="cloud-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      {loadError && <p className="text-xs text-muted-foreground">Cloud workspaces are unavailable ({loadError}).</p>}
      {providers && usable.length === 0 && (
        <p className="text-xs text-muted-foreground">No compute provider is ready. An admin connects one in Settings → Cloud compute.</p>
      )}

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Name</span>
        <input aria-label="Workspace name" className={inputClass} value={form.name} maxLength={80} onChange={(event) => update("name", event.target.value)} />
        {form.name && errors.name && <span className="text-red-500">{errors.name}</span>}
      </label>

      {usable.length > 1 && (
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Compute</span>
          <select
            aria-label="Compute provider"
            className={inputClass}
            value={form.provider ?? ""}
            onChange={(event) => update("provider", event.target.value as CloudWorkspaceProviderId)}
          >
            {usable.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
        </label>
      )}

      <fieldset className="flex flex-col gap-2 text-xs">
        <legend className="mb-1 font-medium">Repositories</legend>
        {repositoriesError && (
          <p className="flex items-center gap-2 text-red-500" role="alert">
            The organization's repositories could not be loaded ({repositoriesError}).
            <Button type="button" size="sm" variant="outline" onClick={loadRepositories}>
              Try again
            </Button>
          </p>
        )}
        {selected?.length === 0 && (
          <p className="text-muted-foreground">No repositories are selected for cloud workspaces. An admin chooses them in Settings → GitHub.</p>
        )}
        {form.repositories.map((repository, index) => (
          <div key={repository.cloneUrl} className="flex items-center gap-2" data-testid="cloud-create-repository">
            <span className="w-16 shrink-0 text-muted-foreground">{index === 0 ? "Primary" : "Also"}</span>
            <span className="min-w-0 flex-1 truncate">{repository.fullName}</span>
            <GitBranch className="size-3.5 text-muted-foreground" />
            <input
              aria-label={`Base branch of ${repository.fullName}`}
              className={`${inputClass} w-40 font-mono text-xs`}
              placeholder={selected?.find((item) => item.cloneUrl === repository.cloneUrl)?.defaultBranch ?? "default branch"}
              value={repository.ref}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  repositories: current.repositories.map((item, at) => (at === index ? { ...item, ref: event.target.value } : item)),
                }))
              }
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={`Remove ${repository.fullName}`}
              onClick={() => setForm((current) => ({ ...current, repositories: current.repositories.filter((_, at) => at !== index) }))}
            >
              <X className="size-3" />
            </Button>
            {errors[`ref:${index}`] && <span className="text-red-500">{errors[`ref:${index}`]}</span>}
          </div>
        ))}
        {available.length > 0 && form.repositories.length < 5 && (
          <div className="flex items-center gap-2">
            <Plus className="size-3.5 text-muted-foreground" />
            <select
              aria-label={form.repositories.length === 0 ? "Repository" : "Additional repository"}
              className={`${inputClass} flex-1`}
              value=""
              onChange={(event) => addRepository(event.target.value)}
            >
              <option value="">{form.repositories.length === 0 ? "Choose a repository…" : "Add another repository…"}</option>
              {available.map((repository) => (
                <option key={repository.cloneUrl} value={repository.cloneUrl!} disabled={repository.state !== "accessible"}>
                  {repository.fullName}
                  {repository.state !== "accessible" ? ` (${repository.state})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        {errors.repositories && <span className="text-red-500">{errors.repositories}</span>}
        <p className="text-muted-foreground">Each repository gets a new branch of its own for this workspace, made from its base branch.</p>
      </fieldset>

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">First task</span>
        <textarea
          aria-label="Initial prompt"
          className={`${inputClass} min-h-24 resize-y`}
          placeholder="What should the agent work on? Sent once, when the agent is ready."
          value={form.prompt}
          onChange={(event) => update("prompt", event.target.value)}
        />
        {errors.prompt && <span className="text-red-500">{errors.prompt}</span>}
      </label>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Agent</span>
          <select
            aria-label="Agent"
            className={inputClass}
            value={form.agent}
            onChange={(event) => setForm((current) => ({ ...current, agent: event.target.value, model: "", effort: "" }))}
          >
            {AGENTS.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Model</span>
          <select
            aria-label="Model"
            className={inputClass}
            value={form.model}
            onChange={(event) => setForm((current) => ({ ...current, model: event.target.value, effort: "" }))}
          >
            <option value="">Default</option>
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {modelOptionText(item, models, false)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Effort</span>
          <select aria-label="Effort" className={inputClass} value={form.effort} onChange={(event) => update("effort", event.target.value)}>
            <option value="">Default</option>
            {(model?.efforts ?? []).map((effort) => (
              <option key={effort} value={effort}>
                {EFFORT_LABEL[effort] ?? effort}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Permissions</span>
          <select aria-label="Permission mode" className={inputClass} value={form.mode} onChange={(event) => update("mode", event.target.value)}>
            {PERMISSION_MODES.map((mode) => (
              <option key={mode.id} value={mode.id} title={mode.hint}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <span className="font-medium">Visible to</span>
        <Segmented
          aria-label="Visibility"
          value={form.accessMode}
          onChange={(value) => update("accessMode", value)}
          options={[
            { value: "private", label: "Only me" },
            { value: "organization", label: "Organization" },
          ]}
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs" role="alert" data-testid="cloud-create-error">
          <span className="text-red-500">{error.message}</span>
          {error.retry && pending && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void submit(true)}>
              <RotateCcw className="size-3" /> Retry
            </Button>
          )}
        </div>
      )}
      {!error && pending && !busy && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>A create of “{pending.request.name}” was not confirmed.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void submit(true)}>
            <RotateCcw className="size-3" /> Retry it
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => keep(null)}>
            Discard
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || Object.keys(errors).length > 0 || Boolean(pending)}>
          {busy && <Loader2 className="size-3.5 animate-spin" />} Create workspace
        </Button>
        {step && <span className="text-xs text-muted-foreground">{STEP_TEXT[step]}</span>}
      </div>
    </form>
  );
}

/**
 * The startup phases of one new workspace, polled from its operation until
 * the agent runs, the create fails, or it is canceled. Cancel is offered
 * while the provider can still stop; a failed create that left its machine
 * behind is retried with a resume, which reuses that machine and delivers
 * the same launch intent once.
 */
export function CreationProgress({
  snapshot,
  onUpdate,
  onOpen,
  onChanged,
  onDone,
}: {
  snapshot: CloudWorkspaceSnapshot;
  onUpdate: (snapshot: CloudWorkspaceSnapshot) => void;
  onOpen: (item: CloudWorkspaceListItem) => void;
  onChanged?: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const phase = phaseOf(snapshot);
  const operationId = snapshot.operation.id;
  const orgId = snapshot.workspace.orgId;
  const latest = useRef(onUpdate);
  latest.current = onUpdate;

  useEffect(() => {
    if (settled(phase)) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      api
        .cloudWorkspaceOperation(operationId, cloudOrgArg(orgId))
        .then((next) => {
          if (!stopped) latest.current(next);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [operationId, phase]);

  const act = async (action: () => Promise<CloudWorkspaceSnapshot>) => {
    setBusy(true);
    setError(null);
    try {
      onUpdate(await action());
      onChanged?.();
    } catch (e) {
      setError(createErrorMessage(errorCode(e)));
    } finally {
      setBusy(false);
    }
  };

  const reached = PHASES.findIndex((item) => item.id === phase);
  const failedAt = phase === "failed" || phase === "canceled" ? lastReached(snapshot) : -1;
  const latency = launchLatency(snapshot);
  const launch = snapshot.workspace.launch;
  const retryable = phase === "failed" && snapshot.workspace.state === "attention-required";
  const notPickedUp = runtimeNotPickedUp(snapshot, now) !== null;
  // A Ready workspace can always be opened, even while its agent is still
  // starting or its runtime never picks up the first task.
  const openable = phase === "running" || (snapshot.workspace.state === "ready" && !settled(phase));

  return (
    <div className="flex flex-col gap-3" data-testid="cloud-create-progress" data-phase={phase}>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{snapshot.workspace.name}</span>
        {launch && (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground" title="This workspace's own branch">
            <GitBranch className="size-3" /> {launch.workBranch}
          </span>
        )}
      </div>
      <ol className="flex flex-col gap-1.5 text-xs">
        {PHASES.map((item, index) => {
          const done = reached > index || (failedAt >= 0 && failedAt > index);
          const current = reached === index && phase !== "running";
          const stopped = failedAt === index;
          return (
            <li key={item.id} className="flex items-center gap-2" data-state={done ? "done" : current ? "current" : stopped ? "stopped" : "waiting"}>
              {done || (phase === "running" && item.id === "running") ? (
                <Check className="size-3.5 text-green-600" />
              ) : current ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : stopped ? (
                <X className="size-3.5 text-red-500" />
              ) : (
                <Circle className="size-3.5 text-muted-foreground/50" />
              )}
              <span className={done || current || phase === "running" ? "" : "text-muted-foreground"}>{item.label}</span>
            </li>
          );
        })}
      </ol>
      {phase === "running" && (
        <p className="text-xs text-muted-foreground">
          {launch?.hasPrompt ? "The agent is working on the first task." : "The agent is ready."}
          {latency !== null && ` Ready in ${(latency / 1000).toFixed(1)} s.`}
        </p>
      )}
      {notPickedUp && (
        <p className="text-xs text-amber-600" role="status" data-testid="cloud-create-not-picked-up">
          {RUNTIME_NOT_PICKED_UP}
        </p>
      )}
      {phase === "failed" && <p className="text-xs text-red-500">{failureMessage(snapshot)}</p>}
      {phase === "canceled" && <p className="text-xs text-muted-foreground">Canceled. Its compute is released and the first prompt was not sent.</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex items-center gap-2">
        {openable && (
          <Button size="sm" variant={phase === "running" ? "default" : "outline"} onClick={() => onOpen({ workspace: snapshot.workspace, latestOperation: snapshot.operation })}>
            Open session
          </Button>
        )}
        {!settled(phase) && snapshot.operation.cancelable && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => api.cloudWorkspaceOperationCancel(operationId, cloudOrgArg(snapshot.workspace.orgId)))}>
            Cancel
          </Button>
        )}
        {retryable && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => api.cloudWorkspaceResume(snapshot.workspace.id, cloudOrgArg(snapshot.workspace.orgId)))}>
            <RotateCcw className="size-3" /> Retry
          </Button>
        )}
        {settled(phase) && (
          <Button size="sm" variant="ghost" onClick={onDone}>
            Create another
          </Button>
        )}
      </div>
    </div>
  );
}

/** For a stopped launch: the last phase it had reached, from its timings. */
function lastReached(snapshot: CloudWorkspaceSnapshot): number {
  const timings = snapshot.workspace.launch?.timings;
  const order: [PhaseId, number | null | undefined][] = [
    ["starting-agent", timings?.startingAgentAt],
    ["syncing-repository", timings?.syncingAt],
    ["authenticating-runtime", timings?.authenticatingAt],
    ["booting", timings?.bootingAt],
  ];
  const found = order.find(([, at]) => typeof at === "number");
  if (found) return PHASES.findIndex((item) => item.id === found[0]);
  const stage = snapshot.operation.stage;
  if (stage === "bootstrapping") return 1;
  if (stage === "connecting-relay") return 2;
  return 0;
}
