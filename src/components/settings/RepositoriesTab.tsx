import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { updateProject, useSessionStore } from "@/lib/sessions";
import type { Project } from "@/types/session";
import type { RepositoryFilesPreview } from "@/types/repositorySettings";
import { RegisteredSetting, type SettingId } from "./settingsRegistry";
import { MergedCleanupSettings } from "./MergedCleanupSettings";
import { RepositoryOrchestratorSettings } from "./OrchestratorSettings";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { RepositoryScriptsTab } from "./RepositoryScriptsTab";
import { SparseCheckoutRow } from "./SparseCheckoutRow";

export function RepositoriesTab({ projectPath, row, onSelectRow }: { projectPath?: string; row?: string | null; onSelectRow?: (row: SettingId) => void }) {
  const { projects } = useSessionStore();
  const project = projects.find((project) => !project.archived && project.path === projectPath);
  const orchestratorRuns = useExperimentalSettings()?.orchestratorRuns === true;
  if (!project) return <p className="text-sm text-muted-foreground">Choose a repository to view its settings.</p>;
  if (project.kind === "folder") return <MergedCleanupSettings projectPath={project.path} />;
  const page = row === "repositories.filesToCopy" ? "files" : row === "repositories.scripts" ? "scripts" : "general";
  const tab = (id: typeof page, label: string, target: SettingId) => <Button size="sm" variant={page === id ? "outline" : "ghost"} aria-current={page === id ? "page" : undefined} onClick={() => onSelectRow?.(target)}>{label}</Button>;
  return <>
    <nav aria-label="Repository settings" className="mb-5 flex flex-wrap gap-2">
      {tab("general", "General", "repositories.rootPath")}
      {tab("scripts", "Scripts", "repositories.scripts")}
      {tab("files", "Files to copy", "repositories.filesToCopy")}
    </nav>
    {page === "scripts" ? <RepositoryScriptsTab projectPath={project.path} /> : <>
      <RepositorySettingsPage key={project.path} project={project} page={page} />
      <div hidden={page === "files"}>
        <div className="mt-8"><MergedCleanupSettings projectPath={project.path} /></div>
        {orchestratorRuns && <div className="mt-8"><RepositoryOrchestratorSettings projectPath={project.path} /></div>}
      </div>
    </>}
  </>;
}

