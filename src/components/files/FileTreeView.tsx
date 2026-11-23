import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow, AtSign, ChevronDown, ChevronRight, Copy, ExternalLink, Eye, FileDiff, FilePlus, FileSearch, Folder, FolderOpen, FolderSearch, FolderTree,
  ListFilter, Search, Undo2, X,
} from "@/icons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { fs } from "@/lib/api";
import { useWorkingChanges } from "@/lib/changes";
import { getDraft, setDraft } from "@/lib/drafts";
import { openDiff, openFile, useEditors } from "@/lib/editors";
import { showError } from "@/lib/errorToasts";
import { localGitSource } from "@/lib/gitSource";
import { runShortcut } from "@/lib/hotkeys";
import { DiscardDialog, workingDiscardTarget, type DiscardTarget } from "@/components/changes/DiscardDialog";
import { fileErrorText, localFileSource, StaleRequestError, type FileSource, type SourceEntry } from "@/lib/workspaceFiles";
import { cn } from "@/lib/cn";
import { isContextMenuKey, openContextMenu } from "@/lib/contextMenu";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/menu";
import type { ChangeStatus } from "@/types/session";
import { FileTypeIcon } from "./FileTypeIcon";
import { copyText } from "@/lib/clipboard";
import { openProjectSearch } from "@/lib/projectSearch";
import { isMac, keycaps, useKeymap, bindingText } from "@/lib/shortcuts";
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

/** The most files the filter reads; past it the count says it is incomplete. */
export const FILTER_LIMIT = 60_000;

/**
 * The tree a name filter leaves: every file and folder whose name holds
 * `query`, and the folders above them, from the workspace's whole file list.
 * `matched` counts the entries (files and folders) whose names match;
 * `total` is the number of files in the worktree, as the count reads
 * "0 of 412", never the rows the tree happens to list.
 */
