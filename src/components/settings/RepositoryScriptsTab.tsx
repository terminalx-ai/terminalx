import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { updateProject, useSessionStore } from "@/lib/sessions";
import type { Project, RepositoryScripts } from "@/types/session";
import { RegisteredSetting } from "./settingsRegistry";
import { rerunSetup, useWorkspaceSetups } from "@/lib/workspaceSetup";

export function RepositoryScriptsTab({ projectPath }: { projectPath: string }) {
  const { projects } = useSessionStore();
  const project = projects.find((project) => project.path === projectPath && !project.archived && project.kind !== "folder");
  if (!project) return <p className="text-sm text-muted-foreground">Open a repository to configure its scripts.</p>;
  return <RegisteredSetting setting="repositories.scripts" instance={project.path}><div className="space-y-5">
    <p className="break-all font-mono text-xs text-faint">{project.path}</p>
    <ScriptsEditor key={project.path} project={project} />
  </div></RegisteredSetting>;
}

function ScriptsEditor({ project }: { project: Project }) {
  const [scripts, setScripts] = useState<RepositoryScripts>(() => project.scripts ?? { setup: "", archive: "" });
  const [saved, setSaved] = useState(scripts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const dirty = scripts.setup !== saved.setup || scripts.archive !== saved.archive;
  const externalScripts = useRef(project.scripts);
  useEffect(() => {
    if (externalScripts.current === project.scripts) return;
    externalScripts.current = project.scripts;
    if (dirty || busy) return;
    const current = project.scripts ?? { setup: "", archive: "" };
    if (current.setup !== saved.setup || current.archive !== saved.archive) {
      setScripts(current);
      setSaved(current);
    }
  }, [project.scripts, dirty, busy, saved]);
  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      await updateProject(project.path, { scripts });
      setSaved(scripts);
      setMessage("Scripts saved.");
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <section aria-label={`${project.name} scripts`} className="space-y-4">
    <h3 className="text-base font-medium">Scripts</h3>
    <p className="text-xs text-muted-foreground">Saved on this computer for this repository. Scripts run with /bin/sh in the workspace, with the local runtime environment, user and repository variables from Settings, login-shell PATH, TERMINALX_WORKSPACE_PATH, TERMINALX_REPO_ROOT, TERMINALX_BRANCH and TERMINALX_SESSION_ID when a session exists. Agent-only credentials and CLI attribution are not inherited. Commands are never read from repository files.</p>
    {(["setup", "archive"] as const).map((kind) => <label key={kind} className="flex flex-col gap-2 text-sm">
      {kind === "setup" ? "Setup script" : "Archive script"}
      <textarea aria-label={kind === "setup" ? "Setup script" : "Archive script"} spellCheck={false} disabled={busy}
        className="min-h-32 resize-y rounded-md border border-hairline bg-well p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        value={scripts[kind]} onChange={(event) => { setScripts({ ...scripts, [kind]: event.target.value }); setMessage(""); }} />
      <span className="text-xs text-muted-foreground">{kind === "setup"
        ? "Runs once after a new worktree is created. At most two setups run at once; others queue. Setup stops after 30 minutes, and Stop and Rerun are available in its terminal tab. Agents can start while setup runs. Leave blank to skip."
        : "Runs before a workspace is removed. Removal waits up to 5 minutes and asks before continuing if the script fails. Leave blank to skip."}</span>
    </label>)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    <Button disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save scripts"}</Button>
    <SetupControls project={project} disabled={dirty || busy || !saved.setup.trim()} />
  </section>;
}

function SetupControls({ project, disabled }: { project: Project; disabled: boolean }) {
  const { sessions = [], selectedSessionId } = useSessionStore();
  const { runs } = useWorkspaceSetups();
  const workspaces = sessions.filter((session) => session.projectPath === project.path && session.worktreeName && !session.worktreeRemoved && !session.archived)
    .filter((session, index, all) => all.findIndex((other) => other.cwd === session.cwd) === index);
  const [picked, setPicked] = useState<string | null>(null);
  const current = workspaces.find((session) => session.id === picked) ?? workspaces.find((session) => session.id === selectedSessionId) ?? workspaces[0];
  const run = runs.find((run) => run.sessionId === current?.id);
  const active = run && ["pending", "running", "stopping"].includes(run.status);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return <div className="space-y-2 border-t border-hairline pt-4">
    {workspaces.length ? <label className="flex flex-col gap-2 text-xs">Setup workspace
      <select aria-label="Setup workspace" className="rounded-md border border-hairline bg-well p-2" value={current?.id} disabled={busy} onChange={(event) => { setPicked(event.target.value); setMessage(null); setError(null); }}>
        {workspaces.map((session) => <option key={session.id} value={session.id}>{session.worktreeName}</option>)}
      </select>
    </label> : <p className="text-xs text-muted-foreground">Open a worktree to run setup now.</p>}
    <Button variant="outline" disabled={disabled || busy || !!active || !current} onClick={async () => {
      if (!current) return;
      setBusy(true); setError(null); setMessage(null);
      try { await rerunSetup(current.id); setMessage("Setup queued. Its terminal tab shows progress and offers Stop."); }
      catch (error) { setError(errorMessage(error)); }
      finally { setBusy(false); }
    }}>{busy ? "Starting…" : run ? "Rerun setup" : "Run setup now"}</Button>
    {disabled && <p className="text-xs text-muted-foreground">Save a setup script before running it.</p>}
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
