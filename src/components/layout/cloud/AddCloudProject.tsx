import { useEffect, useMemo, useState } from "react";
import { FolderGit2, Loader2, Lock } from "lucide-react";
import { normalizeRepositoryIdentity } from "@terminalx/portable/repositoryIdentity";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type CloudSelectedRepositories } from "@/lib/api";
import { blankIdentity, getCloudCatalog, placeCloudProjects, setCloudRepositories } from "@/lib/cloudCatalog";
import { errorCode } from "@/lib/cloudTerminals";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { startCloudSessionIn } from "@/lib/sessions";
import { cloudProjectKey } from "@/types/target";

/**
 * "+ Add project" on an organization's header (PRO-23): a repository the
 * organization selected for cloud workspaces, or a blank project with no
 * repository. Adding either only remembers it in prefs; nothing is created
 * or spent until a session starts in it.
 */

function identityOf(repository: { cloneUrl: string | null; fullName: string }): string | null {
  return normalizeRepositoryIdentity(repository.cloneUrl) ?? normalizeRepositoryIdentity(`github.com/${repository.fullName}`);
}

export function AddRepositoryDialog({ orgId, orgName, onClose, onOpenSettings }: { orgId: string; orgName: string; onClose: () => void; onOpenSettings?: () => void }) {
  const [result, setResult] = useState<CloudSelectedRepositories | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let live = true;
    api
      .cloudWorkspaceRepositories()
      .then((value) => {
        if (!live) return;
        setResult(value);
        // Fresher than the catalog's copy: the project added from it shows at once.
        if (value.configured) setCloudRepositories(orgId, value.repositories);
      })
      .catch((e: unknown) => live && setError(errorCode(e)));
    return () => {
      live = false;
    };
  }, [orgId]);

  // What the sidebar already shows: projects with workspaces, and those added before.
  const shown = useMemo(() => {
    const org = getCloudCatalog().orgs[orgId];
    const prefs = getPrefs();
    const placed = placeCloudProjects(org ?? { orgId, workspaces: [], repositories: null }, getCloudCatalog().createMemory, { added: prefs.cloudProjects[orgId] });
    return new Set(placed.projects.map((project) => project.identity));
  }, [orgId, result]);

  const notConnected = error === "github_app_not_configured" || (result !== null && !result.configured);
  const repositories = (result?.repositories ?? []).filter((repository) => repository.fullName.toLowerCase().includes(filter.trim().toLowerCase()));

  const add = (identity: string) => {
    const prefs = getPrefs();
    const current = prefs.cloudProjects[orgId] ?? [];
    if (!current.includes(identity)) setPrefs({ cloudProjects: { ...prefs.cloudProjects, [orgId]: [...current, identity] } });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="cloud-add-repository">
        <DialogHeader>
          <DialogTitle>Add a project from a repository</DialogTitle>
          <DialogDescription>Repositories {orgName} selected for cloud workspaces. Adding one creates nothing until you start a session in it.</DialogDescription>
        </DialogHeader>
        {notConnected ? (
          <div className="flex flex-col gap-3 text-sm" data-testid="cloud-github-not-connected">
            <p>The GitHub App is not connected for {orgName}, so cloud workspaces cannot reach any repository yet.</p>
            <p className="text-xs text-muted-foreground">An owner or admin installs it and chooses repositories in Settings → Account, under GitHub, or in the {orgName} console. You can still start a blank project with “New project…”.</p>
            {onOpenSettings && (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onClose();
                    onOpenSettings();
                  }}
                >
                  Open Settings
                </Button>
              </div>
            )}
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">The repositories could not be read ({error}).</p>
        ) : !result ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading repositories…
          </p>
        ) : result.repositories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repositories are selected for {orgName}. Choose them in Settings → Account, under GitHub.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              autoFocus
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter repositories"
              aria-label="Filter repositories"
              className="h-8 rounded-md bg-well px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
            />
            <ul className="max-h-72 overflow-y-auto scrollbar-thin" role="listbox" aria-label="Repositories">
              {repositories.map((repository) => {
                const identity = identityOf(repository);
                const usable = !!identity && !!repository.cloneUrl && repository.state === "accessible";
                const already = !!identity && shown.has(identity);
                return (
                  <li key={repository.fullName}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      disabled={!usable || already}
                      onClick={() => identity && add(identity)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-veil-raised disabled:opacity-50"
                    >
                      <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{repository.fullName}</span>
                      {repository.private && <Lock className="size-3 shrink-0 text-faint" aria-label="Private" />}
                      <span className="shrink-0 text-[11px] text-faint">{already ? "Added" : !usable ? (repository.reason ?? repository.state) : ""}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const NAME_MAX = 80;

export function NewBlankProjectDialog({ orgId, orgName, onClose }: { orgId: string; orgName: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const taken = useMemo(() => {
    if (!trimmed) return false;
    const org = getCloudCatalog().orgs[orgId];
    const identity = blankIdentity(trimmed);
    return (getPrefs().cloudBlankProjects[orgId] ?? []).some((other) => blankIdentity(other) === identity) || !!org?.workspaces.some((item) => blankIdentity(item.workspace.name) === identity && !item.workspace.repositories?.length);
  }, [orgId, trimmed]);
  const problem = !trimmed ? null : [...trimmed].length > NAME_MAX ? `At most ${NAME_MAX} characters.` : taken ? "A project with this name already exists; open it from the sidebar." : null;

  const create = () => {
    if (!trimmed || problem) return;
    const prefs = getPrefs();
    const current = prefs.cloudBlankProjects[orgId] ?? [];
    setPrefs({ cloudBlankProjects: { ...prefs.cloudBlankProjects, [orgId]: [...current, trimmed] } });
    onClose();
    // The next step is its first session; the form spends nothing until Start.
    startCloudSessionIn(cloudProjectKey(orgId, blankIdentity(trimmed)));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="cloud-new-blank-project">
        <DialogHeader>
          <DialogTitle>New project in {orgName} cloud</DialogTitle>
          <DialogDescription>
            A project with no repository: an empty folder on a cloud workspace, set up with Git so changes can be tracked. Its workspace is created when you start its first session.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="scratch"
            aria-label="Project name"
            className="h-8 w-full rounded-md bg-well px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
          />
          {problem && <p className="mt-1 text-xs text-destructive">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" size="sm" disabled={!trimmed || !!problem}>
              Add project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
