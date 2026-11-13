import { useCallback, useEffect, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { openPath } from "@tauri-apps/plugin-opener";
import { FileLock, FileText, Info, Lock, Play, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { configuration, type Configuration, type ConfigurationLayer } from "@/lib/configuration";
import { updateProject, useSessionStore } from "@/lib/sessions";
import { rerunSetup, useWorkspaceSetups } from "@/lib/workspaceSetup";
import type { Project, RepositoryScripts } from "@/types/session";
import { RegisteredSetting } from "./settingsRegistry";
import { ScriptEditor } from "./ScriptEditor";

type Kind = "setup" | "archive";
const KEYS: Record<Kind, string> = { setup: "setupScript", archive: "archiveScript" };
const TIMEOUT_KEY = "archiveTimeoutMinutes";
/** Matches `ARCHIVE_TIMEOUT_CHOICES` in store/configuration.rs. */
export const ARCHIVE_TIMEOUT_CHOICES = [1, 2, 5, 10, 15, 30] as const;
const DEFAULT_TIMEOUT = 5;
const SHARED_FILE = "settings.json";
const LOCAL_FILE = "settings.local.json";

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
  const scriptsNeedTrust = !!trust?.required && trust.keys.some((key) => key === KEYS.setup || key === KEYS.archive);
  const sharedFile = `${project.path}/.terminalx/${SHARED_FILE}`;
  const review = async () => {
    setTrusting(true); setActionError(null); setNotice(null);
    try {
      const trusted = await configuration.review(project.path);
      await reload();
      setNotice(trusted ? "Repository scripts trusted. They run from the next workspace on." : "Not trusted. Nothing runs.");
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setTrusting(false); }
  };
  return <section aria-label={`${project.name} scripts`} className="flex flex-col gap-6">
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-xl font-semibold tracking-tight">Scripts</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">Commands that run when a workspace is set up or removed. The run command lives in Actions.</p>
      </div>
      {trust && <Button variant="outline" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => void openPath(sharedFile).catch((cause) => setActionError(errorMessage(cause)))}>
        <FileText /> Open <span className="font-mono">{SHARED_FILE}</span>
      </Button>}
    </header>
    {scriptsNeedTrust && !notNow && <div role="region" aria-label="Repository trust" className="-mt-2 flex items-center gap-3 rounded-lg border border-warning/50 bg-warning/5 px-4 py-3">
      <ShieldAlert className="size-4 shrink-0 self-start text-warning" aria-hidden />
      <p className="min-w-0 flex-1 text-[13px] leading-5"><span className="font-mono font-medium">.terminalx/{SHARED_FILE}</span> in this repository wants to run commands when a workspace is created or removed. Nothing runs until you trust it.</p>
      <Button variant="outline" size="sm" className="shrink-0 whitespace-nowrap" disabled={trusting} onClick={() => setNotNow(true)}>Not now</Button>
      <Button variant="secondary" size="sm" className="shrink-0 whitespace-nowrap" disabled={trusting} onClick={() => void review()}>{trusting ? "Reviewing…" : "Review and trust"}</Button>
    </div>}
    {(error || actionError) && <p role="alert" className="text-xs text-destructive">{error || actionError}</p>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    {resolved?.warnings.filter((warning) => /setupScript|archiveScript|archiveTimeoutMinutes/.test(warning)).map((warning) => <p key={warning} role="status" className="text-xs text-warning">{warning}</p>)}
    {resolved ? <>
      <ScriptCard kind="setup" project={project} resolved={resolved} reload={reload} untrusted={scriptsNeedTrust && trust!.keys.includes(KEYS.setup)} />
      <ScriptCard kind="archive" project={project} resolved={resolved} reload={reload} untrusted={scriptsNeedTrust && trust!.keys.includes(KEYS.archive)} />
    </> : !error && <p role="status" className="text-xs text-muted-foreground">Loading scripts…</p>}
  </section>;
}

function sourceLabel(source: ConfigurationLayer): string | null {
  if (source === "repositoryShared") return `From ${SHARED_FILE} · locked`;
  if (source === "managed") return "Managed policy · locked";
  if (source === "repositoryLocal") return `From ${LOCAL_FILE} · local override`;
  return null;
}

function ScriptCard({ kind, project, resolved, reload, untrusted }: { kind: Kind; project: Project; resolved: Configuration; reload: () => Promise<void>; untrusted: boolean }) {
  const entry = resolved.values[KEYS[kind]];
  const source: ConfigurationLayer = entry?.source ?? "defaults";
  const value = typeof entry?.value === "string" ? entry.value : "";
  const timeoutEntry = resolved.values[TIMEOUT_KEY];
  const timeout = typeof timeoutEntry?.value === "number" ? timeoutEntry.value : DEFAULT_TIMEOUT;
  const [overriding, setOverriding] = useState(false);
  // Where Save writes: the Scripts page's own store, or the git-ignored local file over a committed value.
  const target: "user" | "repositoryLocal" | null = source === "managed" ? null
    : source === "repositoryLocal" || (source === "repositoryShared" && overriding) ? "repositoryLocal"
      : source === "repositoryShared" ? null : "user";
  const [draft, setDraft] = useState(value);
  const [draftTimeout, setDraftTimeout] = useState(timeout);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = draft !== value || (kind === "archive" && draftTimeout !== timeout);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    // Follow the resolved value until the person starts editing.
    if (!dirtyRef.current) { setDraft(value); setDraftTimeout(timeout); }
  }, [value, timeout, source]);
  const save = async (reset = false) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      if (target === "repositoryLocal") {
        await configuration.write(project.path, "repositoryLocal", KEYS[kind], reset ? null : draft);
        if (kind === "archive" && (reset || draftTimeout !== timeout) && !timeoutEntry?.locked) {
          await configuration.write(project.path, "repositoryLocal", TIMEOUT_KEY, reset ? null : draftTimeout);
        }
        if (reset) setOverriding(false);
      } else {
        const saved: RepositoryScripts = { setup: project.scripts?.setup ?? "", archive: project.scripts?.archive ?? "", archiveTimeoutMinutes: project.scripts?.archiveTimeoutMinutes ?? null };
        const next: RepositoryScripts = { ...saved, [kind]: draft };
        if (kind === "archive") next.archiveTimeoutMinutes = draftTimeout === DEFAULT_TIMEOUT ? null : draftTimeout;
        if (next.archiveTimeoutMinutes == null) delete next.archiveTimeoutMinutes;
        await updateProject(project.path, { scripts: next });
      }
      dirtyRef.current = false;
      await reload();
      setMessage(reset ? "Local override removed." : `${kind === "setup" ? "Setup" : "Archive"} script saved.`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const label = kind === "setup" ? "Setup script" : "Archive script";
  const chip = sourceLabel(source);
  const locked = target === null;
  const timeoutLocked = locked || !!timeoutEntry?.locked || (timeoutEntry?.source === "repositoryShared" && target !== "repositoryLocal");
  return <div className="flex flex-col gap-2.5">
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h4 className="text-[15px] font-semibold">{label}</h4>
        <p className="mt-1 text-[13px] text-muted-foreground">{kind === "setup" ? "Runs once when a new workspace is created." : "Runs in the workspace before it is removed. If it fails or times out, TerminalX asks before removing."}</p>
      </div>
      {chip && <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-mention/10 px-1.5 py-0.5 text-[11px] text-mention"><FileLock className="size-3" aria-hidden />{chip}</span>}
    </div>
    <div className="rounded-lg border border-hairline-strong bg-well">
      <div className="flex h-9 items-center justify-between gap-2 border-b border-hairline px-3">
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {locked && <Lock className="size-3.5 text-warning" aria-label="Locked" />}
          <span className="truncate">{kind}.sh</span>
        </span>
        {kind === "setup" ? <EnvironmentInfo /> : <label className="flex items-center gap-2 text-xs text-faint">timeout
          <select aria-label="Archive timeout" disabled={busy || timeoutLocked} value={draftTimeout} onChange={(event) => { setDraftTimeout(Number(event.target.value)); setMessage(null); }}
            className="h-6 rounded-md border border-hairline-strong bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60">
            {ARCHIVE_TIMEOUT_CHOICES.map((minutes) => <option key={minutes} value={minutes}>{minutes} minute{minutes === 1 ? "" : "s"}</option>)}
          </select>
        </label>}
      </div>
      <ScriptEditor label={label} value={draft} readOnly={locked} disabled={busy}
        placeholder={kind === "setup" ? "pnpm install" : "docker compose down"} onChange={(next) => { setDraft(next); setMessage(null); }} />
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
        {source === "repositoryShared" && !overriding && <><Lock className="size-3.5 shrink-0 text-warning" aria-hidden />
          <span>Edits go in your own <span className="font-mono">{LOCAL_FILE}</span>, which git ignores.</span>
          <button type="button" className="whitespace-nowrap text-foreground underline underline-offset-2 hover:opacity-80" onClick={() => setOverriding(true)}>Override locally</button></>}
        {source === "repositoryShared" && overriding && <span>Saving writes your own <span className="font-mono">{LOCAL_FILE}</span>, which git ignores. The committed script stays as it is.</span>}
        {source === "repositoryLocal" && <><span>Saved in your own <span className="font-mono">{LOCAL_FILE}</span>, which git ignores.</span>
          <button type="button" disabled={busy} className="whitespace-nowrap text-foreground underline underline-offset-2 hover:opacity-80" onClick={() => void save(true)}>Remove local override</button></>}
        {source === "managed" && <span>Set by your organization's managed policy. It cannot be changed here.</span>}
        {(source === "user" || source === "defaults") && <span>Saved on this computer for this repository. Leave blank to skip.</span>}
      </p>
      {kind === "setup" && <RunSetupNow project={project} disabled={dirty || busy || !value.trim() || untrusted} />}
      {!locked && <Button size="sm" className="shrink-0 whitespace-nowrap" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>}
    </div>
    {untrusted && <p className="text-xs text-warning">This script comes from a file that is not trusted yet. It does not run until you choose Review and trust.</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </div>;
}

function EnvironmentInfo() {
  return <PopoverPrimitive.Root>
    <PopoverPrimitive.Trigger asChild>
      <button type="button" className="flex h-6 items-center gap-1.5 rounded-md border border-hairline-strong px-2 text-xs text-muted-foreground outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-veil-raised">
        <Info className="size-3.5" aria-hidden /> Environment info
      </button>
    </PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content side="bottom" align="end" sideOffset={6} aria-label="Environment info"
        className="z-(--z-menu) w-[20.5rem] max-w-[calc(100vw-2rem)] rounded-lg bg-popover p-4 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in">
        <ul className="flex list-disc flex-col gap-2 pl-4 text-xs leading-5 text-muted-foreground marker:text-faint">
          <li>Runs with /bin/sh in the new workspace’s folder, in a visible Setup tab. Agents can start while it runs; it stops after 30 minutes, and at most two run at once.</li>
          <li>Loads your variables and this repository’s from Settings → Environment, and your login shell’s PATH. Agent-only credentials are not passed on.</li>
          <li><span className="font-mono">$TERMINALX_REPO_ROOT</span> is the project root and <span className="font-mono">$TERMINALX_WORKSPACE_PATH</span> the workspace; <span className="font-mono">$TERMINALX_BRANCH</span> and <span className="font-mono">$TERMINALX_SESSION_ID</span> name its branch and session.</li>
        </ul>
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
