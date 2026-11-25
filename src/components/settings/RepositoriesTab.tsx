import { fileManager } from "@/lib/platform";
import { useSettingsLeaveGuard } from "./settingsLeaveGuard";
import { useEffect, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, CircleCheck, Copy, FileJson, FileTerminal, Folder, FolderOpen, KeyRound, RefreshCw, Settings2, TriangleAlert, Trash2, Zap } from "@/icons";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { shortPath } from "@/lib/paths";
import { updateProject, useSessionStore } from "@/lib/sessions";
import type { Project } from "@/types/session";
import type { RepositoryFilesPreview } from "@/types/repositorySettings";
import { confirmRemoveProject, conversationLink } from "@/components/layout/SessionSidebar";
import { RegisteredSetting } from "./settingsRegistry";
import { MergedCleanupSettings } from "./MergedCleanupSettings";
import { RepositoryOrchestratorSettings } from "./OrchestratorSettings";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { RepositoryScriptsTab } from "./RepositoryScriptsTab";
import { SparseCheckoutRow } from "./SparseCheckoutRow";
import { RepositoryActionsPage } from "./RepositoryActionsPage";
import { RepositoryPreviewUrlsPage } from "./RepositoryPreviewUrlsPage";
import { RepositoryEnvironmentSettings } from "./RepositoryEnvironmentSettings";
import { ProjectAgentAccounts } from "./ProjectAgentAccounts";
import { ProjectSettingsFiles } from "./SettingsFiles";

/** A project's pages, nested under it in the Settings sidebar (design 11.02, 11.10). */
export type ProjectPage = "general" | "scripts" | "actions" | "environment" | "settingsFiles";
export const PROJECT_PAGES: readonly { page: ProjectPage; label: string; icon: LucideIcon }[] = [
  { page: "general", label: "General", icon: Settings2 },
  { page: "scripts", label: "Scripts", icon: FileTerminal },
  { page: "actions", label: "Actions", icon: Zap },
  { page: "environment", label: "Environment", icon: KeyRound },
  { page: "settingsFiles", label: "Settings files", icon: FileJson },
];
/** A folder project has only General. */
export const projectPages = (project: Pick<Project, "kind">) => project.kind === "folder" ? PROJECT_PAGES.slice(0, 1) : PROJECT_PAGES;

/** The page a project's row lives on: Preview URLs, Files to copy, cleanup and the rest live on General (PRO-131). */
export function projectPageForRow(row: string | null | undefined): ProjectPage {
  if (row === "repositories.scripts") return "scripts";
  if (row === "repositories.actions") return "actions";
  if (row === "repositories.environment") return "environment";
  return "general";
}

export function RepositoriesTab({ projectPath, page = "general" }: { projectPath?: string; page?: ProjectPage }) {
  const { projects } = useSessionStore();
  const project = projects.find((project) => !project.archived && project.path === projectPath);
  const orchestratorRuns = useExperimentalSettings()?.orchestratorRuns === true;
  if (!project) return <p className="text-sm text-muted-foreground">Choose a project to view its settings.</p>;
  // A folder project has a default account too (#980): shown only once an agent has several.
  if (project.kind === "folder") return <><ProjectAgentAccounts projectPath={project.path} /><MergedCleanupSettings projectPath={project.path} /><RemoveProjectRow project={project} /></>;
  const general = page === "general";
  return <>
    {general && <RepositorySettingsPage key={project.path} project={project} />}
    {page === "scripts" && <RepositoryScriptsTab projectPath={project.path} />}
    {page === "actions" && <RegisteredSetting setting="repositories.actions" instance={project.path}><div><RepositoryActionsPage key={project.path} header={false} projectPath={project.path} /></div></RegisteredSetting>}
    {page === "environment" && <RegisteredSetting setting="repositories.environment" instance={project.path}><div><RepositoryEnvironmentSettings key={project.path} projectPath={project.path} /></div></RegisteredSetting>}
    {page === "settingsFiles" && <ProjectSettingsFiles key={project.path} projectPath={project.path} />}
    <div hidden={!general}>
      <div className="border-b border-hairline py-4"><MergedCleanupSettings projectPath={project.path} /></div>
      {orchestratorRuns && <div className="border-b border-hairline py-4"><RepositoryOrchestratorSettings projectPath={project.path} /></div>}
      <RemoveProjectRow project={project} />
    </div>
  </>;
}

