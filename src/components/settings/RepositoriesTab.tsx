import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { updateProject, useSessionStore } from "@/lib/sessions";
import type { Project } from "@/types/session";
import type { RepositoryFilesPreview } from "@/types/repositorySettings";

/** Self-contained until the grouped settings registry (PRO-123) lands. */
export function RepositoriesTab() {
  const { projects } = useSessionStore();
  const [path, setPath] = useState<string | null>(null);
  const repositories = projects.filter((project) => project.kind !== "folder");
  const project = repositories.find((project) => project.path === path);
  if (project) return <RepositorySettingsPage key={project.path} project={project} onBack={() => setPath(null)} />;
  return (
    <div className="flex flex-col gap-2">
      {!repositories.length && <p className="text-sm text-muted-foreground">Open a Git repository to configure its workspaces.</p>}
      {repositories.map((project) => (
        <button key={project.path} type="button" onClick={() => setPath(project.path)} className="min-w-0 rounded-md border border-hairline p-3 text-left hover:bg-veil-raised">
          <span className="block text-sm font-medium">{project.name}</span>
          <span className="block truncate text-xs text-muted-foreground" title={project.path}>{project.path}</span>
        </button>
      ))}
    </div>
  );
}

export function RepositorySettingsPage({ project, onBack }: { project: Project; onBack: () => void }) {
  const [page, setPage] = useState<"general" | "files">("general");
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<RepositoryFilesPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const stored = (project.repositorySettings?.filesToCopy ?? []).join("\n");
  const text = draft ?? stored;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      api.repositoryFilesPreview(project.path, lines(text)).then((value) => {
        if (live) { setPreview(value); setError(value.error ?? null); }
      }).catch((error) => {
        if (live) { setPreview(null); setError(errorMessage(error)); }
      }).finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [project.path, text, refresh]);

  const action = async (run: () => Promise<unknown>) => {
    try { await run(); } catch (error) { setError(errorMessage(error)); }
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateProject(project.path, { repositorySettings: { filesToCopy: lines(text) } });
      setDraft(null);
      setRefresh((value) => value + 1);
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
      <Button size="sm" variant="ghost" onClick={onBack}>Back to repositories</Button>
      <h3 className="mt-3 break-words text-lg font-medium">{project.name}</h3>
      <nav aria-label="Repository settings" className="my-4 flex gap-2">
        <Button variant={page === "general" ? "secondary" : "ghost"} aria-current={page === "general" ? "page" : undefined} onClick={() => setPage("general")}>General</Button>
        <Button variant={page === "files" ? "secondary" : "ghost"} aria-current={page === "files" ? "page" : undefined} onClick={() => setPage("files")}>Files to copy</Button>
      </nav>
      {page === "general" ? (
        <>
          {pathRow("Root path", project.path)}
          {preview && pathRow("Workspaces path", preview.workspacesPath)}
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">Copy matching ignored files into each new workspace. Paths are relative to the repository: * matches within a folder, ** matches across folders. Existing files and symbolic links are skipped.</p>
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
            <Button size="sm" variant="outline" disabled={saving} onClick={() => setRefresh((value) => value + 1)}>Refresh preview</Button>
          </div>
          <h4 className="text-sm font-medium">Ignored files matching each pattern</h4>
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
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error}</p>}
    </div>
  );
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}
