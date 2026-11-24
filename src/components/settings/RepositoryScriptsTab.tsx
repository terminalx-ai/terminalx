import { useSettingsLeaveGuard } from "./settingsLeaveGuard";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { FileLock, Info, Lock, Play, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EnvironmentInfo } from "@/components/cloud/EnvironmentInfo";
import { errorMessage } from "@/lib/api";
import { useEnvironmentInfoRuntime } from "@/lib/environmentInfoRuntime";
import { configuration, type Configuration, type ConfigurationLayer } from "@/lib/configuration";
import { updateProject, useSessionStore } from "@/lib/sessions";
import { rerunSetup, useWorkspaceSetups } from "@/lib/workspaceSetup";
import { useShortcutKeys } from "@/lib/hotkeys";
import { visibleActions, type RepositoryAction } from "@/lib/repositoryActions";
import { KbdGroup } from "@/components/ui/tooltip";
import type { Project, RepositoryScripts } from "@/types/session";
import { RegisteredSetting } from "./settingsRegistry";
import { ScriptEditor } from "./ScriptEditor";
import { EnvironmentTable } from "./EnvironmentSettings";

type Kind = "setup" | "archive";
const KEYS: Record<Kind, string> = { setup: "setupScript", archive: "archiveScript" };
const TIMEOUT_KEY = "archiveTimeoutMinutes";
/** Matches `ARCHIVE_TIMEOUT_CHOICES` in store/configuration.rs. */
export const ARCHIVE_TIMEOUT_CHOICES = [1, 2, 5, 10, 15, 30] as const;
const DEFAULT_TIMEOUT = 5;
/** The repository's own files, named with their folder so they never read as your ~/.raccoon/settings.json (PRO-388). */
const SHARED_FILE = ".terminalx/settings.json";
const LOCAL_FILE = ".terminalx/settings.local.json";

export function RepositoryScriptsTab({ projectPath }: { projectPath: string }) {
  const { projects } = useSessionStore();
  const project = projects.find((project) => project.path === projectPath && !project.archived && project.kind !== "folder");
  if (!project) return <p className="text-sm text-muted-foreground">Open a repository to configure its scripts.</p>;
  return <RegisteredSetting setting="repositories.scripts" instance={project.path}><div className="min-w-0">
    <ScriptsPage key={project.path} project={project} />
  </div></RegisteredSetting>;
}

/** The resolved layers for this repository, refreshed when its files or the saved scripts change. */
function useResolvedScripts(project: Project) {
  const [resolved, setResolved] = useState<Configuration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await configuration.resolve(project.path);
      if (request === generation.current) { setResolved(next); setError(null); }
    } catch (cause) {
      // An unreadable policy must not leave stale writable editors behind.
      if (request === generation.current) { setResolved(null); setError(errorMessage(cause)); }
    }
  }, [project.path]);
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { if (!live) return; clearTimeout(timer); timer = setTimeout(() => void reload(), 150); };
    // Subscribe before resolving so an edit during the first read is seen.
    void configuration.watch(project.path, changed).then((unsubscribe) => {
      if (!live) { unsubscribe(); return; }
      stop = unsubscribe;
      void reload();
    }).catch(() => { if (live) void reload(); });
    return () => { live = false; clearTimeout(timer); stop?.(); };
  }, [project.path, reload]);
  // The saved scripts are the user layer; they live in the project store, not a watched file.
  useEffect(() => { void reload(); }, [project.scripts, reload]);
  return { resolved, error, reload };
}