/** The last row of General (design 11.02): the sidebar menu's Remove project, with what it leaves in place. */
function RemoveProjectRow({ project }: { project: Project }) {
  const store = useSessionStore();
  const remove = () => {
    const chatsPath = store.chatsPath ? canon(store.chatsPath) : null;
    const sessions = (store.sessions ?? []).filter((session) => {
      if (session.archived) return false;
      const link = conversationLink(session, store.projects, chatsPath, store.workspaces);
      return !!link && canon(link.path) === canon(project.path);
    });
    void confirmRemoveProject({ path: project.path, name: project.name, project, sessions, archived: [], branches: {} });
  };
  return <ProjectRow title="Remove project" description={`Takes ${project.name} out of TerminalX and archives its conversations. The folder on disk stays.`} last
    action={<Button size="sm" variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={remove}><Trash2 />Remove project</Button>} />;
}

const canon = (path: string) => path.replace(/\/+$/, "");

/** One row of a project page: a 14px title, a 12.5px description, an optional action on the right and content below. */
function ProjectRow({ title, description, action, children, last }: { title: string; description: ReactNode; action?: ReactNode; children?: ReactNode; last?: boolean }) {
  return <div className={cn("min-w-0 py-4", !last && "border-b border-hairline")}>
    <div className="flex items-center gap-6">
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium">{title}</h4>
        <div className="mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground">{description}</div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
    {children}
  </div>;
}

