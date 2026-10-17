import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "@/icons";
import { Button } from "@/components/ui/button";
import { listedProviders } from "@/lib/hiddenProviders";
import { api } from "@/lib/api";
import { providerLabel } from "@/lib/organizationCompute";
import {
  changeLabel,
  cleanDefinition,
  definitionProblem,
  emptyDefinition,
  environmentErrorMessage,
  isBuilding,
  organizationEnvironment,
  publicationLabel,
  recipesUnavailable,
  sameDefinition,
  versionStateLabel,
  type EnvironmentDefinition,
  type EnvironmentLogEntry,
  type EnvironmentRecipe,
  type EnvironmentRepository,
  type EnvironmentStatus,
  type EnvironmentVersion,
  type OrganizationEnvironmentError,
} from "@/lib/organizationEnvironment";
import { ConfigureEnvironmentWithAgent } from "./ConfigureEnvironmentWithAgent";
import { EnvironmentRecipes } from "./EnvironmentRecipes";

const inputClass = "h-7 min-w-0 rounded-md border border-hairline bg-background px-2 text-xs disabled:opacity-60";
const areaClass = "min-h-16 rounded-md border border-hairline bg-background px-2 py-1 font-mono text-[11px] disabled:opacity-60";
const BUILD_POLL_MS = 5000;

interface ProviderOption {
  id: string;
  connected: boolean;
}

const formatTime = (timestamp: number | null) => (timestamp ? new Date(timestamp).toLocaleString() : "never");
const shortCommit = (commit: string) => commit.slice(0, 7);
const definite = (failure: unknown) => typeof (failure as Partial<OrganizationEnvironmentError> | null)?.status === "number";

