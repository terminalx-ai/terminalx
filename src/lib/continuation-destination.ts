import { api } from "@/lib/api";
import type { Project, SessionEntry } from "@/types/session";

const normalized = (path: string) => path.replace(/\/+$/, "") || "/";
export function containsPath(root: string, path: string): boolean {
  root = normalized(root);
  path = normalized(path);
  return path === root || path.startsWith(root === "/" ? root : `${root}/`);
}

export interface ContainingWorkspace { projectPath: string; path: string; isMain?: boolean }

/** Include Git's actual worktrees, including checkouts outside the attached root. */
export async function continuationWorkspaces(projects: Project[]): Promise<ContainingWorkspace[]> {
  const lists = await Promise.all(projects.map(async (project) => {
    const workspaces = project.kind === "folder" ? [] : await api.listWorkspaces(project.path);
    return [{ projectPath: project.path, path: project.path, isMain: true }, ...(workspaces ?? []).map(({ path, isMain }) => ({ projectPath: project.path, path, isMain }))];
  }));
  return lists.flat();
}

export function containingWorkspace(workspaces: ContainingWorkspace[], cwd: string, projectPath?: string): ContainingWorkspace | undefined {
  return workspaces.filter((workspace) => (!projectPath || workspace.projectPath === projectPath) && containsPath(workspace.path, cwd))
    .sort((a, b) => normalized(b.path).length - normalized(a.path).length)[0];
}

export function continuationDefaultProject(session: SessionEntry, cwd: string, workspaces: ContainingWorkspace[]): string | null {
  return session.kind === "quick" ? containingWorkspace(workspaces, cwd)?.projectPath ?? null : session.projectPath ?? null;
}
