import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { showError } from "@/lib/errorToasts";
import { updateProject, useSessionStore } from "@/lib/sessions";
import type { RepositoryAction, RepositoryPreviewUrl } from "@/lib/repositoryActions";
import { RepositoryActionsSettings } from "./RepositoryActionsSettings";

const NO_ACTIONS: RepositoryAction[] = [];
export const NO_PREVIEW_URLS: RepositoryPreviewUrl[] = [];

/** The open, non-archived repository at `projectPath`, or undefined. Shared by both pages. */
export function useRepository(projectPath: string) {
  const { projects } = useSessionStore();
  return projects.find((project) => project.path === projectPath && !project.archived && project.kind !== "folder");
}

/**
 * Loads and saves one repository's actions through update_project. The editor shows the list
 * only after a save succeeds, so a failed save leaves the stored list on screen with the error.
 *
 * `readRepositoryFile` is optional. Pass it where a repository file can supply actions: it
 * returns them, or null/[] when there is none. "Reset all actions to terminalx.json" is shown only while it
 * has returned some, and saving them replaces the local list. Keep the function stable (module
 * level or memoised): a new one each render reads the file again.
 */
/** What the Actions page holds, under its title (design 11.06). */
export const ACTIONS_SUBTITLE = "Commands for this project's Run menu.";

export function RepositoryActionsPage({ projectPath, readRepositoryFile, header = true }: {
  projectPath: string;
  readRepositoryFile?: (projectPath: string) => Promise<RepositoryAction[] | null>;
  /** False where the surrounding page already shows this title and line (Settings: one title a page). */
  header?: boolean;
}) {
  const project = useRepository(projectPath);
  const path = project?.path;
  const [fileActions, setFileActions] = useState<RepositoryAction[] | null>(null);
  useEffect(() => {
    setFileActions(null);
    if (!path || !readRepositoryFile) return;
    let current = true;
    readRepositoryFile(path).then(
      (actions) => { if (current && actions?.length) setFileActions(actions); },
      () => { /* No usable file: nothing to reset to, so the button stays hidden. */ },
    );
    return () => { current = false; };
  }, [path, readRepositoryFile]);
  if (!project) return <p className="text-sm text-muted-foreground">Open a repository to configure its actions.</p>;
  const save = async (actions: RepositoryAction[]) => {
    try { await updateProject(project.path, { actions }); }
    catch (cause) {
      showError(`Couldn't save actions for “${project.name}”`, cause);
      throw new Error(errorMessage(cause));
    }
  };
  // Design 11.06: the page title and what it holds, then the Run actions card. Action prompts are not built yet.
  return <div className="flex flex-col gap-6">
    {header && <header className="min-w-0">
      <h3 className="text-xl font-semibold tracking-tight">Actions</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">{ACTIONS_SUBTITLE}</p>
    </header>}
    <RepositoryActionsSettings
      key={project.path}
      actions={project.actions ?? NO_ACTIONS}
      onChange={save}
      onReset={fileActions ? () => save(fileActions) : undefined}
    />
  </div>;
}