export function filterRows(paths: string[], query: string): { rows: Row[]; matched: number; total: number } {
  const q = query.toLocaleLowerCase();
  const kids = new Map<string, Map<string, boolean>>();
  const files = new Set<string>();
  const add = (parent: string, path: string, isDir: boolean) => {
    let m = kids.get(parent);
    if (!m) kids.set(parent, (m = new Map()));
    if (isDir || !m.has(path)) m.set(path, isDir);
  };
  for (const path of paths) {
    if (!path) continue;
    files.add(path);
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) add(parts.slice(0, i).join("/"), parts.slice(0, i + 1).join("/"), i < parts.length - 1);
  }
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const hit = (p: string) => nameOf(p).toLocaleLowerCase().includes(q);
  let matched = 0;
  const show = new Set<string>();
  const mark = (rel: string): boolean => {
    let any = false;
    for (const [path, isDir] of kids.get(rel) ?? []) {
      const inner = isDir ? mark(path) : false;
      if (hit(path)) {
        // Files only, as the total is: a folder whose name matches is shown but not counted.
        if (!isDir) matched++;
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
  const rows: Row[] = [];
  const walk = (rel: string, depth: number) => {
    const list = [...(kids.get(rel) ?? [])].filter(([p]) => show.has(p));
    list.sort((a, b) => Number(b[1]) - Number(a[1]) || nameOf(a[0]).localeCompare(nameOf(b[0])));
    for (const [path, isDir] of list) {
      const open = isDir && [...(kids.get(path) ?? [])].some(([p]) => show.has(p));
      rows.push({ path, name: nameOf(path), isDir, depth, open });
      if (open) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return { rows, matched, total: files.size };
}

interface FileTreeViewProps {
  sessionId: string;
  root: string;
  rootName: string;
  /** The checkout's branch, shown in mono beside its name in the header; nothing when unknown. */
  branch?: string | null;
  active: boolean;
  isGit?: boolean;
  /** Tab whose draft "Attach in chat" appends to. */
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
 * The checkout as a tree. Directories list lazily on first open; the header
 * carries the checkout's name and branch, the filter toggle, New file and
 * Open file by name. Files that differ from HEAD are tinted with
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
  branch,
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
  // The filter field shows only while the header's filter button is on.
  const [filterOpen, setFilterOpen] = useState(false);
  const [creating, setCreating] = useState<{ parent: string; name: string; error: string | null; busy: boolean } | null>(null);
  const [discarding, setDiscarding] = useState<DiscardTarget | null>(null);
  // The whole list for the filter, by the tree's own rules; `truncated` when the cap cut it.
  const [allFiles, setAllFiles] = useState<{ paths: string[]; truncated: boolean } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const query = filter.trim();
  const canFilter = !!reader.listFiles;
  const filtering = canFilter && filterOpen && query !== "";
  const keymap = useKeymap();
  const searchKeys = keymap["files.search"][0];
  const quickOpenKeys = keymap["files.quickOpen"][0];
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
    if (!wanted || !reader.listFiles) return;
    let cancelled = false;
    setListError(null);
    reader
      .listFiles(FILTER_LIMIT)
      .then((list) => {
        if (!cancelled) setAllFiles(list);
      })
      .catch((e) => {
        if (!cancelled) setListError(source ? fileErrorText(e) : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, reader, refreshTick, source]);

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
  // View diff and Discard changes read and write Git on this computer: a cloud workspace's are left to its Changes panel.
  const git = useMemo(() => (source || !isGit ? undefined : localGitSource(root)), [source, isGit, root]);
  const { fileStatus, dirsWithChanges, oldPaths } = useMemo(() => {
    const fileStatus = new Map<string, ChangeStatus>();
    const oldPaths = new Map<string, string>();
    const dirsWithChanges = new Set<string>();
    for (const f of changes.files as { path: string; status: ChangeStatus; oldPath?: string }[]) {
      fileStatus.set(f.path, f.status);
      if (f.oldPath) oldPaths.set(f.path, f.oldPath);
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) dirsWithChanges.add(parts.slice(0, i).join("/"));
    }
    return { fileStatus, dirsWithChanges, oldPaths };
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
  const filtered = useMemo(() => (filtering && allFiles ? filterRows(allFiles.paths, query) : null), [filtering, allFiles, query]);
  const plainRows = useMemo(() => {
    const out: Row[] = [];
    const walk = (rel: string, depth: number) => {
      const list = children[rel];
      if (!list) return;
      for (const e of list) {
        out.push({ path: e.path, name: e.name, isDir: e.isDir, depth, escapes: e.escapes });
        if (e.isDir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [children, expanded]);
  // While the list loads, or when it could not, the plain tree's folders would not answer to the
  // filter: show nothing in their place (the state says why).
  const rows = filtered ? filtered.rows : filtering ? [] : plainRows;
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

  const abs = (rel: string) => (rel ? `${root}/${rel}` : root);
  const copy = (text: string) => void copyText(text).catch(() => {});

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const at = rows.findIndex((r) => r.path === focus);
    const i = Math.max(0, at);
    const row = rows[i];
    if (!row) return;
    if (isContextMenuKey(e)) {
      const target = container.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.path)}"]`);
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(target);
      }
      return;
    }
    // ⌥⌘C (Ctrl+Alt+C elsewhere) copies the focused row's path, as the menu says; scoped to the tree.
    if ((isMac ? e.metaKey : e.ctrlKey) && e.altKey && !e.shiftKey && e.code === "KeyC") {
      if (source) return;
      e.preventDefault();
      e.stopPropagation();
      copy(abs(row.path));
      return;
    }
    const go = (j: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (target) setFocus(target.path);
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        go(at < 0 ? 0 : i + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        go(at < 0 ? 0 : i - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (row.isDir && !expanded.has(row.path)) toggle(row.path);
        else go(i + 1);
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (row.isDir && expanded.has(row.path)) toggle(row.path);
        else if (row.path.includes("/")) setFocus(row.path.slice(0, row.path.lastIndexOf("/")));
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        activate(row);
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
    if (!focus) return;
    const el = container.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(focus)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  const mention = (rel: string) => {
    if (!mentionTabId) return;
    const cur = getDraft(mentionTabId);
    setDraft(mentionTabId, `${cur}${cur && !cur.endsWith(" ") ? " " : ""}@${rel} `);
  };
  const viewDiff = async (rel: string) => {
    if (!git) return;
    try {
      const range = await git.reviewRange(null, true);
      openDiff(sessionId, root, rel, { scope: "all", range: { base: range.base, head: range.head }, oldPath: oldPaths.get(rel), target: null, uncommitted: true });
    } catch (error) {
      showError("Couldn’t open the diff", error);
    }
  };
  const openInDefaultApp = (rel: string) => void fs.openPath(abs(rel)).catch((error) => showError(`Couldn’t open ${rel || rootName}`, error));

  const clearFilter = () => {
    setFilter("");
    filterInput.current?.focus();
  };
  const toggleFilter = () => {
    if (filterOpen) {
      setFilter("");
      setFilterOpen(false);
      container.current?.focus();
    } else setFilterOpen(true);
  };
  useEffect(() => {
    if (filterOpen) filterInput.current?.focus();
  }, [filterOpen]);

  // New file: in the focused folder, or beside the focused file.
  const canCreate = !reader.readOnly;
  const startCreate = () => {
    const row = rows.find((r) => r.path === focus);
    const parent = !row ? "" : row.isDir ? row.path : row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "";
    setCreating({ parent, name: "", error: null, busy: false });
  };
  const create = async () => {
    if (!creating || creating.busy) return;
    const name = creating.name.trim();
    const parts = name.split("/");
    if (!name || name.startsWith("/") || parts.some((part) => part === "" || part === "." || part === "..")) {
      setCreating({ ...creating, error: "Type a file name inside this folder." });
      return;
    }
    const rel = creating.parent ? `${creating.parent}/${name}` : name;
    setCreating({ ...creating, busy: true, error: null });
    try {
      if (await reader.stat(rel)) {
        setCreating({ ...creating, busy: false, error: `${name} already exists.` });
        return;
      }
      await reader.writeText(rel, "", null);
    } catch (error) {
      setCreating({ ...creating, busy: false, error: source ? fileErrorText(error) : String(error) });
      return;
    }
    setCreating(null);
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const chain = dir ? dir.split("/").map((_, n, all) => all.slice(0, n + 1).join("/")) : [];
    setExpanded((x) => new Set([...x, ...chain]));
    for (const rel of ["", ...chain]) void load(rel);
    setFocus(rel);
    setTick((t) => t + 1);
    openFile(sessionId, root, rel, undefined, root, source?.key);
  };

  const headerButton = "grid h-6 min-w-6 shrink-0 place-items-center rounded-md px-1 text-faint outline-none hover:bg-veil-raised hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3" data-testid="file-tree-header">
        <FolderTree aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-[55%] shrink-0 truncate text-[12.5px] text-foreground" title={source ? rootName : root} data-testid="file-tree-name">
          {rootName}
        </span>
        {branch && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint" title={branch} data-testid="file-tree-branch">
            {branch}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {canFilter && (
            <button
              type="button"
              aria-label="Filter"
              aria-pressed={filterOpen}
              title="Filter files by name"
              onClick={toggleFilter}
              className={cn(headerButton, filterOpen && "bg-veil-strong text-primary hover:text-primary")}
              data-testid="file-tree-filter-toggle"
            >
              <ListFilter className="size-3.5" />
            </button>
          )}
          {canCreate && (
            <button type="button" aria-label="New file" title="New file" onClick={startCreate} className={headerButton}>
              <FilePlus className="size-3.5" />
            </button>
          )}
          {!source && (
            <button
              type="button"
              aria-label="Open file by name"
              title={quickOpenKeys ? `Open file by name (${bindingText(quickOpenKeys)})` : "Open file by name"}
              onClick={() => runShortcut("files.quickOpen")}
              className={cn(headerButton, "font-sans text-[11.5px]")}
              data-testid="file-tree-quick-open"
            >
              {quickOpenKeys ? <span aria-hidden>{bindingText(quickOpenKeys)}</span> : <FileSearch className="size-3.5" />}
            </button>
          )}
        </div>
      </div>
      {canFilter && filterOpen && (
        <div className="shrink-0 border-b border-hairline px-3 py-2" data-testid="file-tree-filter">
          <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-hairline bg-well px-2.5 text-[12.5px] focus-within:border-primary/60">
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
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (filter) setFilter("");
                  else toggleFilter();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  container.current?.focus();
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:font-sans placeholder:text-faint"
            />
            {filtering && filtered && (
              <span
                className="shrink-0 whitespace-nowrap text-[11.5px] tabular-nums text-faint"
                data-testid="file-tree-filter-count"
                title={
                  allFiles?.truncated
                    ? `Only the first ${FILTER_LIMIT.toLocaleString()} files are filtered`
                    : `${filtered.matched} matching ${filtered.matched === 1 ? "name" : "names"} among ${filtered.total.toLocaleString()} files in the worktree`
                }
              >
                {filtered.matched} of {filtered.total.toLocaleString()}{allFiles?.truncated ? "+" : ""}
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
      {creating && (
        <div className="shrink-0 border-b border-hairline px-3 py-2" data-testid="file-tree-new-file">
          <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-hairline bg-well px-2.5 text-[12.5px] focus-within:border-primary/60">
            <FilePlus className="size-3.5 shrink-0 text-faint" />
            {creating.parent && <span className="max-w-[40%] shrink-0 truncate font-mono text-faint">{creating.parent}/</span>}
            <input
              autoFocus
              type="text"
              spellCheck={false}
              autoComplete="off"
              aria-label="New file name"
              placeholder="New file name"
              value={creating.name}
              disabled={creating.busy}
              onChange={(e) => setCreating({ ...creating, name: e.target.value, error: null })}
              onBlur={() => !creating.busy && !creating.name.trim() && setCreating(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setCreating(null);
                  container.current?.focus();
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:font-sans placeholder:text-faint"
            />
          </div>
          {creating.error && (
            <div role="alert" className="mt-1 text-[11.5px] text-destructive">
              {creating.error}
            </div>
          )}
        </div>
      )}
      <div
        ref={container}
        role="tree"
        aria-label={`Files in ${rootName}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="animate-panel-content min-h-0 flex-1 overflow-auto p-1.5 outline-none scrollbar-thin focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40"
      >
        {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
        {filtering && listError && (
          <div role="alert" className="px-3 py-2 text-xs text-destructive" data-testid="file-tree-filter-error">
            Couldn’t list the files to filter: {listError}
          </div>
        )}
        {filtering && !listError && !allFiles && <div className="px-3 py-2 text-xs text-faint">Listing files…</div>}
        {filtering && allFiles?.truncated && !noMatch && (
          <div className="px-3 py-1 text-[11px] text-faint" data-testid="file-tree-filter-truncated">
            Only the first {FILTER_LIMIT.toLocaleString()} files are filtered.
          </div>
        )}
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
        {!noMatch &&
          rows.map((row) => {
            const open = row.isDir && (filtered ? !!row.open : expanded.has(row.path));
            const status = row.isDir ? undefined : fileStatus.get(row.path);
            const dirty = row.isDir && dirsWithChanges.has(row.path);
            const isActive = !row.isDir && activeRel === row.path;
            const isFocused = focus === row.path;
            const FolderGlyph = open ? FolderOpen : Folder;
            return (
              <ContextMenu key={row.path}>
                <ContextMenuTrigger asChild>
                  <div
                    role="treeitem"
                    aria-expanded={row.isDir ? open : undefined}
                    aria-selected={isActive}
                    data-path={row.path}
                    onClick={() => activate(row)}
                    onContextMenu={() => setFocus(row.path)}
                    style={{ paddingLeft: row.depth * 14 + 10 }}
                    className={cn(
                      "flex h-[26px] w-full min-w-0 cursor-default items-center gap-1.5 rounded-md pr-3 font-mono text-[12.5px]",
                      isActive ? "bg-veil-strong text-foreground" : "text-foreground/85 hover:bg-veil-raised hover:text-foreground",
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
                    {row.isDir ? (
                      <FolderGlyph aria-hidden data-folder-icon="" className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileTypeIcon name={row.name} isDir={false} size={14} className="shrink-0" />
                    )}
                    <span
                      className={cn("min-w-0 flex-1 truncate", status && TINT[status], row.escapes && "italic text-faint")}
                      title={row.escapes ? "A link outside the workspace. It is not followed." : undefined}
                    >
                      {row.name}
                    </span>
                    {row.escapes && <span className="shrink-0 font-sans text-[10px] text-faint">link outside</span>}
                    {status && <span className={cn("shrink-0 text-[11px] tabular-nums", TINT[status])}>{BADGE[status]}</span>}
                    {dirty && <span aria-label="Contains changes" className="size-1.5 shrink-0 rounded-full bg-warning/80" />}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-60" data-testid="file-tree-menu">
                  {row.isDir ? (
                    !filtering && (
                      <ContextMenuItem onSelect={() => toggle(row.path)}>
                        <FolderGlyph /> {open ? "Collapse" : "Expand"}
                      </ContextMenuItem>
                    )
                  ) : (
                    <ContextMenuItem disabled={!!row.escapes} onSelect={() => activate(row)}>
                      <Eye /> View
                      <Keys text="↵" />
                    </ContextMenuItem>
                  )}
                  {!row.isDir && git && (
                    <ContextMenuItem disabled={!status || !!row.escapes} onSelect={() => void viewDiff(row.path)}>
                      <FileDiff /> View diff
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem className="items-start" disabled={!mentionTabId} onSelect={() => mention(row.path)}>
                    <AtSign className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="block">Attach in chat</span>
                      <span className="block truncate text-[11.5px] text-faint" title={`@${row.path}`}>
                        Adds @{row.path}
                      </span>
                    </span>
                  </ContextMenuItem>
                  {!source && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        <ExternalLink /> Open in
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        <ContextMenuItem onSelect={() => openInDefaultApp(row.path)}>
                          <AppWindow /> Default app
                        </ContextMenuItem>
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  )}
                  {!source && (
                    <ContextMenuItem onSelect={() => copy(abs(row.path))}>
                      <Copy /> Copy path
                      <Keys text={bindingText("mod+alt+c")} />
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem onSelect={() => copy(row.path)}>
                    <Copy /> Copy relative path
                  </ContextMenuItem>
                  {!source && (
                    <ContextMenuItem onSelect={() => void revealItemInDir(abs(row.path)).catch(() => {})}>
                      <FolderSearch /> Reveal in Finder
                    </ContextMenuItem>
                  )}
                  {!row.isDir && git?.discard && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem destructive disabled={!status || !!row.escapes} onSelect={() => setDiscarding(workingDiscardTarget(row.path, localChanges.staged, localChanges.unstaged) ?? { path: row.path, oldPath: oldPaths.get(row.path), status })}>
                        <Undo2 /> Discard changes
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        {!filtering && children[""] !== undefined && !children[""]?.length && <div className="px-3 py-2 text-xs text-faint">Empty.</div>}
      </div>
      {git && (
        <DiscardDialog
          source={git}
          file={discarding}
          onClose={() => setDiscarding(null)}
          onDiscarded={() => {
            for (const rel of expanded) void load(rel);
            setTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

/** A menu item's keys at its end; kept out of the item's accessible name. */
function Keys({ text }: { text: string }) {
  return (
    <span aria-hidden className="ml-auto pl-4 font-sans text-[11px] text-faint">
      {text}
    </span>
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