function ActiveVersion({ version }: { version: EnvironmentVersion | null }) {
  if (!version) {
    return <p className="mt-2 text-[11px] text-muted-foreground">No version is published yet. New workspaces on this provider clone their repositories when they start.</p>;
  }
  return (
    <div className="mt-2 text-[11px]" aria-label="Active environment version">
      <p>
        New workspaces start from version {version.number}, published {formatTime(version.publishedAt ?? version.finishedAt)}.
      </p>
      {version.repositories.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
          {version.repositories.map((repository) => (
            <li key={`${repository.owner}/${repository.name}`}>
              {repository.owner}/{repository.name} on {repository.defaultBranch}
              {repository.commit ? <span className="font-mono"> at {shortCommit(repository.commit)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RepositoryEditor({
  repository,
  index,
  disabled,
  onChange,
  onRemove,
}: {
  repository: EnvironmentRepository;
  index: number;
  disabled: boolean;
  onChange: (repository: EnvironmentRepository) => void;
  onRemove: () => void;
}) {
  const label = repository.owner && repository.name ? `${repository.owner}/${repository.name}` : `repository ${index + 1}`;
  const setStep = (stepIndex: number, patch: Partial<EnvironmentRepository["setup"][number]>) =>
    onChange({ ...repository, setup: repository.setup.map((step, current) => (current === stepIndex ? { ...step, ...patch } : step)) });
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-hairline p-2" aria-label={`Setup for ${label}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
          GitHub owner
          <input aria-label={`Owner of ${label}`} className={inputClass} value={repository.owner} disabled={disabled} onChange={(event) => onChange({ ...repository, owner: event.target.value })} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
          Repository
          <input aria-label={`Name of ${label}`} className={inputClass} value={repository.name} disabled={disabled} onChange={(event) => onChange({ ...repository, name: event.target.value })} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
          Default branch
          <input aria-label={`Default branch of ${label}`} className={inputClass} value={repository.defaultBranch} disabled={disabled} onChange={(event) => onChange({ ...repository, defaultBranch: event.target.value })} />
        </label>
        <Button size="xs" variant="ghost" aria-label={`Remove ${label}`} disabled={disabled} onClick={onRemove}>
          Remove
        </Button>
      </div>
      {repository.setup.map((step, stepIndex) => (
        <div key={stepIndex} className="flex flex-col gap-1">
          <div className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
              Step {stepIndex + 1} runs in (a folder inside the repository)
              <input
                aria-label={`Folder of step ${stepIndex + 1} for ${label}`}
                className={inputClass}
                value={step.workingDirectory}
                disabled={disabled}
                onChange={(event) => setStep(stepIndex, { workingDirectory: event.target.value })}
              />
            </label>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Remove step ${stepIndex + 1} for ${label}`}
              disabled={disabled}
              onClick={() => onChange({ ...repository, setup: repository.setup.filter((_, current) => current !== stepIndex) })}
            >
              Remove step
            </Button>
          </div>
          <textarea
            aria-label={`Script of step ${stepIndex + 1} for ${label}`}
            className={areaClass}
            value={step.script}
            disabled={disabled}
            onChange={(event) => setStep(stepIndex, { script: event.target.value })}
          />
        </div>
      ))}
      <div>
        <Button size="xs" variant="outline" disabled={disabled} onClick={() => onChange({ ...repository, setup: [...repository.setup, { workingDirectory: ".", script: "" }] })}>
          Add setup step
        </Button>
      </div>
    </li>
  );
}

export function OrganizationEnvironment({ contextRevision, organizationId = null }: { contextRevision: string; organizationId?: string | null }) {
  const [providers, setProviders] = useState<ProviderOption[] | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [status, setStatus] = useState<EnvironmentStatus | null>(null);
  // Null: this server does not offer recipes (switched off, or older).
  const [recipes, setRecipes] = useState<EnvironmentRecipe[] | null>(null);
  const [draft, setDraft] = useState<EnvironmentDefinition>(emptyDefinition);
  // Unsaved template edits survive refreshes and build polling.
  const [dirty, setDirty] = useState(false);
  // The template revision the draft was started from. A save names it, so an
  // edit made on top of someone else's newer revision is refused, not merged.
  const [draftRevision, setDraftRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [log, setLog] = useState<{ versionId: string; entries: EnvironmentLogEntry[] | null; error: string | null } | null>(null);
  const contextEpoch = useRef(0);
  const loadSeq = useRef(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // One key for one intended build: pressing again after a lost response
  // replays the same build instead of starting a second builder machine.
  // The key is for one template revision: a build asked for after the
  // template changed is a different build and gets a key of its own.
  const buildKey = useRef<{ key: string; revision: number } | null>(null);

  const load = useCallback(async (target: string, options: { keepError?: boolean; quiet?: boolean } = {}) => {
    const current = ++loadSeq.current;
    const context = contextEpoch.current;
    const fresh = () => current === loadSeq.current && context === contextEpoch.current;
    if (!options.quiet) setLoading(true);
    try {
      const next = await organizationEnvironment.status(target);
      if (!fresh()) return;
      setStatus(next);
      if (!dirtyRef.current) {
        setDraft(next.template?.definition ?? emptyDefinition());
        setDraftRevision(next.template?.revision ?? 0);
      }
      // The quiet poll that follows a build must not wipe the message of an action that just failed.
      if (!options.keepError && !options.quiet) setError(null);
      if (next.canManage && next.supported) {
        try {
          const listed = await organizationEnvironment.recipes(target);
          if (fresh()) setRecipes(listed.recipes);
        } catch (failure) {
          if (!fresh()) return;
          if (recipesUnavailable(failure)) setRecipes(null);
          else if (!options.quiet) setError(environmentErrorMessage(failure));
        }
      } else setRecipes(null);
    } catch (failure) {
      if (fresh() && !options.quiet) setError(environmentErrorMessage(failure));
    } finally {
      if (fresh()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const context = contextEpoch.current;
    setProviders(null);
    setProvider(null);
    setStatus(null);
    setRecipes(null);
    setDraft(emptyDefinition());
    setDirty(false);
    dirtyRef.current = false;
    setBusy(null);
    setConfirming(null);
    setLog(null);
    setError(null);
    setLoading(true);
    buildKey.current = null;
    void api
      .cloudProviders()
      .then((response) => {
        if (context !== contextEpoch.current) return;
        const options = listedProviders(response.providers).map((summary) => ({ id: summary.id as string, connected: summary.connection !== null }));
        setProviders(options);
        const first = options.find((option) => option.connected) ?? options[0];
        if (first) setProvider(first.id);
        else setLoading(false);
      })
      .catch(() => {
        if (context !== contextEpoch.current) return;
        setProviders([]);
        setError("TerminalX could not load this organization's cloud providers. Try again.");
        setLoading(false);
      });
    return () => {
      contextEpoch.current += 1;
    };
  }, [contextRevision]);

  useEffect(() => {
    if (!provider) return;
    setStatus(null);
    setRecipes(null);
    setDraft(emptyDefinition());
    setDirty(false);
    dirtyRef.current = false;
    setConfirming(null);
    setLog(null);
    buildKey.current = null;
    void load(provider);
  }, [provider, load]);

  // A build in flight is followed without anyone pressing refresh. These are
  // plain reads of the server's record; they start nothing.
  const building = Boolean(status?.versions.some(isBuilding));
  useEffect(() => {
    if (!provider || !building) return;
    const timer = setInterval(() => void load(provider, { quiet: true }), BUILD_POLL_MS);
    return () => clearInterval(timer);
  }, [provider, building, load]);

  const act = async (key: string, run: (current: EnvironmentStatus) => Promise<unknown>): Promise<boolean> => {
    if (!status || !provider || busy) return false;
    const context = contextEpoch.current;
    setBusy(key);
    setError(null);
    try {
      await run(status);
      if (context !== contextEpoch.current) return false;
      setConfirming(null);
      await load(provider);
      return true;
    } catch (failure) {
      if (context !== contextEpoch.current) return false;
      setError(environmentErrorMessage(failure));
      setConfirming(null);
      await load(provider, { keepError: true });
      // Rethrown for callers that must tell a refusal from a lost response.
      throw failure;
    } finally {
      if (context === contextEpoch.current) setBusy(null);
    }
  };
  const run = (key: string, operation: (current: EnvironmentStatus) => Promise<unknown>) => void act(key, operation).catch(() => undefined);

  const change = (next: EnvironmentDefinition) => {
    setDraft(next);
    setDirty(!sameDefinition(next, status?.template?.definition ?? emptyDefinition()));
  };

  const save = () =>
    run("save", (current) =>
      organizationEnvironment.update(current.provider, draftRevision, cleanDefinition(draft), current.contextRevision).then(() => {
        // Saved: the reload that follows replaces the draft with what the server stored.
        dirtyRef.current = false;
        setDirty(false);
      }),
    );

  const build = () => {
    const revision = status?.template?.revision ?? 0;
    if (buildKey.current?.revision !== revision) buildKey.current = { key: crypto.randomUUID(), revision };
    const key = buildKey.current.key;
    void act("build", (current) => organizationEnvironment.build(current.provider, key, true, current.contextRevision))
      .then(() => {
        buildKey.current = null;
      })
      .catch((failure) => {
        // A definite refusal started nothing; only a lost response keeps the key.
        if (definite(failure)) buildKey.current = null;
      });
  };

  const showLog = async (version: EnvironmentVersion) => {
    if (log?.versionId === version.id) {
      setLog(null);
      return;
    }
    const context = contextEpoch.current;
    setLog({ versionId: version.id, entries: null, error: null });
    try {
      const detail = await organizationEnvironment.version(version.id);
      if (context === contextEpoch.current) setLog((current) => (current?.versionId === version.id ? { versionId: version.id, entries: detail.logs ?? [], error: null } : current));
    } catch (failure) {
      if (context === contextEpoch.current) setLog((current) => (current?.versionId === version.id ? { versionId: version.id, entries: null, error: environmentErrorMessage(failure) } : current));
    }
  };

  const header = (
    <div className="flex items-center justify-between">
      <div className="text-sm font-medium">Cloud environment</div>
      <Button variant="ghost" size="icon-xs" aria-label="Refresh cloud environment" disabled={loading || !provider} onClick={() => provider && void load(provider)}>
        <RefreshCw className={loading ? "animate-spin" : undefined} />
      </Button>
    </div>
  );
  const intro = (
    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
      The environment is the machine image new cloud workspaces start from: the tools installed on the machine, and each repository already cloned and set up. Changing it here changes nothing for running workspaces, and nothing new is used until a version is built and published.
    </p>
  );
  const providerPicker = providers && providers.length > 1 && (
    <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
      Provider
      <select aria-label="Environment provider" className={inputClass} value={provider ?? ""} disabled={Boolean(busy)} onChange={(event) => setProvider(event.target.value)}>
        {providers.map((option) => (
          <option key={option.id} value={option.id}>
            {providerLabel(option.id)}
            {option.connected ? "" : " (not connected)"}
          </option>
        ))}
      </select>
    </label>
  );

  if (!status) {
    return (
      <div className="rounded-lg border border-hairline p-3">
        {header}
        {intro}
        {providerPicker}
        {loading ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading the environment…
          </div>
        ) : error ? (
          <div className="mt-2 flex items-center gap-2">
            <p className="text-xs text-destructive">{error}</p>
            {provider && (
              <Button variant="ghost" size="xs" onClick={() => void load(provider)}>
                Retry
              </Button>
            )}
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-muted-foreground">Connect a cloud provider to set up its environment.</p>
        )}
      </div>
    );
  }

  const name = providerLabel(status.provider);
  const template = status.template;
  const saved = template?.definition ?? emptyDefinition();
  const unchanged = sameDefinition(draft, saved);
  const problem = definitionProblem(draft);
  // Someone else saved a newer revision while this draft was being edited.
  const outdated = !unchanged && (template?.revision ?? 0) !== draftRevision;
  const disabled = Boolean(busy);
  const spendNote = `This starts a temporary builder machine on ${name}. ${name} bills the organization's account for it, and it is removed when the build ends.`;

  return (
    <div className="rounded-lg border border-hairline p-3">
      {header}
      {intro}
      {providerPicker}
      {error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {!status.supported ? (
        <p className="mt-2 text-[11px]" role="status">
          {name} cannot build environment images yet. Workspaces on {name} clone their repositories when they start, so there is nothing to configure here.
        </p>
      ) : (
        <>
          <ActiveVersion version={status.activeVersion} />

          {status.canManage ? (
            <>
              <form
                className="mt-3 flex flex-col gap-2"
                aria-label="Environment template"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!problem && !unchanged && !outdated) save();
                }}
              >
                <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                  <span>Template</span>
                  <span className="font-normal">{template ? `Revision ${template.revision}, saved ${formatTime(template.updatedAt)}` : "Not saved yet"}</span>
                </div>

                <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  <span className="text-xs font-medium text-foreground">Machine install script</span>
                  Runs once on the machine, as root, when a version is built. Use it for tools every repository needs.
                  <textarea aria-label="Machine install script" className={areaClass} value={draft.installScript} disabled={disabled} onChange={(event) => change({ ...draft, installScript: event.target.value })} />
                </label>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">Repository setup</span>
                  <span className="text-[11px] text-muted-foreground">Each repository is cloned into the image, then its own steps run inside it. These are kept apart from the machine script.</span>
                  {draft.repositories.length > 0 && (
                    <ul className="flex flex-col gap-2">
                      {draft.repositories.map((repository, index) => (
                        <RepositoryEditor
                          key={index}
                          repository={repository}
                          index={index}
                          disabled={disabled}
                          onChange={(next) => change({ ...draft, repositories: draft.repositories.map((existing, current) => (current === index ? next : existing)) })}
                          onRemove={() => change({ ...draft, repositories: draft.repositories.filter((_, current) => current !== index) })}
                        />
                      ))}
                    </ul>
                  )}
                  <div>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => change({ ...draft, repositories: [...draft.repositories, { owner: "", name: "", defaultBranch: "main", setup: [] }] })}
                    >
                      Add repository
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button type="submit" size="sm" className="h-7" disabled={disabled || unchanged || outdated || Boolean(problem)}>
                    {busy === "save" ? <Loader2 className="animate-spin" /> : "Save template"}
                  </Button>
                  {!unchanged && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      disabled={disabled}
                      onClick={() => {
                        setDraft(saved);
                        setDraftRevision(template?.revision ?? 0);
                        setDirty(false);
                      }}
                    >
                      Discard changes
                    </Button>
                  )}
                  {outdated ? (
                    <span className="text-[11px] text-destructive">The template was changed since you started editing (it is now revision {template?.revision ?? 0}). Discard your changes to load it.</span>
                  ) : !unchanged && problem ? (
                    <span className="text-[11px] text-destructive">{problem}</span>
                  ) : !unchanged ? (
                    <span className="text-[11px] text-muted-foreground">Saving makes a new revision. It builds nothing.</span>
                  ) : null}
                </div>
              </form>

              <section className="mt-3 flex flex-col gap-1.5" aria-label="Build a version">
                <div className="text-xs font-medium text-muted-foreground">Build</div>
                <p className="text-[11px]" role="status">
                  {!template
                    ? "Save a template first; then you can build a version from it."
                    : status.rebuildRequired
                      ? status.pendingChanges.length
                        ? `Not built yet: ${status.pendingChanges.map(changeLabel).join(", ")}.`
                        : "No version has been built from this template yet."
                      : "The active version was built from this template."}
                </p>
                {confirming === "build" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 text-[11px]">{spendNote}</p>
                    <Button size="xs" disabled={disabled} onClick={build}>
                      {busy === "build" ? <Loader2 className="animate-spin" /> : "Start build"}
                    </Button>
                    <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" className="h-7" disabled={disabled || !template || !unchanged || building} onClick={() => setConfirming("build")}>
                      Build version…
                    </Button>
                    {template && !unchanged && <span className="text-[11px] text-muted-foreground">Save or discard your changes first.</span>}
                    {building && <span className="text-[11px] text-muted-foreground">A build is in progress.</span>}
                  </div>
                )}
              </section>

              <section className="mt-3 flex flex-col gap-1.5" aria-label="Environment versions">
                <div className="text-xs font-medium text-muted-foreground">Versions</div>
                {status.versions.length ? (
                  <ul className="flex flex-col gap-1.5">
                    {status.versions.map((version) => {
                      const publication = publicationLabel(version.publication);
                      return (
                        <li key={version.id} className="rounded-md border border-hairline p-2 text-[11px]" aria-label={`Version ${version.number}`}>
                          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <span className="min-w-0">
                              <span className="font-medium">Version {version.number}</span>
                              <span className={version.state === "failed" ? " text-destructive" : " text-muted-foreground"}> · {versionStateLabel(version)}</span>
                              {publication && <span className="text-muted-foreground"> · {publication}</span>}
                            </span>
                            <span className="text-muted-foreground">
                              Template revision {version.configurationRevision} · {formatTime(version.createdAt)}
                            </span>
                          </div>
                          {version.errorCode && <p className="mt-1 break-all font-mono text-destructive">{version.errorCode}</p>}
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {isBuilding(version) && (
                              <Button size="xs" variant="outline" disabled={disabled} onClick={() => run(`cancel:${version.id}`, (current) => organizationEnvironment.cancel(version.id, current.contextRevision))}>
                                {busy === `cancel:${version.id}` ? <Loader2 className="animate-spin" /> : "Cancel build"}
                              </Button>
                            )}
                            {version.state === "failed" && confirming !== `retry:${version.id}` && (
                              <Button size="xs" variant="outline" disabled={disabled || building} onClick={() => setConfirming(`retry:${version.id}`)}>
                                Build again…
                              </Button>
                            )}
                            {version.rollbackAvailable && confirming !== `rollback:${version.id}` && (
                              <Button size="xs" variant="outline" disabled={disabled} onClick={() => setConfirming(`rollback:${version.id}`)}>
                                Roll back to this…
                              </Button>
                            )}
                            <Button size="xs" variant="ghost" aria-expanded={log?.versionId === version.id} onClick={() => void showLog(version)}>
                              {log?.versionId === version.id ? "Hide log" : "Show log"}
                            </Button>
                          </div>
                          {confirming === `retry:${version.id}` && (
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <p className="min-w-0 flex-1">Build version {version.number}'s template again as a new version? {spendNote}</p>
                              <Button size="xs" disabled={disabled} onClick={() => run(`retry:${version.id}`, (current) => organizationEnvironment.retry(version.id, true, current.contextRevision))}>
                                {busy === `retry:${version.id}` ? <Loader2 className="animate-spin" /> : "Start build"}
                              </Button>
                              <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setConfirming(null)}>
                                Cancel
                              </Button>
                            </div>
                          )}
                          {confirming === `rollback:${version.id}` && (
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <p className="min-w-0 flex-1">Make version {version.number} the active one? New workspaces will start from it. Running workspaces and the template are not changed.</p>
                              <Button size="xs" disabled={disabled} onClick={() => run(`rollback:${version.id}`, (current) => organizationEnvironment.rollback(version.id, current.contextRevision))}>
                                {busy === `rollback:${version.id}` ? <Loader2 className="animate-spin" /> : "Roll back"}
                              </Button>
                              <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setConfirming(null)}>
                                Cancel
                              </Button>
                            </div>
                          )}
                          {log?.versionId === version.id && (
                            <div className="mt-1" aria-label={`Build log of version ${version.number}`}>
                              {log.error ? (
                                <p className="text-destructive">{log.error}</p>
                              ) : log.entries === null ? (
                                <p className="text-muted-foreground">Loading the log…</p>
                              ) : log.entries.length ? (
                                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-well px-2 py-1 font-mono">
                                  {log.entries.map((entry) => `[${entry.phase}] ${entry.content}`).join("\n")}
                                </pre>
                              ) : (
                                <p className="text-muted-foreground">This version has no log.</p>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-[11px] text-muted-foreground">No version has been built yet.</p>
                )}
                {status.retainedVersions !== null && status.versions.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {name} keeps {status.retainedVersions} built version{status.retainedVersions === 1 ? "" : "s"}: the active one and the rest to roll back to.
                  </p>
                )}
              </section>

              {/* Offered only where a recipe can be stored: a server with recipes on. */}
              {recipes && <ConfigureEnvironmentWithAgent status={status} organizationId={organizationId} onSaved={() => provider && void load(provider)} />}

              {recipes && (
                <EnvironmentRecipes
                  recipes={recipes}
                  current={template?.definition ?? null}
                  currentRevision={template?.revision ?? 0}
                  busy={busy}
                  unsavedTemplate={!unchanged}
                  onApply={(recipe) => run(`apply:${recipe.id}`, (current) => organizationEnvironment.applyRecipe(recipe.id, true, current.contextRevision))}
                  onDismiss={(recipe) => run(`dismiss:${recipe.id}`, (current) => organizationEnvironment.dismissRecipe(recipe.id, current.contextRevision))}
                />
              )}
            </>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">Organization owners and admins set up the environment and build its versions.</p>
          )}
        </>
      )}
    </div>
  );
}
