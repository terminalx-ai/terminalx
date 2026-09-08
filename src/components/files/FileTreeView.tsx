import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { fs, type DirEntry } from "@/lib/api";
import { useWorkingChanges } from "@/lib/changes";
import { getDraft, setDraft } from "@/lib/drafts";
import { openFile, useEditors } from "@/lib/editors";
import { cn } from "@/lib/cn";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";
import type { ChangeStatus } from "@/types/session";
import { FileTypeIcon } from "./FileTypeIcon";

interface Row {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
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
  return <RootedFileTreeView key={props.root} {...props} />;
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
}: FileTreeViewProps) {
  const [children, setChildren] = useState<Record<string, DirEntry[] | undefined>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string>("");
  const [tick, setTick] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const editors = useEditors();
  const activeRel = editors.editors.find((e) => e.id === editors.active[sessionId])?.rel;

  const load = useCallback(
    async (rel: string) => {
      try {
        const list = await fs.listDir(root, rel);
        setChildren((c) => ({ ...c, [rel]: list }));
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [root],
  );

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

  // Git status: cheap enough to poll gently while the tree is on screen, and
  // re-read the moment an agent's status changes, which is when files move.
  useEffect(() => {
    if (!active || !isGit) return;
    setTick((t) => t + 1);
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, [active, statusKey, isGit]);
  const changes = useWorkingChanges(root, active && isGit, tick);
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
    [children, load],
  );

  // The visible rows, flattened, so keyboard movement is index arithmetic.
  const rows = useMemo(() => {
    const out: Row[] = [{ path: "", name: rootName, isDir: true, depth: 0 }];
    const walk = (rel: string, depth: number) => {
      const list = children[rel];
      if (!list) return;
      for (const e of list) {
        out.push({ path: e.path, name: e.name, isDir: e.isDir, depth });
        if (e.isDir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    if (expanded.has("")) walk("", 1);
    return out;
  }, [children, expanded, rootName]);

  const activate = useCallback(
    (row: Row) => {
      setFocus(row.path);
      if (row.isDir) toggle(row.path);
      else openFile(sessionId, root, row.path);
    },
    [sessionId, root, toggle],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = Math.max(0, rows.findIndex((r) => r.path === focus));
    const row = rows[i];
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
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
  const mention = (rel: string) => {
    if (!mentionTabId) return;
    const cur = getDraft(mentionTabId);
    setDraft(mentionTabId, `${cur}${cur && !cur.endsWith(" ") ? " " : ""}@${rel} `);
  };

  return (
    <div
      ref={container}
      role="tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="h-full overflow-auto py-1 outline-none scrollbar-thin focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40"
    >
      {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
      {rows.map((row) => {
        const open = row.isDir && expanded.has(row.path);
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
                <span className={cn("min-w-0 flex-1 truncate", row.path === "" && "font-medium text-foreground", status && TINT[status])}>{row.name}</span>
                {status && <span className={cn("shrink-0 text-[10px] font-medium tabular-nums", TINT[status])}>{BADGE[status]}</span>}
                {dirty && <span aria-label="Contains changes" className="size-1.5 shrink-0 rounded-full bg-warning/80" />}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {!row.isDir && <ContextMenuItem onSelect={() => openFile(sessionId, root, row.path)}>Open</ContextMenuItem>}
              {row.isDir && row.path !== "" && <ContextMenuItem onSelect={() => toggle(row.path)}>{open ? "Collapse" : "Expand"}</ContextMenuItem>}
              <ContextMenuItem onSelect={() => void revealItemInDir(abs(row.path)).catch(() => {})}>Reveal in Finder</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => copy(abs(row.path))}>Copy path</ContextMenuItem>
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
      {children[""] !== undefined && !children[""]?.length && <div className="px-3 py-2 text-xs text-faint">Empty.</div>}
    </div>
  );
}
