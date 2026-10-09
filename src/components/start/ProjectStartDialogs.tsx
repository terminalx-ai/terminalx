import { useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { setPrefs, usePrefs } from "@/lib/prefs";
import {
  attachProject,
  chooseProjectsDir,
  openProjectStart,
  projectStart,
  startFailure,
  useProjectStartDialog,
  type CloneProgress,
  type GithubRepositories,
  type StartFailure,
} from "@/lib/projectStart";
import { relativeTime } from "@/lib/time";

/** Never taller than the window: in a short one the dialog scrolls, so its title and buttons stay reachable. */
const FIT = "max-h-[calc(100dvh-2rem)] overflow-y-auto scrollbar-thin";
const FIELD = "h-8 w-full rounded-md bg-well px-2 text-[13px] outline-none placeholder:text-faint focus:ring-2 focus:ring-ring/40";

/** Mounted once (AppShell): the dialogs behind "Open GitHub project" and "Quick start". */
export function ProjectStartDialogHost() {
  const dialog = useProjectStartDialog();
  if (dialog === "github") return <GithubProjectDialog />;
  if (dialog === "quick") return <QuickStartDialog />;
  return null;
}

const close = () => openProjectStart(null);

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

/** The folder a clone of `source` is named after, as the backend names it. */
function repositoryName(source: string): string {
  const last = source.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

/** A repository URL or `owner/name`, by its shape; the backend decides whether it is valid. */
function looksLikeSource(text: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|[\w.-]+@[\w.-]+:\S+|[\w.-]+\/[\w.-]+)$/i.test(text.trim());
}

/** The folder projects go in: the one used last, else the backend's suggestion. */
function useProjectsDir(): [string | null, (dir: string) => void] {
  const prefs = usePrefs();
  const [dir, setDir] = useState<string | null>(prefs.projectsDir);
  useEffect(() => {
    if (dir) return;
    let live = true;
    void projectStart.defaults(null).then((defaults) => live && setDir((current) => current ?? defaults.projectsDir)).catch(() => {});
    return () => {
      live = false;
    };
  }, [dir]);
  return [dir, setDir];
}

function Destination({ label, dir, target, disabled, onChange }: { label: string; dir: string | null; target: string | null; disabled?: boolean; onChange: (dir: string) => void }) {
  const parent = dir?.replace(/\/+$/, "") ?? null;
  const path = parent === null ? null : target ? `${parent}/${target}` : dir;
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        {/* The folder gives way first: the name the project gets stays in view at the end of a long path. */}
        <div className="flex min-w-0 flex-1 rounded-md bg-well px-2 py-1.5 font-mono text-xs" title={path ?? undefined} data-testid="start-destination">
          {dir ? (
            <>
              <span className="min-w-0 truncate">{target ? `${parent}/` : dir}</span>
              {target && <span className="max-w-[60%] shrink-0 truncate">{target}</span>}
            </>
          ) : (
            "…"
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => void chooseProjectsDir(dir).then((chosen) => chosen && onChange(chosen)).catch(() => {})}
        >
          Choose folder…
        </Button>
      </div>
    </div>
  );
}

function FailureNote({ failure }: { failure: StartFailure }) {
  // The first line says what happened; the rest is what Git wrote.
  const [summary, ...detail] = failure.message.split("\n");
  return (
    <div role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" data-failure={failure.code}>
      <div>{summary}</div>
      {detail.length > 0 && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] opacity-80">{detail.join("\n")}</pre>}
    </div>
  );
}

type CloneState =
  | { phase: "idle"; failure?: StartFailure; canceled?: boolean }
  | { phase: "cloning"; id: string; progress: CloneProgress | null }
  | { phase: "existing"; path: string };

/**
 * "Open GitHub project": pick one of the reader's repositories (listed by
 * the backend through `gh`) or paste any Git URL, choose where it goes, and
 * clone it. The project is attached only once the clone is whole.
 */
function GithubProjectDialog() {
  const [repositories, setRepositories] = useState<GithubRepositories | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [dir, setDir] = useProjectsDir();
  const [state, setState] = useState<CloneState>({ phase: "idle" });
  const cloning = useRef<string | null>(null);
  // Closed dialogs attach nothing: a clone that outlived its cancel is left unopened.
  const alive = useRef(true);

  const load = () => {
    setRepositories(null);
    void projectStart
      .githubRepositories()
      .then(setRepositories)
      .catch((cause) => setRepositories({ status: "failed", message: startFailure(cause).message }));
  };
  useEffect(load, []);
  // Closed mid-clone (Escape, the close button): the clone is stopped, not left running unseen.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (cloning.current) void projectStart.cancelClone(cloning.current).catch(() => {});
    };
  }, []);

  const listed = repositories?.status === "ready" ? repositories.repositories : [];
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? listed.filter((repository) => `${repository.nameWithOwner} ${repository.description ?? ""}`.toLowerCase().includes(needle)) : listed;
  }, [listed, query]);

  // What is typed in the URL field wins: the reader wrote it last or on purpose.
  // An address pasted into the search box, matching nothing listed, is taken as one too.
  const searched = shown.length === 0 && looksLikeSource(query) ? query.trim() : "";
  const source = pasted.trim() || picked || searched;
  // Nothing about the clone changes while it runs, or while the answer about an existing one is on screen.
  const busy = state.phase !== "idle";

  const open = async (path: string) => {
    if (dir) setPrefs({ projectsDir: dir });
    await attachProject(path);
    close();
  };

  const clone = async () => {
    if (!source || !dir || busy) return;
    const id = newId();
    cloning.current = id;
    setState({ phase: "cloning", id, progress: null });
    const stop = await projectStart.onCloneProgress(id, (progress) => setState((current) => (current.phase === "cloning" && current.id === id ? { ...current, progress } : current)));
    if (!alive.current) return stop();
    try {
      const outcome = await projectStart.clone(id, source, dir);
      cloning.current = null;
      if (!alive.current) return;
      if (outcome.existing) setState({ phase: "existing", path: outcome.path });
      else await open(outcome.path);
    } catch (cause) {
      cloning.current = null;
      if (!alive.current) return;
      const failure = startFailure(cause);
      setState(failure.code === "canceled" ? { phase: "idle", canceled: true } : { phase: "idle", failure });
    } finally {
      stop();
    }
  };

  const openExisting = async (path: string) => {
    try {
      await open(path);
    } catch (cause) {
      setState({ phase: "idle", failure: startFailure(cause) });
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent width="max-w-[36rem]" className={FIT} data-testid="start-github-dialog">
        <DialogHeader>
          <DialogTitle>Open GitHub project</DialogTitle>
          <DialogDescription>Clone a repository to this computer and open it as a project.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {repositories === null ? (
            <div role="status" className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading your repositories…
            </div>
          ) : repositories.status === "ready" ? (
            <div>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && searched && void clone()}
                placeholder="Search your repositories"
                aria-label="Search your repositories"
                disabled={busy}
                className={FIELD}
              />
              <div role="listbox" aria-label="Your repositories" className="mt-1.5 max-h-[clamp(4rem,calc(100dvh-28rem),11rem)] overflow-y-auto rounded-md bg-well p-1 scrollbar-thin">
                {shown.map((repository) => {
                  const selected = !pasted.trim() && picked === repository.nameWithOwner;
                  return (
                    <button
                      key={repository.nameWithOwner}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={busy}
                      onClick={() => {
                        setPicked(repository.nameWithOwner);
                        setPasted("");
                      }}
                      onDoubleClick={() => void clone()}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        selected ? "bg-selected text-foreground" : "hover:bg-veil-raised",
                      )}
                    >
                      <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{repository.nameWithOwner}</span>
                      {repository.isPrivate && <Lock className="size-3 shrink-0 text-faint" aria-label="Private" />}
                      {repository.pushedAt && <span className="shrink-0 text-[11px] text-faint">{relativeTime(repository.pushedAt)}</span>}
                    </button>
                  );
                })}
                {shown.length === 0 && (
                  <div className="px-2 py-3 text-center text-xs text-faint">{searched ? `Not in your list. Clone ${searched} as typed.` : listed.length ? "No repository matches. Paste its URL below." : "No repositories found for your account."}</div>
                )}
              </div>
              {repositories.truncated && <p className="mt-1 text-[11px] text-faint">Showing your {listed.length} most recently pushed repositories. Paste a URL for any other.</p>}
            </div>
          ) : (
            <div role="note" className="rounded-md bg-warning/10 px-3 py-2 text-xs" data-testid="start-gh-unavailable" data-gh={repositories.status}>
              <div className="font-medium text-warning">
                {repositories.status === "missing" ? "The GitHub CLI (gh) is not installed" : repositories.status === "signed-out" ? "The GitHub CLI (gh) is not signed in" : "Your repositories could not be listed"}
              </div>
              <p className="mt-1 text-muted-foreground">
                {repositories.status === "missing" ? (
                  <>Install <code className="font-mono">gh</code> to pick from a list of your repositories. </>
                ) : repositories.status === "signed-out" ? (
                  <>Run <code className="font-mono">gh auth login</code> in a terminal to pick from a list of your repositories. </>
                ) : (
                  <>{repositories.message} </>
                )}
                You can still paste a repository URL below; it is cloned with the Git credentials already on this computer.
              </p>
              <Button size="xs" variant="ghost" className="mt-1.5" onClick={load}>
                Check again
              </Button>
            </div>
          )}

          <div>
            <label htmlFor="start-github-url" className="mb-1 block text-xs text-muted-foreground">
              Or paste a repository URL or owner/name
            </label>
            <input
              id="start-github-url"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void clone()}
              placeholder="https://github.com/owner/name"
              disabled={busy}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={cn(FIELD, "font-mono text-xs")}
            />
          </div>

          <Destination label="Clone into" dir={dir} target={source ? repositoryName(source) : null} disabled={busy} onChange={setDir} />

          {state.phase === "cloning" && <CloneProgressBar progress={state.progress} />}
          {state.phase === "idle" && state.failure && <FailureNote failure={state.failure} />}
          {state.phase === "idle" && state.canceled && (
            <div role="status" className="rounded-md bg-well px-3 py-2 text-xs text-muted-foreground">
              Clone canceled. Nothing was added.
            </div>
          )}
          {state.phase === "existing" && (
            <div role="status" className="rounded-md bg-well px-3 py-2 text-xs" data-testid="start-already-cloned">
              This repository is already cloned at <span className="font-mono">{state.path}</span>. Open it instead?
            </div>
          )}
        </div>

        <DialogFooter>
          {state.phase === "cloning" ? (
            <Button variant="secondary" onClick={() => void projectStart.cancelClone(state.id).catch(() => {})}>
              Cancel clone
            </Button>
          ) : state.phase === "existing" ? (
            <>
              <Button variant="ghost" onClick={() => setState({ phase: "idle" })}>
                Back
              </Button>
              <Button variant="accent" onClick={() => void openExisting(state.path)}>
                Open it
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant="accent" disabled={!source || !dir} onClick={() => void clone()}>
                {state.failure ? "Try again" : "Clone"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloneProgressBar({ progress }: { progress: CloneProgress | null }) {
  const percent = progress?.percent ?? null;
  const label = progress ? progress.stage : "Connecting";
  return (
    <div data-testid="start-clone-progress">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" />
        <span className="min-w-0 flex-1 truncate">{label}…</span>
        {percent !== null && <span className="tabular-nums">{percent}%</span>}
      </div>
      <div
        role="progressbar"
        aria-label="Clone progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? label : `${label}, ${percent}%`}
        className="h-1.5 overflow-hidden rounded-full bg-well"
      >
        <div className={cn("h-full rounded-full bg-accent transition-[width]", percent === null && "w-1/4 animate-pulse-soft")} style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
    </div>
  );
}

/**
 * "Quick start": a new empty Git repository in a folder the reader names,
 * attached as a project like any other. It always makes a real project;
 * a session with no project at all is a different feature.
 */
function QuickStartDialog() {
  const [dir, setDir] = useProjectsDir();
  const [name, setName] = useState("");
  // Until the reader types a name, the suggestion follows the folder.
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!dir || edited) return;
    let live = true;
    void projectStart.defaults(dir).then((defaults) => live && setName(defaults.suggestedName)).catch(() => {});
    return () => {
      live = false;
    };
  }, [dir, edited]);

  const trimmed = name.trim();
  const create = async () => {
    if (!trimmed || !dir || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const path = await projectStart.create(dir, trimmed);
      setPrefs({ projectsDir: dir });
      await attachProject(path);
      // Closed meanwhile: the project is there, but whatever is open now is not this dialog's to close.
      if (alive.current) close();
    } catch (cause) {
      setFailure(startFailure(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent width="max-w-[30rem]" className={FIT} data-testid="start-quick-dialog">
        <DialogHeader>
          <DialogTitle>Quick start</DialogTitle>
          <DialogDescription>Create a new empty project: a folder with a Git repository in it, ready for an agent to build in.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <label htmlFor="start-quick-name" className="mb-1 block text-xs text-muted-foreground">
              Project name
            </label>
            <input
              id="start-quick-name"
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setEdited(true);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => event.key === "Enter" && void create()}
              disabled={busy}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={FIELD}
            />
          </div>
          <Destination label="Create in" dir={dir} target={trimmed || null} disabled={busy} onChange={setDir} />
          {failure && <FailureNote failure={failure} />}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="accent" disabled={!trimmed || !dir || busy} onClick={() => void create()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