function ScriptsPage({ project }: { project: Project }) {
  const { resolved, error, reload } = useResolvedScripts(project);
  const [notNow, setNotNow] = useState(false);
  const [trusting, setTrusting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const trust = resolved?.trust;
  // Only a script whose effective value is the committed one waits for trust; a local override or policy replaces it.
  const untrusted = (kind: Kind) => !!trust?.required && trust.keys.includes(KEYS[kind]) && resolved?.values[KEYS[kind]]?.source === "repositoryShared";
  const scriptsNeedTrust = untrusted("setup") || untrusted("archive");
  const committed = (["setup", "archive"] as const).some((kind) => resolved?.values[KEYS[kind]]?.source === "repositoryShared");
  const environmentId = `${useId()}-environment`;
  const review = async () => {
    setTrusting(true); setActionError(null); setNotice(null);
    try {
      const trusted = await configuration.review(project.path);
      await reload();
      setNotice(trusted ? "Repository scripts trusted. They run from the next workspace on." : "Not trusted. Nothing runs.");
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setTrusting(false); }
  };
  // Design 11.01/11.05: Setup, Run and Archive cards, one footnote for the page, then the project's variables.
  // The project file is opened from the title bar's one Open button (PRO-388), not from here.
  return <section aria-label={`${project.name} scripts`} className="flex flex-col gap-6">
    <header className="min-w-0">
      <h3 className="text-sm font-medium">Scripts</h3>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">Commands that run when a workspace is set up, run or removed.</p>
    </header>
    {scriptsNeedTrust && !notNow && <div role="region" aria-label="Repository trust" className="-mt-2 flex items-center gap-3 rounded-lg border border-warning/50 bg-warning/5 px-4 py-3">
      <ShieldAlert className="size-4 shrink-0 self-start text-warning" aria-hidden />
      <p className="min-w-0 flex-1 text-[13px] leading-5"><span className="font-mono font-medium">{SHARED_FILE}</span> in this repository wants to run commands when a workspace is created or removed. Nothing runs until you trust it.</p>
      <Button variant="outline" size="sm" className="shrink-0 whitespace-nowrap" disabled={trusting} onClick={() => setNotNow(true)}>Not now</Button>
      <Button size="sm" className="shrink-0 whitespace-nowrap" disabled={trusting} onClick={() => void review()}>{trusting ? "Reviewing…" : "Review and trust"}</Button>
    </div>}
    {(error || actionError) && <p role="alert" className="text-xs text-destructive">{error || actionError}</p>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    {resolved?.warnings.filter((warning) => /setupScript|archiveScript|archiveTimeoutMinutes/.test(warning)).map((warning) => <p key={warning} role="status" className="text-xs text-warning">{warning}</p>)}
    {resolved ? <div className="flex flex-col gap-4">
      <ScriptCard kind="setup" project={project} resolved={resolved} reload={reload} untrusted={untrusted("setup")} environmentId={environmentId} />
      <RunCard project={project} />
      <ScriptCard kind="archive" project={project} resolved={resolved} reload={reload} untrusted={untrusted("archive")} environmentId={environmentId} />
      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {committed
          ? <span>Scripts from <span className="font-mono">{SHARED_FILE}</span> are committed in the repository, so everyone on the project gets the same ones. Scripts from a newly cloned repository ask before they run.</span>
          : <span>Saved on this computer for this project as you leave each script. Leave one blank to skip it. Run is the first action in this project's Run menu.</span>}
      </p>
    </div> : !error && <p role="status" className="text-xs text-muted-foreground">Loading scripts…</p>}
    <section id={environmentId} aria-labelledby={`${environmentId}-title`} className="flex min-w-0 scroll-mt-6 flex-col gap-3">
      <div>
        <h4 id={`${environmentId}-title`} className="text-[15px] font-semibold">Environment variables</h4>
        <p className="mt-1 text-[13px] text-muted-foreground">Passed to scripts, agents and terminals in {project.name}, over your personal ones.</p>
      </div>
      <EnvironmentTable key={project.path} project={project.path} projects={[project]} emptyText={`No variables set for ${project.name}.`} />
    </section>
  </section>;
}

function sourceLabel(source: ConfigurationLayer): string | null {
  if (source === "repositoryShared") return `From ${SHARED_FILE} · locked`;
  if (source === "managed") return "Managed policy · locked";
  if (source === "repositoryLocal") return `From ${LOCAL_FILE} · local override`;
  return null;
}

const CARD = "overflow-hidden rounded-lg border border-hairline-strong bg-well";
const CARD_HEADER = "flex min-h-10 items-center gap-2 border-b border-hairline px-3 py-1.5";

/** A script card's header: its name, what it does, and its controls on the right. */
function CardHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className={CARD_HEADER}>
    <h4 className="shrink-0 text-[13px] font-semibold">{title}</h4>
    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{description}</span>
    {children}
  </div>;
}

/** ⌘S or ⌘↵ in a script saves it at once; leaving the field saves it too. */
const saveKey = (event: KeyboardEvent, save: () => void) => {
  if ((event.metaKey || event.ctrlKey) && (event.key === "Enter" || event.key === "s") && !event.nativeEvent.isComposing) {
    event.preventDefault();
    save();
  }
};

function ScriptCard({ kind, project, resolved, reload, untrusted, environmentId }: { kind: Kind; project: Project; resolved: Configuration; reload: () => Promise<void>; untrusted: boolean; environmentId: string }) {
  const entry = resolved.values[KEYS[kind]];
  const source: ConfigurationLayer = entry?.source ?? "defaults";
  const value = typeof entry?.value === "string" ? entry.value : "";
  const timeoutEntry = resolved.values[TIMEOUT_KEY];
  const timeout = typeof timeoutEntry?.value === "number" ? timeoutEntry.value : DEFAULT_TIMEOUT;
  const [overriding, setOverriding] = useState(false);
  // Where a save writes: the Scripts page's own store, or the git-ignored local file over a committed value.
  const target: "user" | "repositoryLocal" | null = source === "managed" ? null
    : source === "repositoryLocal" || (source === "repositoryShared" && overriding) ? "repositoryLocal"
      : source === "repositoryShared" ? null : "user";
  const [draft, setDraft] = useState(value);
  const [draftTimeout, setDraftTimeout] = useState(timeout);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A resolved-value change is not itself an edit (for example removing an override).
  const dirty = edited && (draft !== value || (kind === "archive" && draftTimeout !== timeout));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useSettingsLeaveGuard(dirtyRef.current || busy);
  const saving = useRef(false);
  useEffect(() => {
    // Follow the resolved value until the person starts editing.
    if (!dirtyRef.current) { setDraft(value); setDraftTimeout(timeout); }
  }, [value, timeout, source, edited]);
  const save = async ({ reset = false, script = draft, minutes = draftTimeout }: { reset?: boolean; script?: string; minutes?: number } = {}) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError(null); setMessage(null);
    try {
      if (target === "repositoryLocal") {
        await configuration.write(project.path, "repositoryLocal", KEYS[kind], reset ? null : script);
        if (kind === "archive" && (reset || minutes !== timeout) && !timeoutEntry?.locked) {
          await configuration.write(project.path, "repositoryLocal", TIMEOUT_KEY, reset ? null : minutes);
        }
        if (reset) setOverriding(false);
      } else {
        const saved: RepositoryScripts = { setup: project.scripts?.setup ?? "", archive: project.scripts?.archive ?? "", archiveTimeoutMinutes: project.scripts?.archiveTimeoutMinutes ?? null };
        const next: RepositoryScripts = { ...saved, [kind]: script };
        if (kind === "archive") next.archiveTimeoutMinutes = minutes === DEFAULT_TIMEOUT ? null : minutes;
        if (next.archiveTimeoutMinutes == null) delete next.archiveTimeoutMinutes;
        await updateProject(project.path, { scripts: next });
      }
      await reload();
      setEdited(false);
      setMessage(reset ? "Local override removed." : `${kind === "setup" ? "Setup" : "Archive"} script saved.`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { saving.current = false; setBusy(false); }
  };
  const label = kind === "setup" ? "Setup script" : "Archive script";
  const chip = sourceLabel(source);
  const locked = target === null;
  const timeoutLocked = locked || !!timeoutEntry?.locked || (timeoutEntry?.source === "repositoryShared" && target !== "repositoryLocal");
  const saveIfChanged = () => { if (!locked && dirtyRef.current) void save(); };
  const note = source === "repositoryShared" || source === "repositoryLocal" || source === "managed";
  return <div className="flex flex-col gap-2">
    <div role="group" aria-label={kind === "setup" ? "Setup" : "Archive"} className={CARD}>
      <CardHeader title={kind === "setup" ? "Setup" : "Archive"} description={kind === "setup" ? "runs once when a worktree is created" : "runs before a worktree is removed"}>
        {!locked && (dirty || busy) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : `Save ${kind} script`}</Button>}
        {locked && <Lock className="size-3.5 shrink-0 text-warning" aria-label="Locked" />}
        {chip && <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-mention/10 px-1.5 py-0.5 text-[11px] text-mention"><FileLock className="size-3" aria-hidden />{chip}</span>}
        {kind === "setup" ? <SetupEnvironmentInfo projectPath={project.path} environmentId={environmentId} /> : <label className="flex shrink-0 items-center gap-2 text-xs text-faint" title="If it fails or times out, TerminalX asks before removing the worktree.">timeout
          <select aria-label="Archive timeout" disabled={busy || timeoutLocked} value={draftTimeout} onChange={(event) => {
            const minutes = Number(event.target.value);
            setEdited(true); setDraftTimeout(minutes); setMessage(null);
            void save({ minutes });
          }}
            className="h-6 rounded-md border border-hairline-strong bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60">
            {ARCHIVE_TIMEOUT_CHOICES.map((minutes) => <option key={minutes} value={minutes}>{minutes} minute{minutes === 1 ? "" : "s"}</option>)}
          </select>
        </label>}
      </CardHeader>
      <div onKeyDown={(event) => saveKey(event, saveIfChanged)}>
        <ScriptEditor label={label} value={draft} readOnly={locked} disabled={busy} onBlur={saveIfChanged}
          placeholder={kind === "setup" ? "pnpm install" : "docker compose down"} onChange={(next) => { setEdited(true); setDraft(next); setMessage(null); }} />
      </div>
    </div>
    {(note || kind === "setup") && <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
        {source === "repositoryShared" && !overriding && <><Lock className="size-3.5 shrink-0 text-warning" aria-hidden />
          <span>Edits go in your own <span className="font-mono">{LOCAL_FILE}</span>, which git ignores.</span>
          <button type="button" className="whitespace-nowrap text-foreground underline underline-offset-2 hover:opacity-80" onClick={() => setOverriding(true)}>Override locally</button></>}
        {source === "repositoryShared" && overriding && <span>Your edits save to <span className="font-mono">{LOCAL_FILE}</span>, which git ignores. The committed script stays as it is.</span>}
        {source === "repositoryLocal" && <><span>Saved in your own <span className="font-mono">{LOCAL_FILE}</span>, which git ignores.</span>
          <button type="button" disabled={busy} className="whitespace-nowrap text-foreground underline underline-offset-2 hover:opacity-80" onClick={() => void save({ reset: true })}>Remove local override</button></>}
        {source === "managed" && <span>Set by your organization's managed policy. It cannot be changed here.</span>}
      </p>
      {kind === "setup" && <RunSetupNow project={project} disabled={dirty || busy || !value.trim() || untrusted} />}
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </div>;
}

/**
 * Run (design 11.01): the command ⌘R starts, which is the first visible action of the project's Run menu. Editing it
 * changes that action; with no actions yet, a command makes one named Run.
 */
function RunCard({ project }: { project: Project }) {
  const actions = project.actions ?? [];
  const first = visibleActions(actions)[0];
  const value = first?.command ?? "";
  const keys = useShortcutKeys("session.runAction");
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = draft !== value;
  useSettingsLeaveGuard(dirtyRef.current || busy);
  const saving = useRef(false);
  useEffect(() => { if (!dirtyRef.current) setDraft(value); }, [value, first?.id]);
  const save = async () => {
    if (saving.current || !dirtyRef.current) return;
    if (!draft.trim()) {
      if (first) setError(`Enter a command, or hide or delete “${first.name}” in Actions.`);
      return;
    }
    saving.current = true;
    setBusy(true); setError(null); setMessage(null);
    try {
      const names = new Set(actions.map((action) => action.name.trim().toLowerCase()));
      let name = "Run";
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `Run ${n}`;
      const next: RepositoryAction[] = first
        ? actions.map((action) => action.id === first.id ? { ...action, command: draft } : action)
        : [{ id: crypto.randomUUID(), name, icon: "play", command: draft, runAfterSetup: false, concurrent: false, hidden: false }, ...actions];
      await updateProject(project.path, { actions: next });
      dirtyRef.current = false;
      setMessage("Run command saved.");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <div className="flex flex-col gap-2">
    <div role="group" aria-label="Run" className={CARD}>
      <CardHeader title="Run" description={first && first.name !== "Run" ? `starts and stops the app for this session · ${first.name}` : "starts and stops the app for this session"}>
        {(dirtyRef.current || busy) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save run script"}</Button>}
        {keys.length > 0 && <KbdGroup keys={keys} />}
      </CardHeader>
      <div onKeyDown={(event) => saveKey(event, () => void save())}>
        <ScriptEditor label="Run script" value={draft} disabled={busy} onBlur={() => void save()} placeholder="pnpm dev"
          onChange={(next) => { setDraft(next); setMessage(null); setError(null); }} />
      </div>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </div>;
}

function SetupEnvironmentInfo({ projectPath, environmentId }: { projectPath: string; environmentId: string }) {
  const { enabled, scopeKey, target } = useEnvironmentInfoRuntime({ projectPath });
  const trigger = <button type="button" className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-hairline-strong px-2 text-xs text-muted-foreground outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-veil-raised">
    <Info className="size-3.5" aria-hidden /> Environment info
  </button>;
  const help = <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs leading-5 text-muted-foreground marker:text-faint">
    <li>Runs in the new workspace’s folder, in a visible Setup tab.</li>
    <li>Loads <PopoverPrimitive.Close asChild><button type="button" className="text-foreground underline underline-offset-2 hover:opacity-80" onClick={() => document.getElementById(environmentId)?.scrollIntoView({ block: "start", behavior: "smooth" })}>your and the project’s variables</button></PopoverPrimitive.Close>.</li>
    <li><span className="font-mono">$TERMINALX_REPO_ROOT</span> is the project root; <span className="font-mono">$TERMINALX_WORKSPACE_PATH</span> the workspace.</li>
  </ul>;

  if (enabled) return <EnvironmentInfo scopeKey={scopeKey} trigger={trigger} {...target}>
    <div className="mt-3 border-t border-hairline pt-3">{help}</div>
  </EnvironmentInfo>;

  return <PopoverPrimitive.Root>
    <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content side="bottom" align="end" sideOffset={6} aria-label="Environment info"
        className="z-(--z-menu) w-[20.5rem] max-w-[calc(100vw-2rem)] rounded-lg bg-popover px-4 py-3 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in">
        {help}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

/** Runs the saved setup in the current workspace: the selected session's, or this repository's most recent one. */
function RunSetupNow({ project, disabled }: { project: Project; disabled: boolean }) {
  const { sessions = [], selectedSessionId } = useSessionStore();
  const { runs } = useWorkspaceSetups();
  const workspaces = sessions.filter((session) => session.projectPath === project.path && session.worktreeName && !session.worktreeRemoved && !session.archived);
  const current = workspaces.find((session) => session.id === selectedSessionId) ?? workspaces[0];
  const run = runs.find((run) => run.sessionId === current?.id);
  const active = !!run && ["pending", "running", "stopping"].includes(run.status);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return <>
    <Button variant="outline" size="sm" className="shrink-0 whitespace-nowrap" disabled={disabled || busy || active || !current}
      title={current ? `Runs in ${current.worktreeName}` : "Open a workspace of this repository to run setup now."}
      onClick={async () => {
        if (!current) return;
        setBusy(true); setError(null); setMessage(null);
        try { await rerunSetup(current.id); setMessage(`Setup queued in ${current.worktreeName}. Its Setup tab shows progress and offers Stop.`); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(false); }
      }}><Play /> {busy ? "Starting…" : active ? "Setup running" : "Run setup now"}</Button>
    {(message || error) && <p role={error ? "alert" : "status"} className={`basis-full text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{error || message}</p>}
  </>;
}
