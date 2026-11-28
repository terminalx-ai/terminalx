import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Bot, Check, Circle, CircleCheck, CircleX, Copy, FolderGit2, Loader2, Pencil, RotateCcw, Square } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, type CloudWorkspaceProviderId, type CloudWorkspaceSetup } from "@/lib/api";
import { listedProviders } from "@/lib/hiddenProviders";
import { cloudProviderIsPlatform } from "@/lib/cloudProviders";
import { providerLabel } from "@/lib/organizationCompute";
import type { BuildFailureContext } from "@/lib/environmentProposal";
import { useEnvironmentRun } from "@/lib/environmentRun";
import { ConfigureEnvironmentWithAgent } from "@/components/settings/ConfigureEnvironmentWithAgent";
import { EnvironmentRecipes } from "@/components/settings/EnvironmentRecipes";
import { organizationGithubApp } from "@/lib/organizationGithubApp";
import {
  BUILD_STAGES,
  changeLabel,
  cleanDefinition,
  compareDefinitions,
  definitionProblem,
  emptyDefinition,
  environmentErrorMessage,
  failureOutcome,
  failureSummary,
  isBuilding,
  organizationEnvironment,
  recipesUnavailable,
  sameDefinition,
  stageLabel,
  type EnvironmentDefinition,
  type EnvironmentRecipe,
  type EnvironmentRepository,
  type EnvironmentStatus,
  type EnvironmentVersion,
  type OrganizationEnvironmentError,
} from "@/lib/organizationEnvironment";
import { configErrorMessage, envToText, parseEnvText, workspaceConfig, type OrganizationConfigView } from "@/lib/workspaceConfig";
import { cn } from "@/lib/cn";
import { FieldLabel, PrimaryButton, StepActions, StepError, StepPage, useLeaveGuard } from "./FlowLayout";
import { LeaveWithoutBuildingDialog } from "./LeaveWithoutBuildingDialog";
import type { StepProps } from "./stepProps";

const BUILD_POLL_MS = 5000;
const STAGES = BUILD_STAGES;
const LOG_TAIL = 4;
/** How much of a failed build's log goes to the agent asked to fix it. */
const FIX_LOG_LINES = 60;

/** A repository chosen in the GitHub step: the only ones the environment may clone. */
interface ChosenRepository {
  owner: string;
  name: string;
  defaultBranch: string;
}

/** What the person changed on top of the saved template, and the revision they started from. */
interface Edits {
  revision: number;
  installScript?: string;
  scripts: Record<string, string>;
}

const keyOf = (repository: { owner: string; name: string }) => `${repository.owner}/${repository.name}`.toLowerCase();
const definite = (failure: unknown) => typeof (failure as Partial<OrganizationEnvironmentError> | null)?.status === "number";

/**
 * The one setup command a repository has here: a single step in the clone's
 * root. Null when it has several steps, or one in a folder (set up in
 * Settings): those are kept exactly as they are.
 */
function singleScript(repository: EnvironmentRepository | undefined): string | null {
  if (!repository || repository.setup.length === 0) return "";
  const [only] = repository.setup;
  if (repository.setup.length === 1 && only && (only.workingDirectory.trim() || ".") === ".") return only.script;
  return null;
}

/**
 * The template as it would be saved: the saved one, with the person's edits,
 * cloning exactly the repositories chosen in the GitHub step. Repositories
 * the template already had keep its order, so an unchanged template compares
 * equal; repositories no longer chosen are left out.
 */
function draftOf(saved: EnvironmentDefinition, chosen: ChosenRepository[] | null, edits: Edits | null): EnvironmentDefinition {
  const installScript = edits?.installScript ?? saved.installScript;
  if (!chosen) return { installScript, repositories: saved.repositories };
  const savedByKey = new Map(saved.repositories.map((repository) => [keyOf(repository), repository]));
  const chosenByKey = new Map(chosen.map((repository) => [keyOf(repository), repository]));
  const ordered = [
    ...saved.repositories.flatMap((repository) => chosenByKey.get(keyOf(repository)) ?? []),
    ...chosen.filter((repository) => !savedByKey.has(keyOf(repository))),
  ];
  return {
    installScript,
    repositories: ordered.map((repository) => {
      const before = savedByKey.get(keyOf(repository));
      const script = singleScript(before);
      const edited = edits?.scripts[keyOf(repository)];
      return {
        owner: before?.owner ?? repository.owner,
        name: before?.name ?? repository.name,
        defaultBranch: repository.defaultBranch || before?.defaultBranch || "",
        setup: script === null && before ? before.setup : [{ workingDirectory: ".", script: edited ?? script ?? "" }],
      };
    }),
  };
}

