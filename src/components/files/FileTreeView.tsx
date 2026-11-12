import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ListFilter, Search, X } from "@/icons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useWorkingChanges } from "@/lib/changes";
import { getDraft, setDraft } from "@/lib/drafts";
import { openFile, useEditors } from "@/lib/editors";
import { fileErrorText, localFileSource, StaleRequestError, type FileSource, type SourceEntry } from "@/lib/workspaceFiles";
import { cn } from "@/lib/cn";
import { isContextMenuKey, openContextMenu } from "@/lib/contextMenu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";
import type { ChangeStatus } from "@/types/session";
import { FileTypeIcon } from "./FileTypeIcon";
import { copyText } from "@/lib/clipboard";
import { showError } from "@/lib/errorToasts";
import { openProjectSearch } from "@/lib/projectSearch";
import { keycaps, useKeymap } from "@/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { KbdGroup } from "@/components/ui/tooltip";

interface Row {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  /** A symlink out of the workspace: listed, never opened. */
  escapes?: boolean;
  /** Filtering only: the folder shows the matches inside it. */
  open?: boolean;
}

/**
 * The tree a name filter leaves: every file and folder whose name holds
 * `query`, and the folders above them, from the workspace's whole file list.
 * Counts are entries (files and folders) that match, and all of them.
 */
export function filterRows(paths: string[], query: string, rootName: string): { rows: Row[]; matched: number; total: number } {
  const q = query.toLocaleLowerCase();
  const kids = new Map<string, Map<string, boolean>>();
  const add = (parent: string, path: string, isDir: boolean) => {
    let m = kids.get(parent);
    if (!m) kids.set(parent, (m = new Map()));
    if (isDir || !m.has(path)) m.set(path, isDir);
  };
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) add(parts.slice(0, i).join("/"), parts.slice(0, i + 1).join("/"), i < parts.length - 1);
  }
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const hit = (p: string) => nameOf(p).toLocaleLowerCase().includes(q);
  let matched = 0;
  let total = 0;
  const show = new Set<string>();
  const mark = (rel: string): boolean => {
    let any = false;
    for (const [path, isDir] of kids.get(rel) ?? []) {
      total++;
      const inner = isDir ? mark(path) : false;
      if (hit(path)) {
        matched++;
        any = true;
        show.add(path);
      } else if (inner) {
        any = true;
        show.add(path);
      }
    }
    return any;
  };
  mark("");
  const rows: Row[] = [{ path: "", name: rootName, isDir: true, depth: 0, open: true }];
  const walk = (rel: string, depth: number) => {
    const list = [...(kids.get(rel) ?? [])].filter(([p]) => show.has(p));
    list.sort((a, b) => Number(b[1]) - Number(a[1]) || nameOf(a[0]).localeCompare(nameOf(b[0])));
    for (const [path, isDir] of list) {
      const open = isDir && [...(kids.get(path) ?? [])].some(([p]) => show.has(p));
      rows.push({ path, name: nameOf(path), isDir, depth, open });
      if (open) walk(path, depth + 1);
    }
  };
  walk("", 1);
  return { rows, matched, total };
}

interface FileTreeViewProps {
  sessionId: string;
  root: string;
  rootName: string;
  active: boolean;
  isGit?: boolean;
  /** Tab whose draft "Mention in composer" appends to. */
  mentionTabId?: string | null;
  /** Any string that changes when an agent's status does; bumps the git refresh. */
  statusKey?: string;
  refreshTick?: number;
  /** Where the tree reads: the local checkout at `root` when absent, or a cloud workspace's files (PRO-24). */
  source?: FileSource;
}

const BADGE: Record<ChangeStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const TINT: Record<ChangeStatus, string> = {
  added: "text-add",
  modified: "text-warning",
  deleted: "text-destructive",
  renamed: "text-warning",
};

/**
 * The checkout as a tree. Directories list lazily on first open; the root
 * row carries the project name. Files that differ from HEAD are tinted with
 * a letter badge, and every directory above one carries a dot, so a change
 * deep in a collapsed folder is still findable. Arrow keys walk the visible
 * rows the way an editor's explorer does, and a right click offers the
 * usual file actions.
 */
