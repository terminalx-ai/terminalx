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
 * returns them, or null/[] when there is none. "Reset to repository file" is shown only while it
 * has returned some, and saving them replaces the local list. Keep the function stable (module
 * level or memoised): a new one each render reads the file again.
 */
export function RepositoryActionsPage({ projectPath, readRepositoryFile }: {
  projectPath: string;
  readRepositoryFile?: (projectPath: string) => Promise<RepositoryAction[] | null>;
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
  return <div className="space-y-3">
    <p className="break-all font-mono text-xs text-faint">{project.path}</p>
    <RepositoryActionsSettings
      key={project.path}
      actions={project.scripts?.actions ?? NO_ACTIONS}
      onChange={save}
      onReset={fileActions ? () => save(fileActions) : undefined}
    />
  </div>;
}