function elapsed(version: EnvironmentVersion, now: number): string {
  const start = version.startedAt ?? version.createdAt;
  if (!start) return "";
  const seconds = Math.max(0, Math.round(((version.finishedAt ?? now) - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const clock = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const logText = (version: EnvironmentVersion | null) => (version?.logs ?? []).map((entry) => `[${clock(entry.occurredAt)}] ${entry.content}`).join("\n");

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

type StageMark = "done" | "current" | "failed" | "canceled" | "pending";

function stageMarks(version: EnvironmentVersion): StageMark[] {
  const at = (stage: string) => (stage === "complete" ? STAGES.length : STAGES.indexOf(stage as (typeof STAGES)[number]));
  if (version.state === "succeeded") return STAGES.map(() => "done");
  if (version.state === "queued") return STAGES.map(() => "pending");
  const index = at(version.state === "failed" ? (version.failurePhase ?? version.stage) : version.stage);
  const mark: StageMark = version.state === "failed" ? "failed" : version.state === "canceled" ? "canceled" : "current";
  return STAGES.map((_, current) => (current < index ? "done" : current === index ? mark : "pending"));
}

function stageName(stage: (typeof STAGES)[number], version: EnvironmentVersion): string {
  const count = version.repositories.length;
  if (stage === "repositories" && count) return `Clone ${count} ${count === 1 ? "repository" : "repositories"}`;
  if (stage === "setup" && count) return `${stageLabel(stage)} · ${count} ${count === 1 ? "repository" : "repositories"}`;
  if (stage === "snapshot") return `Save snapshot as version ${version.number}`;
  return stageLabel(stage);
}

function StateChip({ version }: { version: EnvironmentVersion }) {
  const tone =
    version.state === "succeeded"
      ? "border-add/30 bg-add/10 text-add"
      : version.state === "failed"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : isBuilding(version)
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-hairline bg-well text-muted-foreground";
  const label = version.state === "running" ? "Building" : version.state === "queued" ? "Waiting" : version.state === "succeeded" ? (version.publication === "published" ? "Active" : "Built") : version.state === "failed" ? "Failed" : version.state === "canceled" ? "Canceled" : version.state;
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-[5px] border px-1.5 text-[12px]", tone)}>
      {isBuilding(version) && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {label}
    </span>
  );
}

/** The right column of 12.05: the shown version's stages, its time and its log; a failed one as 14.15's card. */
function BuildPanel({
  version,
  detail,
  detailError,
  active,
  canManage,
  busy,
  onCancel,
  onRetry,
  onFix,
}: {
  version: EnvironmentVersion | null;
  /** The shown version read on its own, with its log. */
  detail: EnvironmentVersion | null;
  detailError: string | null;
  active: EnvironmentVersion | null;
  canManage: boolean;
  busy: string | null;
  onCancel: (version: EnvironmentVersion) => void;
  onRetry: (version: EnvironmentVersion) => void;
  /** Hands the failed build to an agent; absent where no recipe can be stored. */
  onFix?: (version: EnvironmentVersion) => void;
}) {
  const building = Boolean(version && isBuilding(version));
  const now = useNow(building);
  const [copied, setCopied] = useState(false);
  const log = useRef<HTMLPreElement>(null);
  const shown = detail && version && detail.id === version.id ? detail : null;
  const text = logText(shown);
  useEffect(() => {
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [text]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!version) {
    return (
      <div className="rounded-xl border border-hairline bg-card p-4" data-testid="cloud-setup-build-panel">
        <div className="text-[13px] font-medium">Nothing is built yet</div>
        <p className="mt-1 text-[12.5px] leading-[19px] text-muted-foreground">
          No version has been built for this organization. Until one is, new workspaces start from the provider's base image and clone their repositories as they start.
        </p>
      </div>
    );
  }

  const copy = () => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
  const failed = version.state === "failed";
  const lines = shown?.logs ?? [];
  const logBody = !canManage ? null : shown === null ? (
    detailError ? (
      <p className="px-4 py-3 text-[12px] text-destructive">{detailError}</p>
    ) : (
      <p className="flex items-center gap-2 px-4 py-3 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading the log…
      </p>
    )
  ) : lines.length ? (
    <pre ref={log} className="max-h-[260px] min-h-[120px] overflow-auto px-4 py-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap break-words">
      {lines.map((entry, index) => (
        <div key={index}>
          <span className="text-faint">[{clock(entry.occurredAt)}]</span> {entry.content}
        </div>
      ))}
    </pre>
  ) : (
    <p className="px-4 py-3 text-[12px] text-muted-foreground">{building ? "The builder has not written to the log yet." : "This version has no log."}</p>
  );

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-card" data-testid="cloud-setup-build-panel">
      {failed ? (
        <div className="border-b border-destructive/30 bg-destructive/5 p-4" role="alert">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              <CircleX className="size-4 text-destructive" aria-hidden /> Build v{version.number} failed
            </span>
            <span className="text-[12px] text-muted-foreground">
              {[elapsed(version, now) && `after ${elapsed(version, now)}`, failureSummary(shown ?? version)].filter(Boolean).join(" · ")}
            </span>
          </div>
          {/* The log's last lines, then what exited and what stays in use; never the internal error code (14.15). */}
          <div className="mt-3 rounded-md bg-well px-3 py-2 font-mono text-[12px] leading-[18px]">
            {lines
              .flatMap((entry) => entry.content.split("\n"))
              .filter((line) => line.trim())
              .slice(-LOG_TAIL)
              .map((line, index) => (
                <div key={index} className="break-words text-muted-foreground">
                  {line}
                </div>
              ))}
            <div className="break-words text-destructive">{failureOutcome(shown ?? version, active)}</div>
          </div>
          {canManage && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" disabled={Boolean(busy)} onClick={() => onRetry(version)}>
                <RotateCcw /> Restart build
              </Button>
              {onFix && (
                <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => onFix(version)}>
                  <Bot /> Fix with an agent
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={!text} onClick={copy}>
                {copied ? <Check /> : <Copy />} Copy logs
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="p-4">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">Version {version.number}</span>
            <StateChip version={version} />
            <span className="ml-auto text-[12px] text-muted-foreground tabular-nums">{elapsed(version, now)}</span>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-well" aria-hidden>
            <div
              className={cn("h-full rounded-full", version.state === "succeeded" ? "bg-add" : version.state === "canceled" ? "bg-faint" : "bg-warning")}
              style={{ width: `${(stageMarks(version).filter((mark) => mark === "done").length / STAGES.length) * 100}%` }}
            />
          </div>
          <ol className="mt-3 grid gap-1" aria-label={`Stages of version ${version.number}`}>
            {STAGES.map((stage, index) => {
              const mark = stageMarks(version)[index]!;
              return (
                <li key={stage} className={cn("flex h-7 items-center gap-2.5 text-[12.5px]", mark === "pending" ? "text-faint" : "text-foreground")}>
                  {mark === "done" ? (
                    <CircleCheck className="size-4 text-add" aria-label="done" />
                  ) : mark === "current" ? (
                    <Loader2 className="size-4 animate-spin text-warning" aria-label="running" />
                  ) : mark === "canceled" ? (
                    <Square className="size-3.5 text-muted-foreground" aria-label="canceled" />
                  ) : (
                    <Circle className="size-4 text-faint" strokeDasharray="3 3" aria-label="not started" />
                  )}
                  {stageName(stage, version)}
                </li>
              );
            })}
          </ol>
          {version.state === "succeeded" && version.publication !== "published" && (
            <p className="mt-2 text-[12px] text-muted-foreground">{active ? `Version ${active.number} is the active one.` : "Built, and not published."}</p>
          )}
        </div>
      )}
      {canManage && (
        <>
          <div className="flex items-center gap-3 border-t border-hairline px-4 py-2">
            <span className="text-[12.5px] text-muted-foreground">Build log</span>
            {!failed && (
              <Button size="xs" variant="ghost" className="ml-auto text-[12px]" disabled={!text} onClick={copy}>
                {copied ? <Check /> : <Copy />} Copy logs
              </Button>
            )}
            {building && (
              <Button size="xs" variant="ghost" className={cn("text-[12px] text-destructive hover:text-destructive", failed && "ml-auto")} disabled={Boolean(busy)} onClick={() => onCancel(version)}>
                {busy === `cancel:${version.id}` ? <Loader2 className="animate-spin" /> : <Square />} Cancel build
              </Button>
            )}
          </div>
          <div className="border-t border-hairline bg-well">{logBody}</div>
        </>
      )}
    </div>
  );
}

/**
 * The organization's shared environment variables (workspaceConfig's
 * organization layer): applied when a workspace is created, so saving them
 * needs no build. Secrets stay in Settings' write-only vault.
 */
function SharedVariables({ disabled, onDirtyChange }: { disabled: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const [view, setView] = useState<OrganizationConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onDirtyChange?.(draft !== null);
  }, [draft, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const load = useCallback(async (keepError = false) => {
    setLoading(true);
    try {
      const next = await workspaceConfig.organization();
      if (!alive.current) return;
      setView(next);
      if (!keepError) setError(null);
    } catch (failure) {
      if (alive.current) setError(configErrorMessage(failure));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const parsed = draft === null ? null : parseEnvText(draft);
  const save = async () => {
    if (!view || !parsed || "error" in parsed || saving) return;
    const layer = view.organization;
    if (!layer.memberOverrides) return;
    setSaving(true);
    setError(null);
    try {
      await workspaceConfig.updateOrganization(
        { expectedVersion: layer.version, env: parsed.env, prompt: layer.prompt, mcpServers: layer.mcpServers, memberOverrides: layer.memberOverrides, lockedEnvKeys: layer.lockedEnvKeys },
        view.contextRevision,
      );
      if (!alive.current) return;
      setDraft(null);
      setNotice("Saved. New workspaces get these variables when they are created; no build is needed.");
      await load();
    } catch (failure) {
      if (!alive.current) return;
      setError(configErrorMessage(failure));
      await load(true);
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    if (!chosen) return;
    const text = await chosen.text();
    // A .env file's comments and `export` prefixes are not part of NAME=value.
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.replace(/^export\s+/, ""));
    if (!alive.current) return;
    setNotice(null);
    setDraft((current) => [current ?? envToText(view?.organization.env ?? {}), ...lines].filter(Boolean).join("\n"));
  };

  const entries = Object.entries(view?.organization.env ?? {});
  const editable = Boolean(view?.canEdit) && !disabled;
  return (
    <section className="mt-6" aria-label="Shared environment variables">
      {/* One line: the label, its hint (cut short when narrow), then the actions at the right (14.15). */}
      <div className="mb-1.5 flex min-w-0 items-center gap-1">
        <span className="shrink-0 text-[12.5px] font-medium whitespace-nowrap">Shared environment variables</span>
        <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">· applied when a workspace is created</span>
        {editable && (
          <span className="ml-auto flex shrink-0 gap-1">
            <input ref={file} type="file" accept=".env,text/plain" className="hidden" onChange={(event) => void importFile(event)} />
            <Button size="xs" variant="ghost" className="text-[12px]" onClick={() => file.current?.click()}>
              Import .env
            </Button>
            {draft === null && (
              <Button size="xs" variant="ghost" className="text-[12px]" onClick={() => setDraft(envToText(view?.organization.env ?? {}))}>
                Edit
              </Button>
            )}
          </span>
        )}
      </div>
      {!view ? (
        loading ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading the shared variables…
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <p className="text-[12.5px] text-destructive">{error}</p>
            <Button size="xs" variant="ghost" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )
      ) : draft !== null ? (
        <>
          <textarea
            aria-label="Shared environment variables, one NAME=value per line"
            className="min-h-24 w-full rounded-lg border border-hairline bg-card px-3 py-2 font-mono text-[12px] leading-5 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            rows={Math.max(3, draft.split("\n").length + 1)}
            spellCheck={false}
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={saving || !parsed || "error" in parsed} onClick={() => void save()}>
              {saving && <Loader2 className="animate-spin" />} Save variables
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            {parsed && "error" in parsed ? (
              <span className="text-[12px] text-destructive">{parsed.error}</span>
            ) : (
              <span className="text-[12px] text-muted-foreground">One NAME=value per line. Tokens and passwords belong in Settings' secrets.</span>
            )}
          </div>
        </>
      ) : entries.length ? (
        <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-card">
          {entries.map(([name, value]) => (
            <li key={name} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-center gap-4 px-3 py-2 font-mono text-[12px]">
              <span className="truncate">{name}</span>
              <span className="truncate text-muted-foreground">{value}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">{view.canEdit ? "None yet." : "None set. Owners and admins set them."}</p>
      )}
      {view && error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
      {notice && draft === null && <p className="mt-2 text-[12px] text-muted-foreground">{notice}</p>}
    </section>
  );
}

/**
 * Step 5 (12.05): the coding environment new workspaces start from. The
 * machine install script, a setup command for each repository chosen in the
 * GitHub step (and only those), and a build of a version from it. The build
 * may run on while the person goes on; leaving with changes that are not
 * built asks first (14.15).
 */
export function EnvironmentStep(props: StepProps) {
  const { organization, record, onRecord, onContinue } = props;
  // Undefined while the providers load; null when none is connected.
  const [provider, setProvider] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const [chosen, setChosen] = useState<ChosenRepository[] | null>(null);
  const [chosenError, setChosenError] = useState<string | null>(null);
  const [status, setStatus] = useState<EnvironmentStatus | null>(null);
  const [setup, setSetup] = useState<CloudWorkspaceSetup | null | "failed">(null);
  const [edits, setEdits] = useState<Edits | null>(null);
  const [sharedVarsDirty, setSharedVarsDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [detail, setDetail] = useState<EnvironmentVersion | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** Null where this server stores no recipes: then no agent is offered. */
  const [recipes, setRecipes] = useState<EnvironmentRecipe[] | null>(null);
  const [fixing, setFixing] = useState<BuildFailureContext | null>(null);
  // Each press asks again: a confirm cancelled earlier comes back.
  const [fixPresses, setFixPresses] = useState(0);
  const preparation = useEnvironmentRun();
  // A build this step just started: going on from here is not leaving it unbuilt.
  const [buildStarted, setBuildStarted] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const alive = useRef(true);
  const loadSeq = useRef(0);
  // One key for one intended build, per template revision: a press after a
  // lost response replays the same build instead of starting a second machine.
  const buildKey = useRef<{ key: string; revision: number } | null>(null);
  const machine = useRef(record.machine);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadChosen = useCallback(async () => {
    setChosenError(null);
    try {
      const summary = await organizationGithubApp.summary();
      if (!alive.current) return;
      setChosen(
        summary.repositories
          .filter((repository) => repository.state === "accessible")
          .flatMap((repository) => {
            const [owner, name] = repository.fullName.split("/");
            return owner && name ? [{ owner, name, defaultBranch: repository.defaultBranch ?? "" }] : [];
          }),
      );
    } catch {
      if (alive.current) setChosenError("TerminalX could not read the repositories chosen in the GitHub step.");
    }
  }, []);

  const load = useCallback(async (target: string, options: { keepError?: boolean; quiet?: boolean } = {}) => {
    const current = ++loadSeq.current;
    const fresh = () => alive.current && current === loadSeq.current;
    if (!options.quiet) setLoading(true);
    try {
      const next = await organizationEnvironment.status(target);
      if (!fresh()) return;
      setStatus(next);
      if (!options.keepError && !options.quiet) setError(null);
      // The recipe list changes only with a press here, never with a build's progress: the quiet poll leaves it.
      // Only a server without recipes takes the agent away; a failed read keeps what was shown, and a run in progress.
      if (next.canManage && !options.quiet)
        void organizationEnvironment.recipes(target).then(
          (listed) => fresh() && setRecipes(listed.recipes),
          (failure) => fresh() && recipesUnavailable(failure) && setRecipes(null),
        );
      const shown = next.versions.find(isBuilding) ?? [...next.versions].sort((left, right) => right.number - left.number)[0] ?? null;
      if (shown && next.canManage) {
        try {
          const read = await organizationEnvironment.version(shown.id);
          if (!fresh()) return;
          setDetail(read);
          setDetailError(null);
        } catch (failure) {
          if (fresh()) setDetailError(environmentErrorMessage(failure));
        }
      } else setDetail(null);
    } catch (failure) {
      if (fresh() && !options.quiet) setError(environmentErrorMessage(failure));
    } finally {
      if (fresh()) setLoading(false);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.cloudProviders();
      if (!alive.current) return;
      const listed = listedProviders(response.providers);
      const wanted = machine.current?.provider;
      // The provider the organization connected, else one TerminalX provides (PRO-452), which needs no connection.
      const summary = (wanted ? listed.find((option) => option.id === wanted) : undefined) ?? listed.find((option) => option.connection !== null) ?? listed.find(cloudProviderIsPlatform);
      const id = wanted ?? summary?.id ?? null;
      setProvider(id ? { id, name: summary?.displayName ?? providerLabel(id) } : null);
      if (!id) setLoading(false);
    } catch {
      if (!alive.current) return;
      setProvider(null);
      setError("TerminalX could not load this organization's cloud providers. Try again.");
      setLoading(false);
    }
  }, []);

  const loadSetup = useCallback(async (providerId: string) => {
    setSetup(null);
    try {
      const next = await api.cloudWorkspaceSetup(providerId as CloudWorkspaceProviderId, organization.id);
      if (alive.current) setSetup(next);
    } catch {
      if (alive.current) setSetup("failed");
    }
  }, [organization.id]);

  useEffect(() => {
    void loadChosen();
    void loadProviders();
  }, [organization.id, loadChosen, loadProviders]);

  useEffect(() => {
    if (!provider) return;
    void load(provider.id);
    void loadSetup(provider.id);
  }, [provider, organization.id, load, loadSetup]);

  // A build in flight is followed without anyone pressing anything: plain reads, they start nothing.
  const building = Boolean(status?.versions.some(isBuilding));
  useEffect(() => {
    if (!provider || !building) return;
    const timer = setInterval(() => void load(provider.id, { quiet: true }), BUILD_POLL_MS);
    return () => clearInterval(timer);
  }, [provider, building, load]);

  const template = status?.template ?? null;
  const saved = template?.definition ?? emptyDefinition();
  const draft = draftOf(saved, chosen, edits);
  const dirty = Boolean(status) && !sameDefinition(draft, saved);
  const manage = Boolean(status?.canManage && status.supported);
  const activeVersion = status?.activeVersion ?? null;
  const buildingVersion = status?.versions.find(isBuilding) ?? null;
  const shownVersion = buildingVersion ?? [...(status?.versions ?? [])].sort((left, right) => right.number - left.number)[0] ?? null;

  // Leaving with changes no build has taken asks first (14.15). A build this step just started has taken them.
  const unbuilt = (manage && (dirty || (Boolean(status?.rebuildRequired) && !building && !buildStarted))) || sharedVarsDirty;
  useLeaveGuard(
    unbuilt
      ? (leave) => {
          setLeaving(() => leave);
          return false;
        }
      : null,
  );

  const act = async (key: string, run: (current: EnvironmentStatus) => Promise<unknown>): Promise<boolean> => {
    if (!status || !provider || busy) return false;
    setBusy(key);
    setError(null);
    try {
      await run(status);
      if (!alive.current) return false;
      setConfirming(null);
      await load(provider.id);
      return true;
    } catch (failure) {
      if (!alive.current) return false;
      setError(environmentErrorMessage(failure));
      setConfirming(null);
      await load(provider.id, { keepError: true });
      throw failure;
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const edit = (change: (current: Edits) => Edits) => setEdits((current) => change(current ?? { revision: template?.revision ?? 0, scripts: {} }));
  // The revision the edits were started from; the save names it, so an edit on top of someone else's newer save is refused.
  const baseRevision = edits?.revision ?? template?.revision ?? 0;
  const outdated = dirty && edits !== null && (template?.revision ?? 0) !== edits.revision;
  const problem = dirty ? definitionProblem(draft) : null;

  const saveAndBuild = async () => {
    if (dirty) {
      const saved = await act("save", (current) =>
        organizationEnvironment.update(current.provider, baseRevision, cleanDefinition(draft), current.contextRevision).then(() => {
          // The reload that follows shows what the server stored.
          setEdits(null);
        }),
      ).catch(() => false);
      if (!saved) return;
    }
    setConfirming("build");
  };

  const build = () => {
    const revision = status?.template?.revision ?? 0;
    if (buildKey.current?.revision !== revision) buildKey.current = { key: crypto.randomUUID(), revision };
    const key = buildKey.current.key;
    setBuildStarted(true);
    void act("build", (current) => organizationEnvironment.build(current.provider, key, true, current.contextRevision))
      .then((done) => {
        if (done) buildKey.current = null;
        else setBuildStarted(false);
      })
      .catch((failure) => {
        setBuildStarted(false);
        // A definite refusal started nothing; only a lost response keeps the key.
        if (definite(failure)) buildKey.current = null;
      });
  };

  const retry = (version: EnvironmentVersion) => {
    setBuildStarted(true);
    void act(`retry:${version.id}`, (current) => organizationEnvironment.retry(version.id, true, current.contextRevision))
      .then((done) => !done && setBuildStarted(false))
      .catch(() => setBuildStarted(false));
  };

  // "Fix with an agent" (PRO-389): the failed build's summary, the saved script and the log's end go to the agent.
  const fix = (version: EnvironmentVersion) => {
    const read = detail?.id === version.id ? detail : version;
    const logTail = (read.logs ?? [])
      .flatMap((entry) => entry.content.split("\n"))
      .filter((line) => line.trim())
      .slice(-FIX_LOG_LINES)
      .join("\n");
    setFixPresses((count) => count + 1);
    setFixing({ version: version.number, summary: failureSummary(read), installScript: template?.definition.installScript ?? "", logTail });
  };

  const cancel = (version: EnvironmentVersion) => void act(`cancel:${version.id}`, (current) => organizationEnvironment.cancel(version.id, current.contextRevision)).catch(() => undefined);

  const chooseSource = (sourceId: string) => {
    if (!provider) return;
    onRecord({ ...record, machine: { ...record.machine, provider: provider.id, sourceId } });
  };

  // What the leave dialog says needs the build.
  const changes = (() => {
    if (dirty) {
      const compared = compareDefinitions(saved, draft);
      const parts = [
        compared.machineChanged && "the install script",
        (compared.removed.length > 0 || compared.repositories.some((entry) => entry.change !== "unchanged")) && "the repository setup",
      ].filter((part): part is string => Boolean(part));
      if (!parts.length) return "The environment has changes that need a new build.";
      const subject = parts.join(" and ");
      return `${subject[0]!.toUpperCase()}${subject.slice(1)} ${parts.length > 1 ? "have" : "has"} changes that need a new build.`;
    }
    const pending = status?.pendingChanges ?? [];
    return pending.length ? `Saved changes need a new build: ${pending.map(changeLabel).join(", ")}.` : "The saved environment has not been built yet.";
  })();

  const name = provider?.name ?? "";
  const spendNote = `This starts a temporary builder machine on ${name}. ${name} bills the organization's account for it, and it is removed when the build ends.`;
  const panel =
    status && status.supported ? (
      <BuildPanel
        version={shownVersion}
        detail={detail}
        detailError={detailError}
        active={activeVersion}
        canManage={status.canManage}
        busy={busy}
        onCancel={cancel}
        onRetry={(version) => setConfirming(`retry:${version.id}`)}
        onFix={recipes ? fix : undefined}
      />
    ) : null;
  // The agent run outlives this step; coming back to it shows it again.
  const fixPanel =
    status && status.supported && status.canManage && recipes && provider && (fixing || (preparation.kind !== "none" && preparation.provider === provider.id)) ? (
      <section className="mt-4 rounded-xl border border-hairline bg-card p-4" aria-label="Fix with an agent" data-testid="cloud-setup-fix-with-agent">
        <ConfigureEnvironmentWithAgent key={fixPresses} status={status} organizationId={organization.id} failure={fixing} autoBegin={fixing !== null} onSaved={() => void load(provider.id)} />
        {recipes.length > 0 && (
          <EnvironmentRecipes
            recipes={recipes}
            current={template?.definition ?? null}
            currentRevision={template?.revision ?? 0}
            busy={busy}
            unsavedTemplate={dirty}
            onApply={(recipe) => void act(`apply:${recipe.id}`, (current) => organizationEnvironment.applyRecipe(recipe.id, true, current.contextRevision)).catch(() => undefined)}
            onDismiss={(recipe) => void act(`dismiss:${recipe.id}`, (current) => organizationEnvironment.dismissRecipe(recipe.id, current.contextRevision)).catch(() => undefined)}
          />
        )}
      </section>
    ) : null;

  const savedByKey = new Map(saved.repositories.map((repository) => [keyOf(repository), repository]));
  const chosenKeys = new Set((chosen ?? []).map(keyOf));
  const dropped = chosen ? saved.repositories.filter((repository) => !chosenKeys.has(keyOf(repository))) : [];
  const sources = setup && setup !== "failed" ? setup.sources : [];
  const sourceId = sources.some((source) => source.id === record.machine?.sourceId) ? record.machine!.sourceId! : setup && setup !== "failed" ? setup.defaults.sourceId : "";
  const disabled = Boolean(busy);

  let body: ReactNode;
  let actions: ReactNode;
  if (provider === undefined || (provider && !status && loading)) {
    body = (
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading the environment…
      </p>
    );
    actions = null;
  } else if (!provider || !status) {
    body = error ? (
      <div className="flex items-center gap-2">
        <p className="text-[13px] text-destructive" role="alert">{error}</p>
        <Button size="sm" variant="outline" onClick={() => (provider ? void load(provider.id) : void loadProviders())}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="text-[13px] text-muted-foreground">Connect a compute provider in the Compute step to build an environment. Workspaces need one to start at all.</p>
    );
    actions = <PrimaryButton onClick={onContinue}>Continue</PrimaryButton>;
  } else if (!status.supported) {
    body = (
      <p className="text-[13px] text-muted-foreground" role="status">
        {name} cannot build environment images yet. Workspaces on {name} clone their repositories when they start, so there is nothing to build here.
      </p>
    );
    actions = <PrimaryButton onClick={onContinue}>Continue</PrimaryButton>;
  } else if (!status.canManage) {
    body = (
      <p className="text-[13px] text-muted-foreground" role="status">
        Only organization owners and admins set up the environment and build its versions.{" "}
        {activeVersion ? `New workspaces start from version ${activeVersion.number}.` : "No version is built yet, so new workspaces start from the provider's base image."}
      </p>
    );
    actions = <PrimaryButton onClick={onContinue}>Continue</PrimaryButton>;
  } else {
    const confirmedRetry = confirming?.startsWith("retry:") ? status.versions.find((version) => `retry:${version.id}` === confirming) : undefined;
    const needsBuild = template ? dirty || status.rebuildRequired : dirty;
    body = (
      <>
        <div className="mb-1.5 flex items-baseline justify-between">
          <FieldLabel htmlFor="cloud-setup-install-script" hint="runs once per version, as root">
            Machine install script
          </FieldLabel>
          <span className="text-[12px] text-muted-foreground">{template ? `Revision ${template.revision}` : "Not saved yet"}</span>
        </div>
        <textarea
          id="cloud-setup-install-script"
          className="w-full rounded-lg border border-hairline bg-card px-3.5 py-3 font-mono text-[12.5px] leading-5 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
          rows={Math.max(5, draft.installScript.split("\n").length + 1)}
          spellCheck={false}
          placeholder="# Tools every repository needs, for example: apt-get install -y postgresql-client"
          value={draft.installScript}
          disabled={disabled}
          onChange={(event) => {
            const installScript = event.target.value;
            edit((current) => ({ ...current, installScript }));
          }}
        />
        {setup === "failed" ? (
          <div className="mt-2 flex items-center gap-2">
            <p className="text-[12px] text-muted-foreground">TerminalX could not read {name}'s base images.</p>
            <Button size="xs" variant="ghost" onClick={() => void loadSetup(provider.id)}>
              Retry
            </Button>
          </div>
        ) : setup && sources.length > 1 ? (
          <label className="mt-3 flex items-center gap-3 text-[12.5px]">
            <span className="font-medium">Base image</span>
            <select
              aria-label="Base image"
              className="h-8 min-w-0 rounded-md border border-hairline bg-card px-2 text-[12.5px]"
              value={sourceId}
              onChange={(event) => chooseSource(event.target.value)}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
            {sources.find((source) => source.id === sourceId)?.description && (
              <span className="min-w-0 truncate text-[12px] text-muted-foreground">{sources.find((source) => source.id === sourceId)!.description}</span>
            )}
          </label>
        ) : setup && sources.length === 1 ? (
          <p className="mt-3 text-[12.5px]">
            <span className="font-medium">Base image</span> <span className="text-muted-foreground">· {sources[0]!.label}</span>
            {sources[0]!.description && <span className="text-muted-foreground"> · {sources[0]!.description}</span>}
          </p>
        ) : null}

        <div className="mt-6 mb-1.5 text-[12.5px]">
          <span className="font-medium">Repository setup</span>
          <span className="text-muted-foreground"> · runs inside each clone, kept apart from the machine script</span>
        </div>
        {chosenError ? (
          <div className="flex items-center gap-2">
            <p className="text-[12.5px] text-destructive">{chosenError}</p>
            <Button size="xs" variant="ghost" onClick={() => void loadChosen()}>
              Retry
            </Button>
          </div>
        ) : !chosen ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Reading the chosen repositories…
          </p>
        ) : draft.repositories.length === 0 && dropped.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">No repository is chosen in the GitHub step, so none is cloned into the image. Choose repositories there to build them in.</p>
        ) : (
          <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-card" aria-label="Repository setup">
            {draft.repositories.map((repository) => {
              const key = keyOf(repository);
              const fixed = singleScript(savedByKey.get(key)) === null;
              const script = repository.setup[0]?.script ?? "";
              const inputId = `cloud-setup-repository-${key.replace(/[^a-z0-9]/g, "-")}`;
              return (
                <li key={key} className="flex items-start gap-3 px-3 py-2.5">
                  <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="w-[150px] shrink-0 truncate pt-px font-mono text-[12.5px]" title={`${repository.owner}/${repository.name} on ${repository.defaultBranch || "an unknown branch"}`}>
                    {repository.name}
                  </span>
                  {fixed ? (
                    <span className="min-w-0 flex-1 pt-px text-[12px] text-muted-foreground">
                      {repository.setup.length} setup steps, kept as they are. Edit them in Settings, Cloud environment.
                    </span>
                  ) : (
                    <>
                      <textarea
                        id={inputId}
                        aria-label={`Setup command for ${repository.owner}/${repository.name}`}
                        className="min-w-0 flex-1 resize-none bg-transparent pt-px font-mono text-[12.5px] leading-5 text-muted-foreground outline-none placeholder:text-faint focus:text-foreground disabled:opacity-60"
                        rows={Math.max(1, script.split("\n").length)}
                        spellCheck={false}
                        placeholder="No setup command"
                        value={script}
                        disabled={disabled}
                        onChange={(event) => {
                          const value = event.target.value;
                          edit((current) => ({ ...current, scripts: { ...current.scripts, [key]: value } }));
                        }}
                      />
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Edit the setup command for ${repository.name}`}
                        onClick={() => document.getElementById(inputId)?.focus()}
                      >
                        <Pencil />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
            {dropped.map((repository) => (
              <li key={keyOf(repository)} className="flex items-center gap-3 px-3 py-2.5 text-faint">
                <FolderGit2 className="size-4 shrink-0" aria-hidden />
                <span className="w-[150px] shrink-0 truncate font-mono text-[12.5px] line-through">{repository.name}</span>
                <span className="min-w-0 flex-1 text-[12px]">No longer chosen in the GitHub step. Removed from the environment when you save.</span>
              </li>
            ))}
          </ul>
        )}

        <SharedVariables disabled={disabled} onDirtyChange={setSharedVarsDirty} />

        <p className="mt-4 text-[12px] text-muted-foreground">
          Saving makes a new revision; it builds nothing. Edits after this build show as unbuilt changes until you build again.
        </p>
        {outdated ? (
          <p className="mt-2 text-[12px] text-destructive">
            The environment was changed since you started editing (it is now revision {template?.revision ?? 0}). Discard your changes to load it.
          </p>
        ) : problem ? (
          <p className="mt-2 text-[12px] text-destructive">{problem}</p>
        ) : !dirty && status.rebuildRequired && !building && status.pendingChanges.length > 0 ? (
          <p className="mt-2 text-[12px] text-warning">Not built yet: {status.pendingChanges.map(changeLabel).join(", ")}.</p>
        ) : null}
      </>
    );
    actions =
      confirming === "build" || confirmedRetry ? (
        <>
          <PrimaryButton busy={busy === "build" || busy === confirming} disabled={disabled} onClick={() => (confirmedRetry ? retry(confirmedRetry) : build())}>
            Start build
          </PrimaryButton>
          <Button variant="ghost" className="h-9 text-[12.5px]" disabled={disabled} onClick={() => setConfirming(null)}>
            Cancel
          </Button>
          <span className="basis-full text-[12.5px] text-muted-foreground">
            {confirmedRetry ? `Build version ${confirmedRetry.number}'s template again as a new version. ` : ""}
            {spendNote}
          </span>
        </>
      ) : building && !dirty ? (
        <>
          <PrimaryButton onClick={onContinue}>Continue while it builds</PrimaryButton>
          <span className="text-[12.5px] text-muted-foreground">
            You can invite people now. They can start sessions once version {buildingVersion?.number ?? shownVersion?.number} is ready.
          </span>
        </>
      ) : needsBuild ? (
        <>
          <PrimaryButton busy={busy === "save"} disabled={disabled || building || outdated || Boolean(problem) || (dirty && chosen === null)} onClick={() => void saveAndBuild()}>
            {dirty ? "Save and build" : "Build"}
          </PrimaryButton>
          {dirty && (
            <Button variant="ghost" className="h-9 text-[12.5px]" disabled={disabled} onClick={() => setEdits(null)}>
              Discard changes
            </Button>
          )}
          <Button variant="outline" className="h-9 text-[12.5px]" disabled={disabled} onClick={onContinue}>
            Continue without building
          </Button>
          {building && <span className="text-[12.5px] text-muted-foreground">A build is running. Your changes can be saved and built once it ends.</span>}
        </>
      ) : (
        <>
          <PrimaryButton onClick={onContinue}>Continue</PrimaryButton>
          {!template && <span className="text-[12.5px] text-muted-foreground">Add an install script, or choose repositories in the GitHub step, to build a version.</span>}
        </>
      );
  }

  return (
    <StepPage
      title="Build the environment"
      description="A version is a snapshot of the machine with your tools installed and repositories cloned. New workspaces start from the active version in seconds."
      wide
      aside={
        panel && (
          <>
            {panel}
            {fixPanel}
          </>
        )
      }
    >
      {body}
      <StepError>{status ? error : null}</StepError>
      {actions && <StepActions>{actions}</StepActions>}
      <LeaveWithoutBuildingDialog
        open={leaving !== null}
        changes={changes}
        unsaved={dirty}
        activeVersion={activeVersion?.number ?? null}
        onKeep={() => setLeaving(null)}
        onLeave={() => {
          const leave = leaving;
          setLeaving(null);
          leave?.();
        }}
      />
    </StepPage>
  );
}