export function RepositorySettingsPage({ project, page }: { project: Project; page: "general" | "files" }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<RepositoryFilesPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(() => crypto.randomUUID());
  const stored = (project.repositorySettings?.filesToCopy ?? []).join("\n");
  const text = draft ?? stored;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      api.repositoryFilesPreview(project.path, lines(text), snapshot).then((value) => {
        if (live) { setPreview(value); setError(value.error ?? null); }
      }).catch((error) => {
        if (live) { setPreview(null); setError(errorMessage(error)); }
      }).finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [project.path, text, snapshot]);

  const action = async (run: () => Promise<unknown>) => {
    try { await run(); } catch (error) { setError(errorMessage(error)); }
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateProject(project.path, { repositorySettings: { filesToCopy: lines(text) } });
      setDraft(null);
      setSnapshot(crypto.randomUUID());
    } catch (error) {
      setError(errorMessage(error));
    } finally { setSaving(false); }
  };
  const pathRow = (label: string, path: string) => (
    <div className="flex flex-wrap items-center gap-3 border-b border-hairline py-4">
      <div className="min-w-0 flex-1 basis-48">
        <h4 className="text-sm font-medium">{label}</h4>
        <p className="break-all font-mono text-xs text-muted-foreground">{path}</p>
      </div>
      <Button size="sm" variant="outline" aria-label={`Reveal ${label.toLowerCase()}`} onClick={() => void action(() => revealItemInDir(path))}>Reveal</Button>
      <Button size="sm" variant="outline" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void action(() => copyText(path))}>Copy</Button>
    </div>
  );

  return (
    <div className="min-w-0">
      <h3 className="mb-3 text-base font-medium">{page === "general" ? "General" : "Files to copy"}</h3>
      {page === "general" ? (
        <>
          <RegisteredSetting setting="repositories.rootPath" instance={project.path}>{pathRow("Root path", project.path)}</RegisteredSetting>
          {preview && <RegisteredSetting setting="repositories.workspacesPath" instance={project.path}>{pathRow("Workspaces path", preview.workspacesPath)}</RegisteredSetting>}
          <RegisteredSetting setting="repositories.sparseCheckout" instance={project.path}><SparseCheckoutRow project={project} /></RegisteredSetting>
        </>
      ) : (
        <RegisteredSetting setting="repositories.filesToCopy" instance={project.path}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">Copy up to 1,000 matching files and 100 MiB into each new workspace. Files must be ignored and untracked in both checkouts. Existing files, symbolic links and .gitignore files are skipped.</p>
          <p className="text-xs text-muted-foreground">Both lists use positive globs from the repository root: .env matches only the root, **/.env matches any folder, and secrets/** includes a directory's contents. Leading / and ! exclusions are unsupported. In .worktreeinclude, blank lines and # comments are ignored.</p>
          {preview?.fromIncludeFile && <p role="status" className="text-sm">Patterns come from this repository's .worktreeinclude</p>}
          <label htmlFor="repository-copy-patterns" className="text-sm font-medium">Glob patterns (one per line)</label>
          <textarea
            id="repository-copy-patterns"
            className="min-h-28 w-full rounded-md border border-hairline bg-well p-3 font-mono text-sm"
            placeholder={".env*\nconfig/local/**"}
            spellCheck={false}
            value={preview?.fromIncludeFile ? preview.patterns.map((item) => item.pattern).join("\n") : text}
            readOnly={(draft === null && !preview && loading) || !!preview?.fromIncludeFile}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex gap-2">
            {!preview?.fromIncludeFile && <Button size="sm" disabled={saving || loading || !preview || !!preview.error || draft === null || text === stored || preview.patterns.some((item) => item.error)} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>}
            <Button size="sm" variant="outline" disabled={saving} onClick={() => setSnapshot(crypto.randomUUID())}>Refresh preview</Button>
          </div>
          <h4 className="text-sm font-medium">Ignored files matching each pattern</h4>
          <p className="text-xs text-muted-foreground">Preview uses a snapshot of this repository's ignored files. Refresh after files or ignore rules change. Workspace creation checks the files and destination rules again.</p>
          {preview?.warning && <p role="status" className="text-xs text-warning">{preview.warning}</p>}
          {loading ? <p role="status" className="text-xs text-muted-foreground">Updating preview…</p> : preview && (
            <div className="flex flex-col gap-3" aria-label="Ignored files preview">
              {!preview.patterns.length && !preview.error && <p className="text-xs text-muted-foreground">No patterns. No files will be copied.</p>}
              {preview.patterns.map((item, index) => (
                <div key={`${index}:${item.pattern}`} className="rounded-md border border-hairline p-3">
                  <div className="break-all font-mono text-sm">{item.pattern}</div>
                  {item.error ? <p role="alert" className="text-xs text-destructive">{item.error}</p> : item.matches.length ? (
                    <ul className="mt-2 max-h-60 overflow-y-auto text-xs text-muted-foreground">
                      {item.matches.map((path) => <li key={path} className="break-all font-mono">{path}</li>)}
                    </ul>
                  ) : <p className="mt-2 text-xs text-muted-foreground">No ignored files match.</p>}
                  {!!item.omitted && <p className="mt-2 text-xs text-muted-foreground">{item.omitted} more matches omitted from preview.</p>}
                </div>
              ))}
            </div>
          )}
        </div>
        </RegisteredSetting>
      )}
      {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error}</p>}
    </div>
  );
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}
