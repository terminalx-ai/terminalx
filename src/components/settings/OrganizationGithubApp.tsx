import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { organizationMembers } from "@/lib/organizationMembers";
import {
  INSTALLATION_STATE_LABEL,
  MAX_SELECTED_REPOSITORIES,
  REPOSITORY_STATE_LABEL,
  fixedOnGithub,
  attemptErrorMessage,
  githubAppErrorCode,
  githubAppErrorMessage,
  organizationGithubApp,
  repositoryExplanation,
  type ConnectAttempt,
  type GithubAppSummary,
  type GithubInstallation,
  type LiveRepositories,
  type RepositoryChoice,
  type SelectedRepository,
} from "@/lib/organizationGithubApp";

const POLL_INTERVAL_MS = 2000;

const ATTEMPT_END_MESSAGE: Record<string, string> = {
  expired: "The connection attempt expired before GitHub finished. Connect again.",
  canceled: "Connection canceled.",
};

interface Chooser {
  installationId: string;
  query: string;
  live: LiveRepositories | null;
  loading: boolean;
  error: string | null;
  /** The draft selection for this installation, by GitHub repository id. */
  draft: Set<number> | null;
}

export function OrganizationGithubApp({
  contextRevision,
  pollIntervalMs = POLL_INTERVAL_MS,
}: {
  /** The account's context revision; a change reloads the summary. */
  contextRevision: string;
  pollIntervalMs?: number;
}) {
  const [summary, setSummary] = useState<GithubAppSummary | null>(null);
  // For callbacks that must see the latest summary without re-creating.
  const summaryRef = useRef<GithubAppSummary | null>(null);
  summaryRef.current = summary;
  const storedSelection = (installationId: string) =>
    (summaryRef.current?.repositories ?? [])
      .filter((repository) => repository.installationId === installationId && repository.state === "accessible")
      .map((repository) => repository.githubRepositoryId);
  const [notConfigured, setNotConfigured] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<ConnectAttempt | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  // Drops results that land after the account or organization changed.
  const contextEpoch = useRef(0);
  // Orders summary reads so an older one never overwrites a newer one.
  const loadSeq = useRef(0);
  const chooserSeq = useRef(0);
  // Bumped whenever the panel ends or replaces an attempt itself, so a poll
  // already in flight cannot bring it back.
  const attemptSeq = useRef(0);

  const load = useCallback(async (keepError = false) => {
    const current = ++loadSeq.current;
    const context = contextEpoch.current;
    const fresh = () => current === loadSeq.current && context === contextEpoch.current;
    setLoading(true);
    try {
      const next = await organizationGithubApp.summary();
      let manage = next.canManage;
      if (typeof manage !== "boolean") {
        manage = await organizationMembers.list().then(
          (roster) => roster.canManageMembers,
          () => false,
        );
      }
      if (fresh()) {
        setSummary(next);
        setNotConfigured(!next.configured);
        setCanManage(Boolean(manage));
        if (!keepError) setError(null);
      }
    } catch (failure) {
      if (!fresh()) return;
      if (githubAppErrorCode(failure) === "github_app_not_configured") {
        setNotConfigured(true);
        setSummary(null);
        setError(null);
      } else {
        setError(githubAppErrorMessage(failure));
      }
    } finally {
      if (fresh()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSummary(null);
    setNotConfigured(false);
    setAttempt(null);
    setChooser(null);
    setConfirmDisconnect(null);
    setBusy(null);
    setError(null);
    setNotice(null);
    void load();
    return () => {
      contextEpoch.current += 1;
    };
  }, [contextRevision, load]);

  // Poll a waiting connect attempt until GitHub redirects back and the server
  // settles it.
  useEffect(() => {
    if (!attempt || attempt.state !== "waiting") return;
    const context = contextEpoch.current;
    const seq = attemptSeq.current;
    let stopped = false;
    const current = () => !stopped && context === contextEpoch.current && seq === attemptSeq.current;
    const timer = setTimeout(async () => {
      try {
        const next = await organizationGithubApp.attempt(attempt.attemptId);
        if (!current()) return;
        setAttempt(next);
        if (next.state === "connected") {
          setNotice(`Connected ${next.installation?.accountLogin ?? "the installation"}. Choose which repositories cloud workspaces can use.`);
          void load();
        } else if (next.state === "failed") {
          setError(attemptErrorMessage(next.errorCode));
        } else if (ATTEMPT_END_MESSAGE[next.state]) {
          setNotice(ATTEMPT_END_MESSAGE[next.state]);
        }
      } catch (failure) {
        if (!current()) return;
        // A network blip keeps polling; anything else ends the attempt.
        if (githubAppErrorCode(failure) === "github_app_request_failed") {
          setAttempt({ ...attempt });
        } else {
          setAttempt(null);
          setError(githubAppErrorMessage(failure));
        }
      }
    }, pollIntervalMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [attempt, load, pollIntervalMs]);

  // `{ value }` on success: a command that returns nothing resolves to null,
  // which must not read as a failure.
  const act = async <T,>(key: string, run: (revision: string) => Promise<T>): Promise<{ value: T } | null> => {
    if (!summary || busy) return null;
    const current = contextEpoch.current;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const value = await run(summary.contextRevision);
      if (current !== contextEpoch.current) return null;
      return { value };
    } catch (failure) {
      if (current !== contextEpoch.current) return null;
      setError(githubAppErrorMessage(failure));
      // The server is authoritative; re-read so the panel shows what it holds.
      void load(true);
      return null;
    } finally {
      if (current === contextEpoch.current) setBusy(null);
    }
  };

  const connect = async () => {
    const started = await act("connect", (revision) => organizationGithubApp.connect(revision));
    if (started) {
      attemptSeq.current += 1;
      setAttempt(started.value);
    }
  };

  const cancelAttempt = async () => {
    if (!attempt) return;
    attemptSeq.current += 1;
    const canceled = await act("cancel", (revision) => organizationGithubApp.cancelAttempt(attempt.attemptId, revision));
    const ended = canceled?.value;
    if (!ended) {
      // Not canceled: keep polling the attempt.
      setAttempt((shown) => (shown ? { ...shown } : shown));
    } else {
      setAttempt(ended.state === "waiting" ? null : ended);
      if (ended.state === "connected") void load();
      else setNotice(ATTEMPT_END_MESSAGE.canceled);
    }
  };

  const loadChooser = useCallback(async (installationId: string, query: string, refresh: boolean) => {
    const current = ++chooserSeq.current;
    const context = contextEpoch.current;
    const fresh = () => current === chooserSeq.current && context === contextEpoch.current;
    setChooser((shown) => ({
      installationId,
      query,
      live: shown?.installationId === installationId ? shown.live : null,
      draft: shown?.installationId === installationId ? shown.draft : null,
      loading: true,
      error: null,
    }));
    try {
      const live = await organizationGithubApp.repositories(installationId, query, refresh);
      if (!fresh()) return;
      setChooser((shown) =>
        shown && shown.installationId === installationId
          ? {
              ...shown,
              live,
              loading: false,
              // The first list seeds the draft; later searches keep the admin's edits.
              // Seeded from the live flags and the stored selection, so a
              // repository past a truncated or filtered list is not dropped
              // on save.
              draft:
                shown.draft ??
                new Set([
                  ...live.repositories.filter((repository) => repository.selected).map((repository) => repository.githubRepositoryId),
                  ...storedSelection(installationId),
                ]),
            }
          : shown,
      );
      // A live refresh also updates the stored states.
      if (refresh) void load(true);
    } catch (failure) {
      if (!fresh()) return;
      setChooser((shown) => (shown && shown.installationId === installationId ? { ...shown, loading: false, error: githubAppErrorMessage(failure) } : shown));
    }
  }, [load]);

  const saveSelection = async () => {
    if (!summary || !chooser?.draft) return;
    const kept: RepositoryChoice[] = summary.repositories
      .filter((repository) => repository.installationId !== chooser.installationId && repository.state === "accessible")
      .map((repository) => ({ installationId: repository.installationId, githubRepositoryId: repository.githubRepositoryId }));
    const chosen: RepositoryChoice[] = [...chooser.draft].map((githubRepositoryId) => ({ installationId: chooser.installationId, githubRepositoryId }));
    const choices = [...kept, ...chosen];
    if (choices.length > MAX_SELECTED_REPOSITORIES) return;
    const saved = await act("save", (revision) => organizationGithubApp.saveRepositories(choices, revision));
    if (saved !== null) {
      setChooser(null);
      setNotice("Repository selection saved.");
      void load();
    } else if (chooser) {
      void loadChooser(chooser.installationId, chooser.query, true);
    }
  };

  const disconnect = async (installation: GithubInstallation) => {
    const done = await act(`disconnect:${installation.id}`, (revision) => organizationGithubApp.disconnect(installation.id, revision));
    setConfirmDisconnect(null);
    if (done !== null) {
      if (chooser?.installationId === installation.id) setChooser(null);
      setNotice(`Disconnected ${installation.accountLogin}. The app stays installed on GitHub until you uninstall it there.`);
      void load();
    }
  };

  const openOnGithub = (url: string) => {
    void organizationGithubApp.open(url).catch((failure) => setError(githubAppErrorMessage(failure)));
  };

  const header = (
    <div className="flex items-center justify-between">
      <div className="text-sm font-medium">GitHub repositories</div>
      {summary && (
        <Button variant="ghost" size="icon-xs" aria-label="Refresh GitHub access" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
      )}
    </div>
  );

  if (notConfigured) {
    return (
      <div className="rounded-lg border border-hairline p-3">
        {header}
        <p className="mt-2 text-xs text-muted-foreground">
          The GitHub App is not configured on this server, so cloud workspaces cannot reach GitHub through an installation. An administrator of this TerminalX server has to set it up first.
        </p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="rounded-lg border border-hairline p-3">
        {header}
        {loading ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading GitHub access…
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <p className="text-xs text-destructive">{error}</p>
            <Button variant="ghost" size="xs" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  }

  const byInstallation = (installationId: string) => summary.repositories.filter((repository) => repository.installationId === installationId);
  const waiting = attempt?.state === "waiting";

  return (
    <div className="rounded-lg border border-hairline p-3">
      {header}
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Cloud workspaces reach GitHub through a GitHub App installed on your GitHub account or organization. Each workspace gets short-lived access to the repositories chosen here, and nothing else.
      </p>
      {!canManage && <p className="mt-1 text-[11px] text-muted-foreground">Only owners and admins can connect GitHub or choose repositories.</p>}

      {summary.installations.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No GitHub installation is connected yet.</p>
      ) : (
        <ul aria-label="GitHub installations" className="mt-2 flex flex-col divide-y divide-hairline">
          {summary.installations.map((installation) => (
            <InstallationRow
              key={installation.id}
              installation={installation}
              repositories={byInstallation(installation.id)}
              manage={canManage}
              busy={busy}
              choosing={chooser?.installationId === installation.id}
              confirming={confirmDisconnect === installation.id}
              onOpen={openOnGithub}
              onChoose={() => {
                chooserSeq.current += 1;
                setChooser(null);
                void loadChooser(installation.id, "", false);
              }}
              onDisconnect={() => setConfirmDisconnect(installation.id)}
              onCancelDisconnect={() => setConfirmDisconnect(null)}
              onConfirmDisconnect={() => void disconnect(installation)}
            />
          ))}
        </ul>
      )}

      {chooser && canManage && (
        <RepositoryChooser
          chooser={chooser}
          busy={busy}
          otherSelected={summary.repositories.filter((repository) => repository.installationId !== chooser.installationId)}
          onQuery={(query) => setChooser({ ...chooser, query })}
          onSearch={() => void loadChooser(chooser.installationId, chooser.query, false)}
          onRefresh={() => void loadChooser(chooser.installationId, chooser.query, true)}
          onToggle={(id) => {
            const draft = new Set(chooser.draft ?? []);
            if (draft.has(id)) draft.delete(id);
            else draft.add(id);
            setChooser({ ...chooser, draft });
          }}
          onOpen={openOnGithub}
          onSave={() => void saveSelection()}
          onClose={() => {
            chooserSeq.current += 1;
            setChooser(null);
          }}
        />
      )}

      {canManage && (
        <div className="mt-3 flex flex-col gap-1.5">
          {waiting ? (
            <div className="rounded-md bg-well p-2 text-[11px]" role="status">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {attempt.browserOpened
                  ? "Finish in your browser: install the app on GitHub, then confirm the organization on the TerminalX page. This updates once you confirm."
                  : "Your browser did not open. Open the install page to continue."}
              </div>
              <div className="mt-1.5 flex gap-2">
                {attempt.installUrl && (
                  <Button variant="ghost" size="xs" onClick={() => openOnGithub(attempt.installUrl!)}>
                    Open install page
                  </Button>
                )}
                <Button variant="ghost" size="xs" disabled={Boolean(busy)} onClick={() => void cancelAttempt()}>
                  {busy === "cancel" ? <Loader2 className="animate-spin" /> : "Cancel"}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button size="sm" className="h-8" disabled={Boolean(busy)} onClick={() => void connect()}>
                {busy === "connect" ? <Loader2 className="animate-spin" /> : summary.installations.length ? "Connect another installation" : "Connect GitHub"}
              </Button>
            </div>
          )}
        </div>
      )}

      {notice && (
        <p className="mt-2 text-[11px] text-muted-foreground" role="status">
          {notice}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ManageLink({ url, onOpen, label = "Manage on GitHub" }: { url?: string; onOpen: (url: string) => void; label?: string }) {
  if (!url) return null;
  return (
    <Button variant="ghost" size="xs" onClick={() => onOpen(url)}>
      {label} <ExternalLink className="size-3" />
    </Button>
  );
}

function InstallationRow({
  installation,
  repositories,
  manage,
  busy,
  choosing,
  confirming,
  onOpen,
  onChoose,
  onDisconnect,
  onCancelDisconnect,
  onConfirmDisconnect,
}: {
  installation: GithubInstallation;
  repositories: SelectedRepository[];
  manage: boolean;
  busy: string | null;
  choosing: boolean;
  confirming: boolean;
  onOpen: (url: string) => void;
  onChoose: () => void;
  onDisconnect: () => void;
  onCancelDisconnect: () => void;
  onConfirmDisconnect: () => void;
}) {
  const state = INSTALLATION_STATE_LABEL[installation.state] ?? installation.state;
  return (
    <li className="py-2" aria-label={installation.accountLogin}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{installation.accountLogin}</div>
          <div className="text-[11px] text-muted-foreground">
            {state} · {installation.repositorySelection === "all" ? "All repositories" : "Selected repositories"}
          </div>
        </div>
        {busy === `disconnect:${installation.id}` && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <ManageLink url={installation.manageUrl} onOpen={onOpen} />
        {manage && (
          <>
            {installation.state === "connected" && !choosing && (
              <Button variant="ghost" size="xs" disabled={Boolean(busy)} onClick={onChoose} aria-label={`Choose repositories for ${installation.accountLogin}`}>
                Choose repositories
              </Button>
            )}
            <Button variant="ghost" size="xs" disabled={Boolean(busy)} onClick={onDisconnect} aria-label={`Disconnect ${installation.accountLogin}`}>
              Disconnect
            </Button>
          </>
        )}
      </div>
      {installation.state === "suspended" && (
        <p className="mt-1 text-[11px] text-muted-foreground">Suspended on GitHub. Workspaces cannot reach its repositories until it is unsuspended in its settings on GitHub.</p>
      )}
      {installation.state === "revoked" && (
        <p className="mt-1 text-[11px] text-muted-foreground">The app was uninstalled on GitHub. Disconnect this installation and connect GitHub again.</p>
      )}
      {repositories.length > 0 ? (
        <ul aria-label={`Repositories for ${installation.accountLogin}`} className="mt-1.5 flex flex-col gap-1">
          {repositories.map((repository) => (
            <RepositoryRow key={repository.id} repository={repository} manageUrl={installation.manageUrl} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-faint">No repositories chosen for cloud workspaces.</p>
      )}
      {confirming && (
        <div className="mt-2 rounded-md border border-destructive/25 bg-destructive/5 p-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Cloud workspaces lose access to {installation.accountLogin}'s repositories, and its repository choices are removed. The app stays installed on GitHub; uninstall it there if you no longer need it.
          </p>
          <div className="mt-2 flex gap-2">
            <Button variant="destructive" size="xs" disabled={Boolean(busy)} onClick={onConfirmDisconnect}>
              Confirm disconnect
            </Button>
            <Button variant="ghost" size="xs" disabled={Boolean(busy)} onClick={onCancelDisconnect}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function RepositoryRow({ repository, manageUrl, onOpen }: { repository: SelectedRepository; manageUrl?: string; onOpen: (url: string) => void }) {
  const explanation = repositoryExplanation(repository);
  return (
    <li aria-label={repository.fullName} className="rounded-md bg-well px-2 py-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-mono">{repository.fullName}</span>
        <span className={repository.state === "accessible" ? "text-muted-foreground" : "text-destructive"}>
          {REPOSITORY_STATE_LABEL[repository.state] ?? repository.state}
        </span>
      </div>
      {explanation && (
        <div className="mt-1 flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">{explanation}</p>
          {fixedOnGithub(repository) && <ManageLink url={manageUrl} onOpen={onOpen} />}
        </div>
      )}
    </li>
  );
}

function RepositoryChooser({
  chooser,
  busy,
  otherSelected,
  onQuery,
  onSearch,
  onRefresh,
  onToggle,
  onOpen,
  onSave,
  onClose,
}: {
  chooser: Chooser;
  busy: string | null;
  otherSelected: SelectedRepository[];
  onQuery: (query: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  onToggle: (githubRepositoryId: number) => void;
  onOpen: (url: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const live = chooser.live;
  const draft = chooser.draft ?? new Set<number>();
  const keptElsewhere = otherSelected.filter((repository) => repository.state === "accessible").length;
  const droppedElsewhere = otherSelected.length - keptElsewhere;
  const total = keptElsewhere + draft.size;
  const tooMany = total > MAX_SELECTED_REPOSITORIES;
  return (
    <div className="mt-3 rounded-md border border-hairline p-2" aria-label="Choose repositories" role="group">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium">Choose repositories{live ? ` for ${live.installation.accountLogin}` : ""}</div>
        <Button variant="ghost" size="xs" onClick={onClose}>
          Close
        </Button>
      </div>
      <form
        className="mt-1.5 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <input
          aria-label="Search repositories"
          type="search"
          placeholder="Filter by name"
          className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-background px-2 text-xs"
          value={chooser.query}
          maxLength={200}
          onChange={(event) => onQuery(event.target.value)}
        />
        <Button size="xs" type="submit" variant="ghost" disabled={chooser.loading}>
          Search
        </Button>
        <Button size="icon-xs" type="button" variant="ghost" aria-label="Refresh from GitHub" disabled={chooser.loading} onClick={onRefresh}>
          <RefreshCw className={chooser.loading ? "animate-spin" : undefined} />
        </Button>
      </form>
      {chooser.loading && !live && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading repositories from GitHub…
        </div>
      )}
      {chooser.error && <p className="mt-2 text-xs text-destructive">{chooser.error}</p>}
      {live && (
        <>
          {live.repositories.length === 0 ? (
            <p className="mt-2 text-[11px] text-muted-foreground">No repositories match.</p>
          ) : (
            <ul aria-label="Available repositories" className="mt-2 flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {live.repositories.map((repository) => (
                <li key={repository.githubRepositoryId}>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      aria-label={repository.fullName}
                      checked={draft.has(repository.githubRepositoryId)}
                      disabled={Boolean(busy)}
                      onChange={() => onToggle(repository.githubRepositoryId)}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono">{repository.fullName}</span>
                    {repository.private && <span className="text-[10px] text-faint">private</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {live.truncated && (
            <p className="mt-1 text-[11px] text-muted-foreground">Only the first 1,000 repositories are listed. Search to narrow the list.</p>
          )}
          {live.missing.length > 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              <p>
                These chosen repositories are no longer granted to the installation and are removed when you save:{" "}
                {live.missing.map((repository) => repository.fullName).join(", ")}. To keep them, grant them on GitHub, then refresh.
              </p>
              <ManageLink url={live.manageUrl ?? live.installation.manageUrl} onOpen={onOpen} />
            </div>
          )}
          {droppedElsewhere > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Saving also removes {droppedElsewhere} repositor{droppedElsewhere === 1 ? "y" : "ies"} from other installations that are no longer accessible.
            </p>
          )}
          {tooMany && <p className="mt-1 text-[11px] text-destructive">Choose at most {MAX_SELECTED_REPOSITORIES} repositories in total.</p>}
          <div className="mt-2 flex items-center gap-2">
            <Button size="xs" disabled={Boolean(busy) || tooMany || !chooser.draft} onClick={onSave}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : "Save selection"}
            </Button>
            <span className="text-[11px] text-faint">{draft.size} selected</span>
          </div>
        </>
      )}
    </div>
  );
}
