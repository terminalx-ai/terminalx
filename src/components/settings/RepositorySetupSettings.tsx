import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage, invoke } from "@/lib/api";
import { RegisteredSetting } from "./settingsRegistry";
import { repositoryInputClass } from "./repositoryEditor";

export function RepositorySetupSettings({ projectPath }: { projectPath: string }) {
  const [command, setCommand] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setSaved(null);
    setError(null);
    invoke<string | null>("repository_setup_script", { projectPath }).then((value) => {
      if (current) { setCommand(value ?? ""); setSaved(value ?? ""); }
    }).catch((error) => { if (current) setError(errorMessage(error)); });
    return () => { current = false; };
  }, [projectPath]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = await invoke<string | null>("repository_setup_script", { projectPath, command });
      setCommand(value ?? "");
      setSaved(value ?? "");
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <RegisteredSetting setting="repositories.setup" instance={projectPath}>
    <section className="mb-6 space-y-3" aria-label="Workspace setup">
      <label htmlFor="repository-setup" className="block text-sm font-medium">Setup script</label>
      <p className="text-xs text-muted-foreground">Runs once in each new worktree. Saved as scripts.setup in terminalx.json in this repository. Leave empty to disable.</p>
      <textarea id="repository-setup" rows={4} spellCheck={false} disabled={saved === null || busy} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="bun install" className={`${repositoryInputClass} font-mono`} />
      <p className="text-xs text-muted-foreground">Runs in the worktree with /bin/sh on macOS and Linux, or your shell on Windows. Available variables: TERMINALX_WORKSPACE_PATH, TERMINALX_REPO_ROOT and TERMINALX_BRANCH.</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <Button size="sm" variant="outline" disabled={saved === null || busy || command === saved} onClick={() => void save()}>{busy ? "Saving…" : "Save setup script"}</Button>
    </section>
  </RegisteredSetting>;
}