/** A folder shown as its path, with Show in Finder and Copy path in its menu. Read-only: never changed here. */
function PathMenu({ label, path, onError }: { label: string; path: string; onError: (error: unknown) => void }) {
  const run = (action: () => Promise<unknown>) => void action().catch(onError);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label={`${label}: ${path}`} className="-ml-2 mt-1.5 inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 font-mono text-[12px] text-muted-foreground outline-none hover:bg-veil-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-veil-raised">
        <Folder aria-hidden className="size-3.5 shrink-0 text-faint" />
        <span className="truncate">{shortPath(path)}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-faint" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      <DropdownMenuItem onSelect={() => run(() => revealItemInDir(path))}><FolderOpen />Show in {fileManager}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => run(() => copyText(path))}><Copy />Copy path</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

type PreviewPattern = RepositoryFilesPreview["patterns"][number];

/** Why a valid pattern matched nothing, as the preview says (PRO-131), as a sentence. */
function patternReason(item: PreviewPattern): string {
  return sentence(item.reason?.trim() || "No ignored files match");
}
const sentence = (text: string) => `${text.replace(/[.\s]+$/, "")}.`;

/** A project's General page (design 11.02): its paths, Preview URLs and Files to copy, one after another. */
export function RepositorySettingsPage({ project }: { project: Project }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<RepositoryFilesPreview | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
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
        if (live) { setPreview(value); setPreviewed(text); setError(value.error ?? null); }
      }).catch((error) => {
        if (live) { setPreview(null); setPreviewed(null); setError(errorMessage(error)); }
      }).finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [project.path, text, snapshot]);

  const patterns: PreviewPattern[] = preview?.patterns ?? [];
  // Design 11.02 has no Save button. Leaving the field commits an edit; previewing
  // alone never changes the policy used by workspace creation. If validation is still
  // pending, only this exact draft may commit, and resuming editing cancels that intent.
  const valid = !loading && !!preview && !preview.error && !preview.fromIncludeFile && previewed === text && !patterns.some((item) => item.error);
  const [commit, setCommit] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Keep this editor mounted through validation and persistence, including a failed
  // save. The shared boundary covers project/page navigation and leaving Settings.
  const dirty = !preview?.fromIncludeFile && lines(text).join("\n") !== lines(stored).join("\n");
  useSettingsLeaveGuard(dirty || saving);
  useEffect(() => {
    if (!valid || commit === null || commit !== text || saving) return;
    setCommit(null);
    if (lines(commit).join("\n") === lines(stored).join("\n")) return;
    setSaving(true);
    setSaveError(null);
    updateProject(project.path, { repositorySettings: { filesToCopy: lines(commit) } })
      .catch((cause) => setSaveError(errorMessage(cause)))
      .finally(() => setSaving(false));
  }, [valid, commit, text, stored, project.path, saving]);

  const commitDraft = () => {
    if (draft !== null && !preview?.fromIncludeFile) setCommit(draft);
  };

  const report = (cause: unknown) => setError(errorMessage(cause));
  // Design 11.12: every pattern is valid and none matches an ignored file.
  const nothingMatches = !loading && !!preview && !preview.error && patterns.length > 0 && patterns.every((item) => !item.error && !item.matches.length);
  const recheck = () => setSnapshot(crypto.randomUUID());
  const matched = [...new Set(patterns.flatMap((item) => item.matches))];
  const matchCount = matched.length + patterns.reduce((total, item) => total + (item.omitted ?? 0), 0);
  const omitted = patterns.reduce((total, item) => total + (item.omitted ?? 0), 0);
  const failing = patterns.filter((item) => !item.error && !item.matches.length);
  const warn = <TriangleAlert aria-hidden className="mr-1 inline size-3 -translate-y-px text-warning" />;

  return (
    <div className="min-w-0">
      <RegisteredSetting setting="repositories.rootPath" instance={project.path}>
        <div className="outline-none"><ProjectRow title="Root path" description={<>{warn}Don’t move or delete this folder; remove the project here instead.</>}>
          <PathMenu label="Root path" path={project.path} onError={report} />
        </ProjectRow></div>
      </RegisteredSetting>
      {preview && <RegisteredSetting setting="repositories.workspacesPath" instance={project.path}>
        <div className="outline-none"><ProjectRow title="Worktree folder" description={<>{warn}New workspaces are created here. Remove workspaces in TerminalX rather than deleting folders.</>}>
          <PathMenu label="Worktree folder" path={preview.workspacesPath} onError={report} />
        </ProjectRow></div>
      </RegisteredSetting>}
      <RegisteredSetting setting="repositories.sparseCheckout" instance={project.path}><SparseCheckoutRow project={project} /></RegisteredSetting>
      <ProjectAgentAccounts projectPath={project.path} />
      <RegisteredSetting setting="repositories.previewUrls" instance={project.path}>
        <div className="border-b border-hairline py-4"><RepositoryPreviewUrlsPage projectPath={project.path} /></div>
      </RegisteredSetting>
      <RegisteredSetting setting="repositories.filesToCopy" instance={project.path}>
        <section aria-label="Files to copy" className="border-b border-hairline py-4">
          <h4 className="text-sm font-medium"><label htmlFor="repository-copy-patterns">Files to copy</label></h4>
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground">Ignored files copied into each new workspace, one pattern per line.</p>
          {preview?.fromIncludeFile && <p role="status" className="mt-1 text-[12.5px] text-muted-foreground">Patterns come from this repository's .worktreeinclude</p>}
          <textarea
            id="repository-copy-patterns"
            className={cn("mt-2.5 min-h-[66px] w-full rounded-md border bg-well px-3 py-2 font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40", nothingMatches ? "border-warning/60" : "border-border")}
            rows={Math.min(Math.max(lines(text).length + 1, 3), 10)}
            placeholder={".env*\nconfig/local/**"}
            spellCheck={false}
            value={preview?.fromIncludeFile ? patterns.map((item) => item.pattern).join("\n") : text}
            readOnly={(draft === null && !preview && loading) || !!preview?.fromIncludeFile}
            aria-describedby="repository-copy-commit-help"
            // Set while this edit holds Settings (the leave guard above): unsaved, or its save not yet ended. Nothing
            // else draws that, and a click to leave before it ends is refused (scripts/webkit/project-settings.mjs).
            data-unsaved={dirty || saving ? "" : undefined}
            onFocus={() => setCommit(null)}
            onBlur={commitDraft}
            onChange={(event) => { setDraft(event.target.value); setCommit(null); }}
          />
          {!preview?.fromIncludeFile && <p id="repository-copy-commit-help" className="mt-1 text-[12px] text-muted-foreground">Changes save when you leave this field after validation. New workspaces use the last saved patterns.</p>}
          {saveError && <div className="mt-2">
            <p role="alert" className="text-sm text-destructive">{saveError}</p>
            {!preview?.fromIncludeFile && <Button size="sm" variant="outline" className="mt-2" disabled={saving} onClick={commitDraft}>Retry save</Button>}
          </div>}
          {preview?.warning && <p role="status" className="mt-2 text-[12px] text-warning">{preview.warning}</p>}
          {patterns.filter((item) => item.error).map((item, index) => (
            <p key={`${index}:${item.pattern}`} role="alert" className="mt-2 break-words text-[12px] text-destructive"><span className="font-mono">{item.pattern}</span>: {item.error}</p>
          ))}
          {loading ? <p role="status" className="mt-2 text-[12px] text-muted-foreground">Updating preview…</p> : nothingMatches ? <>
            <div className="mt-2 flex items-center gap-2 text-[12px] text-warning">
              <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
              {/* Amber, mixed toward the text colour so it reads at 4.5:1 on the light theme too. */}
              <p role="status" className="text-[color-mix(in_oklab,var(--color-warning)_60%,var(--color-foreground))]">No ignored files match these patterns</p>
              <button type="button" onClick={recheck} className="ml-auto flex items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"><RefreshCw aria-hidden className="size-3" />Check again</button>
            </div>
            <p aria-label="Why each pattern matched nothing" className="mt-2 break-words rounded-md bg-well px-3 py-2 text-[12px] leading-[18px] text-muted-foreground hairline">
              {preview!.ignoredChecked != null && <>Checked {preview!.ignoredChecked.toLocaleString("en-US")} ignored {preview!.ignoredChecked === 1 ? "file" : "files"} in <span className="font-mono text-[11.5px]">{shortPath(preview!.rootPath)}</span>. </>}
              {patterns.map((item, index) => <span key={`${index}:${item.pattern}`}><span className="font-mono text-[11.5px] text-foreground">{item.pattern}</span>: {patternReason(item)} </span>)}
              Patterns are globs from the project root: <span className="font-mono text-[11.5px]">.env</span> matches only the root, <span className="font-mono text-[11.5px]">**/.env</span> any folder.
            </p>
          </> : preview && !preview.error && <>
            <div className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
              {patterns.length ? <><CircleCheck aria-hidden className={cn("size-3.5 shrink-0", matchCount ? "text-add" : "text-faint")} />
                <span role="status">{matchCount.toLocaleString("en-US")} ignored {matchCount === 1 ? "file matches" : "files match"}</span></>
                : <span role="status">No patterns. No files will be copied.</span>}
              <Button variant="ghost" size="icon-xs" aria-label="Refresh preview" className="ml-auto text-faint" onClick={recheck}><RefreshCw /></Button>
            </div>
            {matched.length > 0 && <ul aria-label="Matching ignored files" className="mt-1.5 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {matched.map((path) => <li key={path} className="inline-flex h-6 max-w-full items-center truncate rounded bg-veil-strong px-1.5 font-mono text-[11.5px] text-muted-foreground">{path}</li>)}
            </ul>}
            {omitted > 0 && <p className="mt-1.5 text-[12px] text-muted-foreground">{omitted} more {omitted === 1 ? "match" : "matches"} omitted from preview.</p>}
            {failing.length > 0 && <ul aria-label="Patterns that match nothing" className="mt-1.5 flex flex-col gap-0.5">
              {failing.map((item, index) => <li key={`${index}:${item.pattern}`} className="break-words text-[12px] text-muted-foreground"><span className="font-mono text-foreground">{item.pattern}</span>: {patternReason(item)}</li>)}
            </ul>}
          </>}
          {!loading && (!preview || preview.error) && <Button size="sm" variant="outline" className="mt-2" onClick={recheck}>Refresh preview</Button>}
        </section>
      </RegisteredSetting>
      {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error}</p>}
    </div>
  );
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}
