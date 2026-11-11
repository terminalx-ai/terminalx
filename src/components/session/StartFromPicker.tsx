import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Popover, Tabs } from "radix-ui";
import { ChevronDown, Search } from "@/icons";
import { api, errorMessage, issues, type Issue, type PullRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { refreshWorkspaces, useSessionStore } from "@/lib/sessions";
import { usePrSearch } from "@/lib/usePrSearch";
import type { BranchInfo } from "@/types/session";
import { ConnectLinear } from "./ConnectLinear";

export type BranchTarget = { kind: "new" } | { kind: "open"; cwd: string } | { kind: "existing"; branch: string };

type Tab = "branches" | "issues" | "prs";
type Row = { id: string; title: string; note?: string; pick: () => void };

/** One search field across all three sources. Arrows + Enter choose; Tab reaches the tab strip. */
export function StartFromPicker({
  projectPath,
  defaultBranch,
  label,
  open,
  onOpenChange,
  onBranch,
  onIssue,
  onPr,
  onSession,
  disabled,
}: {
  projectPath: string;
  defaultBranch: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBranch: (target: BranchTarget) => void;
  onIssue: (issue: Issue) => void;
  onPr: (pr: PullRequest) => void;
  onSession: (id: string) => void;
  disabled: boolean;
}) {
  const store = useSessionStore();
  const prefs = usePrefs();
  const [tab, setTab] = useState<Tab>("branches");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<"github" | "linear">(prefs.issueProvider ?? "github");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [issueResult, setIssueResult] = useState<{ key: string; items: Issue[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linearConnected, setLinearConnected] = useState<boolean | null>(null);
  const [highlight, setHighlight] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const prs = usePrSearch(open && tab === "prs" ? projectPath : null, query);
  const searchQuery = tab === "branches" ? "" : query;
  const issueKey = JSON.stringify([projectPath, provider, searchQuery]);
  const needsLinear = provider === "linear" && linearConnected === false;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setQuery("");
    void refreshWorkspaces(projectPath).catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [open, projectPath]);
  useEffect(() => {
    setHighlight(0);
  }, [query, tab, projectPath, provider]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  useEffect(() => {
    if (!open || tab !== "issues" || provider !== "linear") return;
    let live = true;
    issues
      .linearStatus()
      .then((status) => live && setLinearConnected(status.connected))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [open, tab, provider]);
  useEffect(() => {
    if (!open || tab === "prs" || (tab === "issues" && needsLinear)) return;
    let live = true;
    setError(null);
    setLoading(true);
    setBranches([]);
    setIssueResult(null);
    const timer = window.setTimeout(
      () => {
        const request =
          tab === "branches"
            ? api.listBranches(projectPath).then((items) => {
                if (live) setBranches(items);
              })
            : issues.list(projectPath, provider, { search: searchQuery }).then((items) => {
                if (live) setIssueResult({ key: issueKey, items });
              });
        request.catch((e) => live && setError(errorMessage(e))).finally(() => live && setLoading(false));
      },
      tab === "issues" && searchQuery ? 200 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, tab, projectPath, provider, searchQuery, needsLinear, issueKey]);

  const rows = useMemo<Row[]>(() => {
    if (tab === "prs")
      return prs.items.map((pr) => ({
        id: String(pr.number),
        title: `#${pr.number} ${pr.title}`,
        note: `${pr.author} · ${pr.state.toLowerCase()}`,
        pick: () => onPr(pr),
      }));
    if (tab === "issues")
      return needsLinear || issueResult?.key !== issueKey
        ? []
        : issueResult.items.map((issue) => ({ id: issue.id, title: `${issue.identifier} ${issue.title}`, note: issue.state, pick: () => onIssue(issue) }));
    const q = query.trim().toLowerCase();
    const workspaces = store.workspaces[projectPath] ?? [];
    const taken = new Set(workspaces.flatMap((ws) => (ws.branch ? [ws.branch] : [])));
    const seen = new Set<string>();
    const result: Row[] =
      !q || "new branch".includes(q) ? [{ id: "new", title: "New branch", note: `from ${defaultBranch}`, pick: () => onBranch({ kind: "new" }) }] : [];
    for (const ws of workspaces) {
      if (!ws.branch || !`${ws.branch} ${ws.name}`.toLowerCase().includes(q)) continue;
      const session = (store.sessions ?? [])
        .filter((s) => s.projectPath === projectPath && s.cwd === ws.path && !s.archived && !s.worktreeRemoved)
        .sort((a, b) => b.modified.localeCompare(a.modified))[0];
      result.push({
        id: ws.path,
        title: ws.branch,
        note: session ? "In use · Open session" : "In use · Use checkout",
        pick: () => (session ? onSession(session.id) : onBranch({ kind: "open", cwd: ws.path })),
      });
    }
    for (const branch of [...branches].sort((a, b) => Number(a.remote) - Number(b.remote))) {
      const local = branch.remote ? branch.name.split("/").slice(1).join("/") : branch.name;
      if (!local || taken.has(local) || seen.has(local)) continue;
      seen.add(local);
      if (branch.name.toLowerCase().includes(q))
        result.push({
          id: branch.name,
          title: branch.name,
          note: branch.remote ? "Remote · New worktree" : "New worktree",
          pick: () => onBranch({ kind: "existing", branch: branch.name }),
        });
    }
    return result.slice(0, 100);
  }, [
    tab,
    prs.items,
    needsLinear,
    issueResult,
    issueKey,
    query,
    store.workspaces,
    store.sessions,
    projectPath,
    branches,
    defaultBranch,
    onBranch,
    onIssue,
    onPr,
    onSession,
  ]);
  const active = Math.min(highlight, Math.max(0, rows.length - 1));
  const choose = (row: Row) => {
    row.pick();
    onOpenChange(false);
  };
  const waiting = tab === "prs" ? prs.loading : loading;
  const failure = tab === "prs" ? prs.error : error;
  return (
    <Popover.Root modal open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Start from"
          className="flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-veil-raised"
        >
          <span>Start from</span>
          <span className="max-w-40 truncate text-foreground">{label}</span>
          <ChevronDown className="size-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
          className="z-(--z-menu) w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl bg-popover glass p-2 text-popover-foreground shadow-surface hairline"
        >
          <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)}>
            <Tabs.List aria-label="Start from source" className="mb-2 flex gap-1">
              {(
                [
                  ["branches", "Branches"],
                  ["issues", "Issues"],
                  ["prs", "Pull requests"],
                ] as const
              ).map(([value, title]) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground data-[state=active]:bg-veil-raised data-[state=active]:text-foreground"
                >
                  {title}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <Tabs.Content value={tab}>
              <div className="flex items-center gap-2 rounded-md bg-well px-2 py-1.5">
                <Search className="size-3.5 text-faint" />
                <input
                  ref={input}
                  role="combobox"
                  aria-label="Search branches, issues or pull requests"
                  aria-autocomplete="list"
                  aria-expanded
                  aria-controls={`${id}-list`}
                  aria-activedescendant={rows.length ? `${id}-${active}` : undefined}
                  value={query}
                  placeholder={tab === "prs" ? "Search by number, title or author…" : `Search ${tab}…`}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      setHighlight(rows.length ? (active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : 0);
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (rows[active]) choose(rows[active]);
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                />
              </div>
              {tab === "issues" && (
                <label className="my-2 flex items-center gap-2 px-1 text-xs">
                  Issue tracker
                  <select
                    aria-label="Issue tracker"
                    value={provider}
                    onChange={(e) => {
                      const next = e.target.value as "github" | "linear";
                      setProvider(next);
                      setPrefs({ issueProvider: next });
                    }}
                    className="rounded bg-well p-1"
                  >
                    <option value="github">GitHub</option>
                    <option value="linear">Linear</option>
                  </select>
                </label>
              )}
              {tab === "issues" && needsLinear ? (
                <ConnectLinear onConnected={() => setLinearConnected(true)} />
              ) : (
                <>
                  <div
                    ref={list}
                    id={`${id}-list`}
                    role="listbox"
                    aria-label={tab === "prs" ? "Pull requests" : tab === "issues" ? "Issues" : "Branches"}
                    className="mt-1 max-h-72 overflow-y-auto scrollbar-thin"
                  >
                    {rows.map((row, index) => (
                      <button
                        key={row.id}
                        id={`${id}-${index}`}
                        type="button"
                        role="option"
                        aria-label={[row.title, row.note].filter(Boolean).join(" ")}
                        aria-selected={index === active}
                        onMouseMove={() => setHighlight(index)}
                        onClick={() => choose(row)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs focus-visible:outline-ring",
                          index === active && "bg-veil-raised",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{row.title}</span>
                        {row.note && <span className="max-w-44 truncate text-faint">{row.note}</span>}
                      </button>
                    ))}
                  </div>
                  {waiting && (
                    <p role="status" className="p-2 text-xs text-faint">
                      Loading…
                    </p>
                  )}
                  {!waiting && !failure && !rows.length && (
                    <p role="status" className="p-2 text-xs text-faint">
                      No matches.
                    </p>
                  )}
                  {failure && (
                    <p role="alert" className="p-2 text-xs text-destructive">
                      {failure}
                    </p>
                  )}
                </>
              )}
            </Tabs.Content>
          </Tabs.Root>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
