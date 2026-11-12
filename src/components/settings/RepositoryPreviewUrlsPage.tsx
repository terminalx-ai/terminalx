import { errorMessage } from "@/lib/api";
import { showError } from "@/lib/errorToasts";
import { updateProject } from "@/lib/sessions";
import type { RepositoryPreviewUrl } from "@/lib/repositoryActions";
import { RepositoryPreviewUrlsSettings } from "./RepositoryPreviewUrlsSettings";
import { NO_PREVIEW_URLS, useRepository } from "./RepositoryActionsPage";

/** Loads and saves one repository's preview URLs through update_project. */
export function RepositoryPreviewUrlsPage({ projectPath }: { projectPath: string }) {
  const project = useRepository(projectPath);
  if (!project) return <p className="text-sm text-muted-foreground">Open a repository to configure its preview URLs.</p>;
  const save = async (previewUrls: RepositoryPreviewUrl[]) => {
    try { await updateProject(project.path, { previewUrls }); }
    catch (cause) {
      showError(`Couldn't save preview URLs for “${project.name}”`, cause);
      throw new Error(errorMessage(cause));
    }
  };
  return <RepositoryPreviewUrlsSettings key={project.path} urls={project.scripts?.previewUrls ?? NO_PREVIEW_URLS} onChange={save} />;
}
