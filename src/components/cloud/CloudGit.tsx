import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Loader2, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import {
  RemoteGit,
  dispositionFacts,
  gitErrorMessage,
  hasUnpublishedWork,
  listRepositories,
  type DispositionFacts,
  type GitAuthor,
  type RemoteRepository,
  type RepositoryFacts,
} from "@terminalx/portable/workspaceGit";
import { PrPanel } from "@/components/changes/PrPanel";
import { RepoPanel, type RepoView } from "@/components/changes/RepoPanel";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { cloudGitSource, desktopGitIdentity } from "@/lib/gitSource";
import { repositoryLabel } from "@/lib/cloudLifecycle";

type Panel = "repo" | "pr";

/**
 * Review, commit, push and pull requests for a cloud workspace (PRO-27): the
 * desktop's Repo and PR panels on one of the workspace's repositories,
 * through the runtime's `git/1`. With several repositories nothing is shown
 * until one is chosen; commits carry this person's Git identity, and
 * publishing uses the workspace's own GitHub access, never this computer's.
 */
export function CloudGitView({
  workspaceKey,
  client,
  state,
  active,
}: {
  workspaceKey: string;
  client: WorkspaceRpcClient;
  state: WorkspaceConnectionState;
  active: boolean;
}) {
  const connected = state.state === "connected";
  const authority = useRef<"manage" | "participate">("participate");
  if (connected) authority.current = state.authority;
  const manage = authority.current === "manage";
  const generation = connected ? `${state.runtimeGeneration}:${state.runtimeEpoch ?? ""}` : null;

  const [repositories, setRepositories] = useState<RemoteRepository[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("repo");
  const [repoView, setRepoView] = useState<RepoView>("uncommitted");
  const [author, setAuthor] = useState<GitAuthor | null | undefined>(undefined);
  const [branch, setBranch] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active || !generation) return;
    let cancelled = false;
    listRepositories(client)
      .then((found) => {
        if (cancelled) return;
        setRepositories(found);
        setError(null);
        // Only an unambiguous workspace picks for itself.
        setSelected((current) => (current && found.some((repo) => repo.repo === current) ? current : found.length === 1 ? found[0]!.repo : null));
      })
      .catch((e) => !cancelled && setError(gitErrorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [client, active, generation, tick]);

  useEffect(() => {
    if (!active) return;
    void desktopGitIdentity().then(setAuthor);
  }, [active]);

  const remote = useMemo(() => (selected ? new RemoteGit(client, selected) : null), [client, selected]);
  const source = useMemo(
    () => (remote ? cloudGitSource({ workspaceKey, remote, canWrite: manage, author: desktopGitIdentity }) : null),
    [workspaceKey, remote, manage],
  );

  useEffect(() => {
    setBranch(null);
    if (!source || !active || !generation) return;
    let cancelled = false;
    source
      .workStatus()
      .then((status) => !cancelled && setBranch(status.branch))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, active, generation, panel, tick]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  return (
    <div className="flex min-h-0 flex-1" data-testid="cloud-git">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1.5">
          <GitBranch className="size-3.5 text-muted-foreground" />
          {repositories && repositories.length > 1 ? (
            <select
              aria-label="Repository"
              value={selected ?? ""}
              onChange={(event) => setSelected(event.target.value || null)}
              className="h-7 rounded-md border border-hairline bg-transparent px-1 font-mono text-xs outline-none focus:border-ring"
            >
              <option value="">Choose a repository…</option>
              {repositories.map((repo) => (
                <option key={repo.repo} value={repo.repo}>
                  {repo.repo}
                </option>
              ))}
            </select>
          ) : (
            <span className="font-mono text-xs">{selected ?? ""}</span>
          )}
          {remote && <BranchControl remote={remote} branch={branch} manage={manage && connected} onChanged={refresh} />}
          {selected && (
            <Segmented<Panel>
              aria-label="Git panel"
              className="ml-auto"
              value={panel}
              onChange={setPanel}
              options={[
                { value: "repo", label: "Changes" },
                { value: "pr", label: "Pull request" },
              ]}
            />
          )}
        </div>
        {!connected && <p className="px-3 py-1 text-xs text-muted-foreground">Git appears once the workspace is connected.</p>}
        {error && <p role="alert" className="px-3 py-1 text-xs text-destructive">{error}</p>}
        {connected && repositories?.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">This workspace has no Git repository.</p>}
        {connected && repositories && repositories.length > 1 && !selected && (
          <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="cloud-git-choose">
            This workspace has {repositories.length} repositories. Choose one to review, commit or publish; nothing is done in all of them at once.
          </p>
        )}
        {source && (
          <div className="min-h-0 flex-1">
            {panel === "repo" ? (
              <RepoPanel
                key={`${source.key}:${tick}`}
                source={source}
                active={active && connected}
                view={repoView}
                onViewChange={setRepoView}
                author={manage ? (author === undefined ? undefined : author ? `${author.name} <${author.email}>` : null) : undefined}
              />
            ) : (
              <PrPanel source={source} branch={branch} active={active && connected} busy={false} />
            )}
          </div>
        )}
      </div>
      <aside className="w-64 shrink-0 overflow-y-auto border-l border-hairline scrollbar-thin">
        <UnpublishedWork client={client} active={active && connected} generation={generation} tick={tick} />
      </aside>
    </div>
  );
}

/** Switch to or create a branch in the chosen repository. */
function BranchControl({ remote, branch, manage, onChanged }: { remote: RemoteGit; branch: string | null; manage: boolean; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await remote.checkout(name.trim(), { create: true });
      setCreating(false);
      setName("");
      onChanged();
    } catch (e) {
      setError(gitErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span className="truncate font-mono" data-testid="cloud-git-branch">
        {branch ?? "detached"}
      </span>
      {manage && !creating && (
        <Button size="icon-xs" variant="ghost" aria-label="New branch" title="New branch from here" onClick={() => setCreating(true)}>
          <Plus />
        </Button>
      )}
      {creating && (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            autoFocus
            aria-label="New branch name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="feature/name"
            className="h-6 w-36 rounded-md border border-hairline bg-transparent px-1 font-mono text-xs outline-none focus:border-ring"
          />
          <Button size="xs" type="submit" disabled={!name.trim() || busy}>
            {busy ? <Loader2 className="animate-spin" /> : "Create"}
          </Button>
          <Button size="xs" variant="ghost" type="button" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && <span className="text-destructive">{error}</span>}
    </span>
  );
}

function describeFacts(facts: RepositoryFacts): string[] {
  const parts: string[] = [];
  if (facts.dirtyFiles) parts.push(`${facts.dirtyFiles} uncommitted file${facts.dirtyFiles === 1 ? "" : "s"}${facts.untrackedFiles ? ` (${facts.untrackedFiles} untracked)` : ""}`);
  if (facts.unpushedCommits) parts.push(`${facts.unpushedCommits} unpushed commit${facts.unpushedCommits === 1 ? "" : "s"}`);
  if (facts.localOnlyCommits && facts.localOnlyCommits !== facts.unpushedCommits) {
    parts.push(`${facts.localOnlyCommits} commit${facts.localOnlyCommits === 1 ? "" : "s"} on no remote branch`);
  }
  if (facts.openPullRequests?.length) parts.push(facts.openPullRequests.map((pr) => `PR #${pr.number} open`).join(", "));
  if (facts.openPullRequests === null) parts.push("pull requests unknown (GitHub not reachable)");
  return parts;
}

/**
 * What archiving or deleting this workspace would put at risk, from the
 * runtime (`lifecycle.dispositionFacts`): uncommitted and unpushed work and
 * open pull requests per repository, running agent turns and terminals.
 */
export function UnpublishedWork({ client, active, generation, tick }: { client: WorkspaceRpcClient; active: boolean; generation: string | null; tick: number }) {
  const [facts, setFacts] = useState<DispositionFacts | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!active || !generation) return;
    let cancelled = false;
    setLoading(true);
    dispositionFacts(client)
      .then((next) => {
        if (cancelled) return;
        setFacts(next);
        setError(null);
      })
      .catch((e) => !cancelled && setError(gitErrorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, active, generation, tick, again]);

  const atRisk = facts?.repositories.filter(hasUnpublishedWork) ?? [];
  return (
    <section className="flex flex-col gap-2 px-3 py-3 text-xs" data-testid="cloud-unpublished-work" aria-label="Before archiving or deleting">
      <div className="flex items-center gap-1">
        <ShieldAlert className="size-3.5 text-muted-foreground" />
        <h3 className="font-medium">Before archiving or deleting</h3>
        <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label="Check again" disabled={loading || !active} onClick={() => setAgain((value) => value + 1)}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>
      {!generation && <p className="text-muted-foreground">Offline: what is unpublished cannot be checked until the workspace is connected.</p>}
      {error && <p className="text-destructive">{error}</p>}
      {generation && facts === null && <p className="text-muted-foreground">This workspace's runtime does not report unpublished work.</p>}
      {facts && atRisk.length === 0 && facts.repositories.length > 0 && <p className="text-muted-foreground">Everything is committed and pushed.</p>}
      {atRisk.map((repo) => (
        <div key={repo.path} className="rounded-md bg-warning/10 px-2 py-1.5" data-testid="cloud-unpublished-repo">
          <div className="font-mono">
            {repositoryLabel(repo)}
            {repo.branch ? ` · ${repo.branch}` : ""}
          </div>
          <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">
            {describeFacts(repo).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ))}
      {facts && facts.activeTasks.length > 0 && (
        <p className="text-muted-foreground">
          {facts.activeTasks.length} agent turn{facts.activeTasks.length === 1 ? " is" : "s are"} running.
        </p>
      )}
      {facts && facts.runningProcesses > 0 && (
        <p className="text-muted-foreground">
          {facts.runningProcesses} terminal{facts.runningProcesses === 1 ? " is" : "s are"} running.
        </p>
      )}
    </section>
  );
}
