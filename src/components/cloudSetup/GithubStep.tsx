import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Github, Loader2, Lock, RefreshCw, Search } from "@/icons";
import { Button } from "@/components/ui/button";
import { organizationMembers } from "@/lib/organizationMembers";
import {
  INSTALLATION_STATE_LABEL,
  MAX_SELECTED_REPOSITORIES,
  githubAppErrorCode,
  githubAppErrorMessage,
  organizationGithubApp,
  repositoryExplanation,
  type AttemptOutcome,
  type GithubAppSummary,
  type GithubInstallation,
  type LiveRepositories,
  type LiveRepository,
  type RepositoryChoice,
} from "@/lib/organizationGithubApp";
import { cn } from "@/lib/cn";
import { PrimaryButton, StepActions, StepError, StepPage } from "./FlowLayout";
import type { StepProps } from "./stepProps";
import { CONNECT_POLL_INTERVAL_MS, useGithubConnectAttempt } from "@/lib/useGithubConnectAttempt";

const SEARCH_DELAY_MS = 300;

/** One installation's repositories as GitHub lists them now (unfiltered). */
interface Listing {
  live: LiveRepositories | null;
  loading: boolean;
  error: string | null;
}

/** A server search, used only when an installation's list is truncated and a filter is typed. */
interface ServerSearch {
  installationId: string;
  query: string;
  live: LiveRepositories | null;
  loading: boolean;
  error: string | null;
}

type Busy = "connect" | "cancel" | "save" | null;

/** "Procyon Labs" → "procyon-labs": the folder the workspace keeps its repositories in. */
function folderOf(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "workspace";
}

/** "procyon-labs/terminalx" → "terminalx". */
function shortName(fullName: string): string {
  return fullName.slice(fullName.lastIndexOf("/") + 1) || fullName;
}

/** "a", "a and b", "a, b and c", with the names set apart. */
function Joined({ names }: { names: string[] }) {
  return (
    <span className="min-w-0">
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 && <span className="text-muted-foreground">{index === names.length - 1 ? " and " : ", "}</span>}
          <span className="font-medium">{name}</span>
        </span>
      ))}
    </span>
  );
}

const choiceKey = (choice: RepositoryChoice) => `${choice.installationId}:${choice.githubRepositoryId}`;

/**
 * Step 2 (12.02): install the TerminalX GitHub App on a GitHub account or
 * organization, then choose the repositories the organization's cloud
 * workspaces can use. The choice is a draft until Continue, which saves the
 * whole selection (the server replaces it) only when it changed. GitHub can
 * wait: Continue goes on with nothing chosen.
 */