export function FileTreeView(props: FileTreeViewProps) {
  return <RootedFileTreeView key={`${props.source?.key ?? "local"}:${props.root}`} {...props} />;
}

function RootedFileTreeView({
  sessionId,
  root,
  rootName,
  active,
  isGit = true,
  mentionTabId,
  statusKey = "",
  refreshTick = 0,
  source: given,
}: FileTreeViewProps) {
  const reader = useMemo(() => given ?? localFileSource(root), [given, root]);
  // A cloud workspace: watched rather than polled, and never offered local-only actions.
  const source = reader.kind === "cloud" ? reader : undefined;
  const [children, setChildren] = useState<Record<string, SourceEntry[] | undefined>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string>("");
  const [tick, setTick] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const query = filter.trim();
  const canFilter = !!reader.findFiles;
  const filtering = canFilter && query !== "";
  const searchKeys = useKeymap()["files.search"][0];
  const editors = useEditors();
  const activeRel = editors.editors.find((e) => e.id === editors.active[sessionId])?.rel;

  const load = useCallback(
    async (rel: string) => {
      try {
        const list: SourceEntry[] = await reader.listDir(rel);
        setChildren((c) => ({ ...c, [rel]: list }));
        setError(null);
      } catch (e) {
        if (e instanceof StaleRequestError) return;
        if (source) {
          // A directory that went away (deleted by an agent) just closes.
          if (rel && typeof e === "object" && e && "code" in e && e.code === "not_found") {
            setChildren((c) => ({ ...c, [rel]: undefined }));
            setExpanded((x) => {
              const n = new Set(x);
              n.delete(rel);
              return n;
            });
            return;
          }
          setError(fileErrorText(e));
        } else setError(String(e));
      }
    },
    [reader, source],
  );

  // The whole file list, read once a filter is typed and again after a refresh.
  const wanted = filtering && active;
  useEffect(() => {
    if (!wanted || !reader.findFiles) return;
    let cancelled = false;
    reader
      .findFiles("", 200000)
      .then((hits) => !cancelled && setAllFiles(hits.map((h) => h.path)))
      .catch((e) => {
        if (!cancelled) showError("Filter files by name", e);
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, reader, refreshTick]);

  // First listing on show; a refresh re-lists every directory still open.
  useEffect(() => {
    if (!active) return;
    if (children[""] === undefined) void load("");
  }, [active, load]);
  useEffect(() => {
    if (refreshTick === 0) return;
    for (const rel of expanded) void load(rel);
    setTick((t) => t + 1);
  }, [refreshTick]);

  // A cloud workspace says what changed: re-list the open directories that
  // hold a changed path (all of them after a reconnect) and re-read Git
  // status, a beat later so a burst of writes is one refresh.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // Changes made while the tree was hidden were not heard: catch up on showing it again.
  const shownBefore = useRef(false);
  useEffect(() => {
    if (!active || !source) return;
    if (shownBefore.current) {
      for (const rel of expandedRef.current) void load(rel);
      setTick((t) => t + 1);
    }
    shownBefore.current = true;
  }, [active, source, load]);
  useEffect(() => {
    if (!active || !source?.watch) return;
    let timer: number | undefined;
    const pending = new Set<string>();
    let everything = false;
    const stop = source.watch((paths) => {
      if (paths === null) everything = true;
      else for (const path of paths) pending.add(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        for (const rel of expandedRef.current) if (everything || pending.has(rel)) void load(rel);
        pending.clear();
        everything = false;
        setTick((t) => t + 1);
      }, 300);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [active, source, load]);

  // Git status: cheap enough to poll gently while the tree is on screen, and
  // re-read the moment an agent's status changes, which is when files move.
  // A cloud workspace's is re-read on its change notifications instead.
  useEffect(() => {
    if (!active || !isGit || source) return;
    setTick((t) => t + 1);
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, [active, statusKey, isGit]);
  const localChanges = useWorkingChanges(root, active && isGit && !source, tick);
  const cloudChanges = useSourceChanges(source, active && isGit, tick);
  const changes = source ? cloudChanges : localChanges;
  const { fileStatus, dirsWithChanges } = useMemo(() => {
    const fileStatus = new Map<string, ChangeStatus>();
    const dirsWithChanges = new Set<string>();
    for (const f of changes.files) {
      fileStatus.set(f.path, f.status);
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) dirsWithChanges.add(parts.slice(0, i).join("/"));
    }
    return { fileStatus, dirsWithChanges };
  }, [changes.files]);

  const toggle = useCallback(
    (rel: string) => {
      if (filtering) return;
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(rel)) n.delete(rel);
        else {
          n.add(rel);
          if (children[rel] === undefined) void load(rel);
        }
        return n;
      });
    },
    [children, load, filtering],
  );

  // The visible rows, flattened, so keyboard movement is index arithmetic.
  const filtered = useMemo(() => (filtering && allFiles ? filterRows(allFiles, query, rootName) : null), [filtering, allFiles, query, rootName]);
  const plainRows = useMemo(() => {
    const out: Row[] = [{ path: "", name: rootName, isDir: true, depth: 0 }];
    const walk = (rel: string, depth: number) => {
      const list = children[rel];
      if (!list) return;
      for (const e of list) {
        out.push({ path: e.path, name: e.name, isDir: e.isDir, depth, escapes: e.escapes });
        if (e.isDir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    if (expanded.has("")) walk("", 1);
    return out;
  }, [children, expanded, rootName]);
  const rows = filtered ? filtered.rows : plainRows;
  const noMatch = !!filtered && filtered.matched === 0;

  const activate = useCallback(
    (row: Row) => {
      setFocus(row.path);
      if (row.escapes) return;
      if (row.isDir) toggle(row.path);
      else openFile(sessionId, root, row.path, undefined, root, source?.key);
    },
    [sessionId, root, toggle, source],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const i = Math.max(0, rows.findIndex((r) => r.path === focus));
    const row = rows[i];
    if (isContextMenuKey(e)) {
      const target = container.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.path)}"]`);
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(target);
      }
      return;
    }
    const go = (j: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (target) setFocus(target.path);
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        go(i + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        go(i - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (row?.isDir && !expanded.has(row.path)) toggle(row.path);
        else go(i + 1);
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (row?.isDir && expanded.has(row.path) && row.path !== "") toggle(row.path);
        else if (row && row.path !== "") {
          const parent = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "";
          setFocus(parent);
        }
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        if (row) activate(row);
        break;
      case "Home":
        e.preventDefault();
        go(0);
        break;
      case "End":
        e.preventDefault();
        go(rows.length - 1);
        break;
    }
  };

  // Keep the focused row in view as the arrows move it.
  useEffect(() => {
    const el = container.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(focus)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  const abs = (rel: string) => (rel ? `${root}/${rel}` : root);
  const copy = (text: string) => void copyText(text).catch(() => {});
  const mention = (rel: string) => {
    if (!mentionTabId) return;
    const cur = getDraft(mentionTabId);
    setDraft(mentionTabId, `${cur}${cur && !cur.endsWith(" ") ? " " : ""}@${rel} `);
  };

  const clearFilter = () => {
    setFilter("");
    filterInput.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {canFilter && (
        <div className="shrink-0 border-b border-hairline px-2 py-1.5" data-testid="file-tree-filter">
          <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-well px-2 text-xs focus-within:ring-1 focus-within:ring-ring/50">
            <ListFilter className="size-3.5 shrink-0 text-faint" />
            <input
              ref={filterInput}
              type="text"
              spellCheck={false}
              autoComplete="off"
              aria-label="Filter files by name"
              placeholder="Filter files by name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && filter) {
                  e.preventDefault();
                  e.stopPropagation();
                  setFilter("");
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  container.current?.focus();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint"
            />
            {filtering && filtered && (
              <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-faint" data-testid="file-tree-filter-count">
                {filtered.matched} of {filtered.total}
              </span>
            )}
            {filter && (
              <button type="button" aria-label="Clear filter" onClick={clearFilter} className="shrink-0 rounded text-faint hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
    <div
      ref={container}
      role="tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="animate-panel-content min-h-0 flex-1 overflow-auto py-1 outline-none scrollbar-thin focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40"
    >
      {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
      {noMatch && (
        <div className="px-6 pt-10 text-center" data-testid="file-tree-no-match">
          <div className="mx-auto grid size-9 place-items-center rounded-lg bg-veil-strong text-muted-foreground">
            <Search className="size-4" />
          </div>
          <div className="mt-3 break-words text-sm font-medium text-foreground">No files match “{query}”</div>
          <div className="mt-1 text-xs text-muted-foreground">The filter matches file and folder names. To look inside files, search in files.</div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={clearFilter}>
              <X /> Clear filter
            </Button>
            <Button size="sm" variant="outline" onClick={() => openProjectSearch(query)}>
              <Search /> Search in files
              {searchKeys && <KbdGroup keys={keycaps(searchKeys)} />}
            </Button>
          </div>
        </div>
      )}
      {!noMatch && rows.map((row) => {
        const open = row.isDir && (filtered ? !!row.open : expanded.has(row.path));
        const status = row.isDir ? undefined : fileStatus.get(row.path);
        const dirty = row.isDir && row.path !== "" && dirsWithChanges.has(row.path);
        const isActive = !row.isDir && activeRel === row.path;
        const isFocused = focus === row.path;
        return (
          <ContextMenu key={row.path || "root"}>
            <ContextMenuTrigger asChild>
              <div
                role="treeitem"
                aria-expanded={row.isDir ? open : undefined}
                aria-selected={isActive}
                data-path={row.path}
                onClick={() => activate(row)}
                onContextMenu={() => setFocus(row.path)}
                style={{ paddingLeft: row.depth * 12 + 6 }}
                className={cn(
                  "flex h-[22px] w-full min-w-0 cursor-default items-center gap-1 pr-2 text-xs",
                  isActive ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
                  isFocused && !isActive && "bg-veil-raised",
                )}
              >
                {row.isDir ? (
                  open ? (
                    <ChevronDown className="size-3 shrink-0 text-faint" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0 text-faint" />
                  )
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <FileTypeIcon name={row.name} isDir={row.isDir} isOpen={open} isRoot={row.path === ""} size={16} className="shrink-0" />
                <span
                  className={cn("min-w-0 flex-1 truncate", row.path === "" && "font-medium text-foreground", status && TINT[status], row.escapes && "italic text-faint")}
                  title={row.escapes ? "A link outside the workspace. It is not followed." : undefined}
                >
                  {row.name}
                </span>
                {row.escapes && <span className="shrink-0 text-[10px] text-faint">link outside</span>}
                {status && <span className={cn("shrink-0 text-[10px] font-medium tabular-nums", TINT[status])}>{BADGE[status]}</span>}
                {dirty && <span aria-label="Contains changes" className="size-1.5 shrink-0 rounded-full bg-warning/80" />}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {!row.isDir && !row.escapes && <ContextMenuItem onSelect={() => activate(row)}>Open</ContextMenuItem>}
              {row.isDir && row.path !== "" && !filtering && <ContextMenuItem onSelect={() => toggle(row.path)}>{open ? "Collapse" : "Expand"}</ContextMenuItem>}
              {!source && <ContextMenuItem onSelect={() => void revealItemInDir(abs(row.path)).catch(() => {})}>Reveal in Finder</ContextMenuItem>}
              <ContextMenuSeparator />
              {!source && <ContextMenuItem onSelect={() => copy(abs(row.path))}>Copy path</ContextMenuItem>}
              <ContextMenuItem disabled={row.path === ""} onSelect={() => copy(row.path)}>
                Copy relative path
              </ContextMenuItem>
              <ContextMenuItem disabled={!mentionTabId || row.path === ""} onSelect={() => mention(row.path)}>
                Mention in composer
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {!filtering && children[""] !== undefined && !children[""]?.length && <div className="px-3 py-2 text-xs text-faint">Empty.</div>}
    </div>
    </div>
  );
}

/** A cloud workspace's Git status as the tree badges it. */
function useSourceChanges(source: FileSource | undefined, active: boolean, tick: number) {
  const [files, setFiles] = useState<{ path: string; status: ChangeStatus }[]>([]);
  useEffect(() => {
    if (!source?.changes || !active) return;
    let cancelled = false;
    source
      .changes()
      .then((next) => !cancelled && setFiles(next))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, active, tick]);
  return { files };
}
