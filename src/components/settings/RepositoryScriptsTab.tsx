import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { updateProject, useSessionStore } from "@/lib/sessions";
import type { Project, RepositoryScripts } from "@/types/session";
import { RegisteredSetting } from "./settingsRegistry";

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
    <p className="text-xs text-muted-foreground">Saved on this computer for this repository. Archive scripts run with /bin/sh in the workspace, with the local runtime environment, login-shell PATH, TERMINALX_WORKSPACE_PATH, TERMINALX_REPO_ROOT, TERMINALX_BRANCH and TERMINALX_SESSION_ID when a session exists. Agent-only credentials and CLI attribution are not inherited.</p>
    {(["setup", "archive"] as const).map((kind) => <label key={kind} className="flex flex-col gap-2 text-sm">
      {kind === "setup" ? "Setup script" : "Archive script"}
      <textarea aria-label={kind === "setup" ? "Setup script" : "Archive script"} spellCheck={false} disabled={busy}
        className="min-h-32 resize-y rounded-md border border-hairline bg-well p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        value={scripts[kind]} onChange={(event) => { setScripts({ ...scripts, [kind]: event.target.value }); setMessage(""); }} />
      <span className="text-xs text-muted-foreground">{kind === "setup"
        ? "You can save setup scripts here. Running setup on new workspaces and Run setup now are not available in this version."
        : "Runs before a workspace is removed. Removal waits up to 5 minutes and asks before continuing if the script fails. Leave blank to skip."}</span>
    </label>)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    <Button disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save scripts"}</Button>
  </section>;
}