export function GithubStep({ organization, onContinue, pollIntervalMs = CONNECT_POLL_INTERVAL_MS }: StepProps & { pollIntervalMs?: number }) {
  const [summary, setSummary] = useState<GithubAppSummary | null>(null);
  const summaryRef = useRef<GithubAppSummary | null>(null);
  summaryRef.current = summary;
  const [notConfigured, setNotConfigured] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [active, setActive] = useState<string | null>(null);
  const [lists, setLists] = useState<Record<string, Listing>>({});
  const [drafts, setDrafts] = useState<Record<string, Set<number>>>({});
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<ServerSearch | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Orders reads so an older answer never overwrites a newer one.
  const loadSeq = useRef(0);
  const listSeq = useRef<Record<string, number>>({});
  const searchSeq = useRef(0);

  /** The repositories stored for an installation that workspaces can reach. */
  const stored = useCallback(
    (installationId: string, from: GithubAppSummary | null = summaryRef.current) =>
      (from?.repositories ?? [])
        .filter((repository) => repository.installationId === installationId && repository.state === "accessible")
        .map((repository) => repository.githubRepositoryId),
    [],
  );

  const load = useCallback(async (keepError = false) => {
    const current = ++loadSeq.current;
    const fresh = () => mounted.current && current === loadSeq.current;
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
      if (!fresh()) return;
      setSummary(next);
      setNotConfigured(!next.configured);
      setCanManage(Boolean(manage));
      if (!keepError) setError(null);
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
    void load();
  }, [load]);

  const loadList = useCallback(
    async (installationId: string, refresh: boolean) => {
      const current = (listSeq.current[installationId] ?? 0) + 1;
      listSeq.current[installationId] = current;
      const fresh = () => mounted.current && listSeq.current[installationId] === current;
      setLists((shown) => ({ ...shown, [installationId]: { live: shown[installationId]?.live ?? null, loading: true, error: null } }));
      try {
        const live = await organizationGithubApp.repositories(installationId, "", refresh);
        if (!fresh()) return;
        setLists((shown) => ({ ...shown, [installationId]: { live, loading: false, error: null } }));
        // The first list seeds the draft from the live flags and the stored
        // selection, so a repository past a truncated list is not dropped on
        // save; later lists keep the person's edits.
        setDrafts((shown) =>
          shown[installationId]
            ? shown
            : {
                ...shown,
                [installationId]: new Set([...live.repositories.filter((repository) => repository.selected).map((repository) => repository.githubRepositoryId), ...stored(installationId)]),
              },
        );
        // A live refresh also updates the stored states.
        if (refresh) void load(true);
      } catch (failure) {
        if (!fresh()) return;
        setLists((shown) => ({ ...shown, [installationId]: { live: shown[installationId]?.live ?? null, loading: false, error: githubAppErrorMessage(failure) } }));
      }
    },
    [load, stored],
  );

  const connected = useMemo(() => (summary?.installations ?? []).filter((installation) => installation.state === "connected"), [summary]);
  const others = useMemo(() => (summary?.installations ?? []).filter((installation) => installation.state !== "connected"), [summary]);

  // Every connected installation's repositories are listed once (for its count and its draft), and one is shown.
  useEffect(() => {
    if (!canManage) return;
    for (const installation of connected) {
      if (!lists[installation.id]) void loadList(installation.id, false);
    }
  }, [canManage, connected, lists, loadList]);
  useEffect(() => {
    if (active && connected.some((installation) => installation.id === active)) return;
    setActive(connected[0]?.id ?? null);
  }, [active, connected]);

  // A filter on a list GitHub truncated is searched on the server; a complete list is filtered here.
  const activeList = active ? lists[active] : undefined;
  const trimmedQuery = query.trim();
  const serverSearch = Boolean(active && trimmedQuery && activeList?.live?.truncated);
  useEffect(() => {
    if (!serverSearch || !active) {
      searchSeq.current += 1;
      setSearch(null);
      return;
    }
    const current = ++searchSeq.current;
    const fresh = () => mounted.current && current === searchSeq.current;
    setSearch((shown) => ({ installationId: active, query: trimmedQuery, live: shown?.installationId === active ? shown.live : null, loading: true, error: null }));
    const timer = setTimeout(async () => {
      try {
        const live = await organizationGithubApp.repositories(active, trimmedQuery, false);
        if (fresh()) setSearch({ installationId: active, query: trimmedQuery, live, loading: false, error: null });
      } catch (failure) {
        if (fresh()) setSearch((shown) => (shown ? { ...shown, loading: false, error: githubAppErrorMessage(failure) } : shown));
      }
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [serverSearch, active, trimmedQuery]);

  const connectAttempt = useGithubConnectAttempt({
    pollIntervalMs,
    onEnd: (outcome: AttemptOutcome | null, ended) => {
      if (!outcome) return;
      if (outcome.kind === "error") setError(outcome.message);
      else setNotice(outcome.message);
      if (outcome.kind === "connected") {
        if (ended?.installation) setActive(ended.installation.id);
        void load();
      } else if (outcome.kind === "unsettled") {
        // The attempt may have connected on the server: re-read to reconcile.
        void load();
      }
    },
  });
  const { attempt, waiting } = connectAttempt;

  // `{ value }` on success: a command that returns nothing resolves to null, which must not read as a failure.
  const act = async <T,>(key: Exclude<Busy, null>, run: (revision: string) => Promise<T>): Promise<{ value: T } | null> => {
    if (!summary || busy) return null;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const value = await run(summary.contextRevision);
      if (!mounted.current) return null;
      return { value };
    } catch (failure) {
      if (!mounted.current) return null;
      setError(githubAppErrorMessage(failure));
      // The server is authoritative; re-read so the step shows what it holds.
      void load(true);
      return null;
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const connect = async () => {
    const started = await act("connect", (revision) => organizationGithubApp.connect(revision));
    if (started) connectAttempt.start(started.value);
  };

  const cancelAttempt = () =>
    connectAttempt.cancel((attemptId) => act("cancel", (revision) => organizationGithubApp.cancelAttempt(attemptId, revision)));

  const openOnGithub = (url: string) => {
    void organizationGithubApp.open(url).catch((failure) => {
      if (mounted.current) setError(githubAppErrorMessage(failure));
    });
  };

  const refreshAll = () => {
    setError(null);
    setNotice(null);
    void load();
    if (active && canManage) void loadList(active, true);
  };

  // The selection Continue would save: each installation's draft, or what is stored for one never opened.
  const storedChoices: RepositoryChoice[] = (summary?.repositories ?? [])
    .filter((repository) => repository.state === "accessible")
    .map((repository) => ({ installationId: repository.installationId, githubRepositoryId: repository.githubRepositoryId }));
  const choices: RepositoryChoice[] = [
    ...storedChoices.filter((choice) => !drafts[choice.installationId]),
    ...Object.entries(drafts).flatMap(([installationId, ids]) => [...ids].map((githubRepositoryId) => ({ installationId, githubRepositoryId }))),
  ];
  // Compared with what workspaces can reach now: one no longer reachable is dropped only with a change the person made.
  const storedKeys = new Set(storedChoices.map(choiceKey));
  const changed = choices.length !== storedKeys.size || choices.some((choice) => !storedKeys.has(choiceKey(choice)));
  const dropped = (summary?.repositories ?? []).filter((repository) => repository.state !== "accessible").length;
  const tooMany = choices.length > MAX_SELECTED_REPOSITORIES;

  const nameOf = (choice: RepositoryChoice): string | null => {
    const fromList =
      lists[choice.installationId]?.live?.repositories.find((repository) => repository.githubRepositoryId === choice.githubRepositoryId) ??
      (search?.installationId === choice.installationId ? search.live?.repositories.find((repository) => repository.githubRepositoryId === choice.githubRepositoryId) : undefined);
    if (fromList) return fromList.fullName;
    return summary?.repositories.find((repository) => repository.installationId === choice.installationId && repository.githubRepositoryId === choice.githubRepositoryId)?.fullName ?? null;
  };
  const chosenNames = choices
    .map(nameOf)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => a.localeCompare(b));
  const shortNames = chosenNames.map(shortName);
  const shown = chosenNames.map((fullName, index) => (shortNames.filter((name) => name === shortNames[index]).length > 1 ? fullName : shortNames[index]!));

  const toggle = (installationId: string, ids: number[], on: boolean) => {
    setDrafts((current) => {
      const draft = new Set(current[installationId] ?? stored(installationId));
      for (const id of ids) {
        if (on) draft.add(id);
        else draft.delete(id);
      }
      return { ...current, [installationId]: draft };
    });
  };

  const save = async () => {
    if (busy) return;
    if (!summary || !canManage || notConfigured || !changed) {
      onContinue();
      return;
    }
    if (tooMany) return;
    const saved = await act("save", (revision) => organizationGithubApp.saveRepositories(choices, revision));
    if (saved !== null) {
      onContinue();
      return;
    }
    // Refused or unknown: the lists are read again from GitHub so the next try is against what it holds.
    if (active && mounted.current) void loadList(active, true);
  };

  const manageUrl = (active && (lists[active]?.live?.manageUrl ?? connected.find((installation) => installation.id === active)?.manageUrl)) || connected.find((installation) => installation.manageUrl)?.manageUrl;

  const waitingPanel = waiting && attempt && (
    <div className="rounded-lg bg-well p-3 text-[12.5px]" role="status">
      <div className="flex items-start gap-2 text-muted-foreground">
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
        <span>
          {attempt.browserOpened
            ? "Finish in your browser: install the app on GitHub, then confirm the organization on the TerminalX page. This updates once you confirm."
            : "Your browser did not open. Open the install page to continue."}
        </span>
      </div>
      <div className="mt-2 flex gap-2 pl-5.5">
        {attempt.installUrl && (
          <Button variant="outline" size="sm" onClick={() => openOnGithub(attempt.installUrl!)}>
            Open install page <ArrowUpRight />
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void cancelAttempt()}>
          {busy === "cancel" ? <Loader2 className="animate-spin" /> : "Cancel"}
        </Button>
      </div>
    </div>
  );

  let body: ReactNode;
  if (notConfigured) {
    body = (
      <div className="rounded-xl border border-hairline bg-card p-4 text-[12.5px] leading-[19px] text-muted-foreground" role="status">
        The GitHub App is not configured on this server, so cloud workspaces cannot reach GitHub through an installation yet. An administrator of this TerminalX server has to set it
        up first. You can go on and connect GitHub later from Settings.
      </div>
    );
  } else if (!summary) {
    body = (
      <div className="rounded-xl border border-hairline bg-card p-4 text-[12.5px]">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" /> Loading GitHub access…
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-destructive">{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    );
  } else if (summary.installations.length === 0) {
    body = (
      <div className="rounded-xl border border-hairline bg-card p-5" data-testid="cloud-setup-github-install">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised">
            <Github className="size-4.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium">Install the GitHub App</div>
            <p className="mt-1 text-[12.5px] leading-[19px] text-muted-foreground">
              Install the TerminalX GitHub App on the GitHub account or organization that owns your repositories. Each workspace gets short-lived access to the repositories you
              choose, and nothing else.
            </p>
            {canManage ? (
              <div className="mt-3">
                {waiting ? (
                  waitingPanel
                ) : (
                  <Button size="sm" className="h-8" disabled={Boolean(busy)} onClick={() => void connect()}>
                    {busy === "connect" ? <Loader2 className="animate-spin" /> : <Github />}
                    Install the GitHub App
                  </Button>
                )}
              </div>
            ) : (
              <p className="mt-3 text-[12.5px] text-muted-foreground">Only owners and admins of {organization.name} can connect GitHub. Ask one of them, or go on and come back later.</p>
            )}
          </div>
        </div>
      </div>
    );
  } else {
    const logins = summary.installations.map((installation) => installation.accountLogin);
    const listing = active ? lists[active] : undefined;
    const activeInstallation = connected.find((installation) => installation.id === active) ?? null;
    const draft = active ? (drafts[active] ?? new Set(stored(active))) : new Set<number>();
    let rows: LiveRepository[] | null = null;
    let rowsLoading = false;
    let rowsError: string | null = null;
    if (serverSearch) {
      rows = search?.live?.repositories ?? null;
      rowsLoading = search?.loading ?? true;
      rowsError = search?.error ?? null;
    } else if (listing) {
      const needle = trimmedQuery.toLowerCase();
      rows = listing.live ? listing.live.repositories.filter((repository) => !needle || repository.fullName.toLowerCase().includes(needle)) : null;
      rowsLoading = listing.loading;
      rowsError = listing.error;
    }
    const allOn = Boolean(rows?.length) && rows!.every((repository) => draft.has(repository.githubRepositoryId));
    const missing = listing?.live?.missing ?? [];

    body = (
      <div className="rounded-xl border border-hairline bg-card">
        <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-4 py-2 text-[13px]">
          <span className="grid size-5 place-items-center rounded-full bg-add/15 text-add">
            <Check className="size-3" />
          </span>
          <span className="ml-1 text-muted-foreground">GitHub App installed on</span>
          <Joined names={logins} />
          {manageUrl && (
            <button type="button" className="ml-auto flex items-center gap-1 rounded text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => openOnGithub(manageUrl)}>
              Manage on GitHub <ArrowUpRight className="size-3" />
            </button>
          )}
        </div>

        {!canManage ? (
          <div className="px-4 py-3">
            <p className="text-[12.5px] text-muted-foreground">Only owners and admins of {organization.name} can choose repositories. These are the ones workspaces can use now.</p>
            {summary.repositories.length ? (
              <ul aria-label="Chosen repositories" className="mt-2 grid gap-1">
                {summary.repositories.map((repository) => (
                  <li key={repository.id} className="flex items-center gap-2 rounded-md bg-well px-2.5 py-1.5 text-[12.5px]">
                    <span className="min-w-0 flex-1 truncate font-mono">{repository.fullName}</span>
                    <span className={repository.state === "accessible" ? "text-[12px] text-faint" : "text-[12px] text-warning"}>
                      {repository.state === "accessible" ? (repository.private ? "Private" : "Public") : repositoryExplanation(repository)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[12.5px] text-faint">No repositories are chosen yet.</p>
            )}
          </div>
        ) : (
          <div className="px-4 pt-3 pb-4">
            <div className="flex items-center gap-3">
              <span className="grid size-5 place-items-center rounded-full border border-hairline text-[11px]">2</span>
              <span className="text-[13px] font-medium">Choose repositories</span>
              <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Refresh from GitHub" title="Read the installations and repositories from GitHub again" disabled={loading || Boolean(listing?.loading)} onClick={refreshAll}>
                <RefreshCw className={loading || listing?.loading ? "animate-spin" : undefined} />
              </Button>
            </div>
            <div className="mt-2.5 overflow-hidden rounded-lg border border-hairline bg-raised sm:ml-8">
              <label className="flex h-9 items-center gap-2 border-b border-hairline px-3 text-[12.5px]">
                <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
                <input
                  aria-label="Filter repositories"
                  type="search"
                  placeholder="Filter by name"
                  maxLength={200}
                  className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <span className="shrink-0 text-[12px] text-muted-foreground" aria-live="polite">
                  {choices.length} selected
                </span>
              </label>
              <div className="flex h-[260px]">
                <div className="flex w-[210px] shrink-0 flex-col border-r border-hairline">
                  <div className="flex h-8 items-center px-3 text-[12px] text-faint">Installations</div>
                  <div className="min-h-0 flex-1 overflow-y-auto" role="radiogroup" aria-label="Installations">
                    {connected.map((installation) => {
                      const count = lists[installation.id]?.live;
                      const current = installation.id === active;
                      return (
                        <button
                          key={installation.id}
                          type="button"
                          role="radio"
                          aria-checked={current}
                          className={cn(
                            "mx-1.5 flex h-8 w-[calc(100%-12px)] items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                            current ? "bg-selected" : "hover:bg-veil-raised",
                          )}
                          onClick={() => {
                            setActive(installation.id);
                            setQuery("");
                          }}
                        >
                          <InstallationMark installation={installation} />
                          <span className="min-w-0 flex-1 truncate">{installation.accountLogin}</span>
                          {count && (
                            <span className="text-[12px] text-faint">
                              {count.repositories.length}
                              {count.truncated ? "+" : ""}
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {others.length > 0 && (
                      <>
                        <div className="px-3 pt-3 pb-1 text-[12px] text-faint">Not connected</div>
                        {others.map((installation) => (
                          <div key={installation.id} className="mx-1.5 flex h-8 items-center gap-2 px-2 text-[12.5px] text-faint" title={INSTALLATION_STATE_LABEL[installation.state] ?? installation.state}>
                            <InstallationMark installation={installation} muted />
                            <span className="min-w-0 flex-1 truncate">{installation.accountLogin}</span>
                            <span className="text-[12px]">{INSTALLATION_STATE_LABEL[installation.state] ?? installation.state}</span>
                            <Lock className="size-3 shrink-0" aria-hidden />
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    className="flex h-10 shrink-0 items-center gap-2 border-t border-hairline px-3 text-left text-[12.5px] outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
                    disabled={Boolean(busy) || waiting}
                    onClick={() => void connect()}
                  >
                    {busy === "connect" ? <Loader2 className="size-3.5 animate-spin" /> : <Github className="size-3.5" />}
                    Connect organization
                  </button>
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  {activeInstallation ? (
                    <>
                      <div className="flex h-8 shrink-0 items-center px-3 text-[12px] text-faint">
                        <span className="min-w-0 truncate">
                          {activeInstallation.accountLogin}
                          {listing?.live && ` · ${listing.live.repositories.length}${listing.live.truncated ? "+" : ""} repositor${listing.live.repositories.length === 1 ? "y" : "ies"}`}
                        </span>
                        {rows && rows.length > 0 && (
                          <button
                            type="button"
                            className="ml-auto shrink-0 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                            onClick={() => toggle(activeInstallation.id, rows!.map((repository) => repository.githubRepositoryId), !allOn)}
                          >
                            {allOn ? "Clear all" : "Select all"}
                          </button>
                        )}
                      </div>
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        {rows === null ? (
                          rowsLoading ? (
                            <div className="flex items-center gap-2 px-3 py-2 text-[12.5px] text-muted-foreground" role="status">
                              <Loader2 className="size-3.5 animate-spin" /> Loading repositories from GitHub…
                            </div>
                          ) : (
                            <div className="px-3 py-2 text-[12.5px]">
                              <span className="text-destructive">{rowsError}</span>{" "}
                              <Button variant="ghost" size="xs" onClick={() => void loadList(activeInstallation.id, false)}>
                                Try again
                              </Button>
                            </div>
                          )
                        ) : rows.length === 0 ? (
                          <p className="px-3 py-2 text-[12.5px] text-muted-foreground">
                            {trimmedQuery ? "No repositories match." : "This installation grants no repositories. Grant some on GitHub, then refresh."}
                          </p>
                        ) : (
                          <ul aria-label={`Repositories of ${activeInstallation.accountLogin}`}>
                            {rows.map((repository) => {
                              const on = draft.has(repository.githubRepositoryId);
                              return (
                                <li key={repository.githubRepositoryId}>
                                  <label className="flex h-[30px] cursor-pointer items-center gap-2.5 px-3 hover:bg-veil-raised">
                                    <input
                                      type="checkbox"
                                      className="peer sr-only"
                                      aria-label={repository.fullName}
                                      checked={on}
                                      disabled={busy === "save"}
                                      onChange={() => toggle(activeInstallation.id, [repository.githubRepositoryId], !on)}
                                    />
                                    <span
                                      aria-hidden
                                      className={cn(
                                        "grid size-4 shrink-0 place-items-center rounded-[4px] peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40",
                                        on ? "bg-accent text-accent-foreground" : "border border-hairline bg-card",
                                      )}
                                    >
                                      {on && <Check className="size-3" />}
                                    </span>
                                    <span className="min-w-0 truncate font-mono text-[12.5px]" title={repository.fullName}>
                                      {shortName(repository.fullName) === repository.fullName || repository.fullName.startsWith(`${activeInstallation.accountLogin}/`) ? shortName(repository.fullName) : repository.fullName}
                                    </span>
                                    <span className="shrink-0 truncate text-[12px] text-faint">
                                      {repository.private ? "Private" : "Public"}
                                      {repository.defaultBranch ? ` · ${repository.defaultBranch}` : ""}
                                    </span>
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        {rows && rowsLoading && (
                          <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-faint" role="status">
                            <Loader2 className="size-3 animate-spin" /> Reading GitHub…
                          </div>
                        )}
                        {rows && rowsError && <p className="px-3 py-1.5 text-[12px] text-destructive">{rowsError}</p>}
                      </div>
                    </>
                  ) : (
                    <p className="px-3 py-2 text-[12.5px] text-muted-foreground">No installation can be used right now. Connect an organization, or fix the installation on GitHub.</p>
                  )}
                </div>
              </div>
            </div>
            {listing?.live?.truncated && !trimmedQuery && (
              <p className="mt-2 text-[12px] text-muted-foreground sm:ml-8">GitHub listed only the first {listing.live.repositories.length.toLocaleString()} repositories. Filter by name to find the rest.</p>
            )}
            {missing.length > 0 && (
              <div className="mt-2 flex items-start gap-2 text-[12px] leading-[18px] text-warning sm:ml-8">
                <span className="min-w-0 flex-1">
                  No longer granted to the installation, so they are removed when you continue: {missing.map((repository) => repository.fullName).join(", ")}. To keep them, grant them on GitHub,
                  then refresh.
                </span>
                {(listing?.live?.manageUrl ?? activeInstallation?.manageUrl) && (
                  <Button variant="ghost" size="xs" onClick={() => openOnGithub((listing?.live?.manageUrl ?? activeInstallation?.manageUrl)!)}>
                    Manage on GitHub <ArrowUpRight />
                  </Button>
                )}
              </div>
            )}
            {changed && dropped > 0 && (
              <p className="mt-2 text-[12px] text-muted-foreground sm:ml-8">
                Continuing also removes {dropped} chosen repositor{dropped === 1 ? "y" : "ies"} that workspaces can no longer reach.
              </p>
            )}
            {waiting && <div className="mt-3 sm:ml-8">{waitingPanel}</div>}
          </div>
        )}
      </div>
    );
  }

  const folder = `~/${folderOf(organization.name)}/`;
  const note = notConfigured || !summary || choices.length === 0 ? "Choose later" : `${choices.length} repositor${choices.length === 1 ? "y" : "ies"}`;

  return (
    <StepPage
      title="Connect GitHub"
      description="Pick the repositories cloud workspaces clone. Every workspace gets its own copy of each one."
      asideLabel="Each workspace gets"
      aside={
        <>
          <div className="rounded-xl border border-hairline bg-well p-4 font-mono text-[12.5px] leading-[22px]" data-testid="cloud-setup-github-tree">
            <div className="text-muted-foreground">{folder}</div>
            {shown.length ? (
              shown.map((name, index) => (
                <div key={`${name}:${index}`} className="truncate">
                  {index === shown.length - 1 ? "└─" : "├─"} {name}
                </div>
              ))
            ) : (
              <div className="text-faint">└─ no repositories yet</div>
            )}
          </div>
          <p className="mt-3 text-[12px] leading-[18px] text-faint">Commits from cloud workspaces are authored as the person who sent the message.</p>
        </>
      }
    >
      {body}
      {notice && (
        <p className="mt-3 text-[12.5px] text-muted-foreground" role="status">
          {notice}
        </p>
      )}
      {tooMany && <StepError>Choose at most {MAX_SELECTED_REPOSITORIES} repositories in total.</StepError>}
      <StepActions note={note}>
        <PrimaryButton busy={busy === "save"} disabled={busy === "save" || busy === "connect" || busy === "cancel" || tooMany} onClick={() => void save()}>
          Continue
        </PrimaryButton>
      </StepActions>
      {summary && <StepError>{error}</StepError>}
    </StepPage>
  );
}

function InstallationMark({ installation, muted = false }: { installation: GithubInstallation; muted?: boolean }) {
  const letter = (installation.accountLogin[0] ?? "?").toUpperCase();
  const organization = installation.accountType.toLowerCase() === "organization";
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center text-[9px] font-bold",
        organization ? "rounded" : "rounded-full",
        muted ? "bg-muted text-faint" : organization ? "bg-accent text-accent-foreground" : "bg-accent/15 text-accent",
      )}
    >
      {letter}
    </span>
  );
}
