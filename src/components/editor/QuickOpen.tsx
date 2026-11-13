import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, FileX2, Search, TextSearch } from "@/icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/tooltip";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import type { FileCount, FileHit } from "@/lib/api";
import type { ChangeRange } from "@/lib/changes";
import { copyText } from "@/lib/clipboard";
import { openDiff, openFile } from "@/lib/editors";
import { showError } from "@/lib/errorToasts";
import { localGitSource } from "@/lib/gitSource";
import { useShortcut, useShortcutKeys } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";
import { dirName, fileName } from "@/lib/paths";
import { openProjectSearch } from "@/lib/projectSearch";
import { forgetRecentFiles, recentFiles } from "@/lib/recentFiles";
import { isMac, keycaps } from "@/lib/shortcuts";
import { localFileSource, type FileSource } from "@/lib/workspaceFiles";
import type { ChangedFile } from "@/types/session";

/** Matches asked for per search. */
const LIMIT = 40;
/** Recently opened files shown above All files before anything is typed. */
const RECENT_SHOWN = 8;

/** The branch's changes against its base, as All changes shows them: what each row's marks say. */
interface BranchChanges {
  range: ChangeRange;
  byPath: Map<string, ChangedFile>;
}

const MARK: Record<ChangedFile["status"], { letter: string; tone: string; word: string }> = {
  added: { letter: "A", tone: "text-add", word: "Added" },
  modified: { letter: "M", tone: "text-warning", word: "Modified" },
  deleted: { letter: "D", tone: "text-destructive", word: "Deleted" },
  renamed: { letter: "R", tone: "text-info", word: "Renamed" },
};

type Row = { kind: "heading"; label: string } | { kind: "file"; hit: FileHit; index: number };

/** A shortcut as one keycap, as the design shows it: ⌘⏎, ⌥⌘C; Ctrl+Enter off the Mac. */
const cap = (keys: string[]) => keys.join(isMac ? "" : "+");

const fileWord = (n: number) => `${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;

/**
 * ⌘P: fuzzy file search over the session's checkout (or `source`, a cloud
 * workspace's files); Enter opens a tab. Before anything is typed it lists
 * the checkout's recently opened files, then the rest (PRO-298). Rows of
 * files the branch changed carry their line counts and status, ⌘Enter opens
 * such a file's diff, and ⌥⌘C copies the selected file's path. A search
 * with no match offers search in files and a rerun over ignored files.
 */
export function QuickOpen({ sessionId, root, source, branch }: { sessionId: string; root: string; source?: FileSource; branch?: string | null }) {
  const reader = useMemo(() => source ?? localFileSource(root), [source, root]);
  const cloudKey = reader.kind === "cloud" ? reader.key : undefined;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [includeIgnored, setIncludeIgnored] = useState(false);
  /** The last answer, with the query and mode it answers: a stale one is never read as "no match". */
  const [result, setResult] = useState<{ q: string; includeIgnored: boolean; hits: FileHit[] } | null>(null);
  const [recent, setRecent] = useState<FileHit[]>([]);
  const [changes, setChanges] = useState<BranchChanges | null>(null);
  const [count, setCount] = useState<FileCount | null>(null);
  const [sel, setSel] = useState(0);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const searchKeys = useShortcutKeys("files.search");

  useShortcut("files.quickOpen", () => setOpen(true));

  // What opening shows before anything is typed: the recent files still there, and the branch's changes.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setIncludeIgnored(false);
    setResult(null);
    setCopied(false);
    requestAnimationFrame(() => input.current?.focus());
    let live = true;
    const paths = recentFiles(reader.key);
    // A file that cannot be checked is treated as gone: it is not offered, and the list forgets it.
    void Promise.all(paths.map((p) => Promise.resolve().then(() => reader.stat(p)).then((s) => !!s, () => false))).then((there) => {
      if (!live) return;
      forgetRecentFiles(reader.key, paths.filter((_, i) => !there[i]));
      setRecent(paths.filter((_, i) => there[i]).slice(0, RECENT_SHOWN).map((path) => ({ path, name: fileName(path), score: 0 })));
    });
    if (reader.kind === "local") {
      const git = localGitSource(root);
      void git
        .reviewRange(null, false)
        .then(async (review) => {
          const range = { base: review.base, head: review.head };
          const files = await git.changesBetween(range.base, range.head);
          if (live) setChanges({ range, byPath: new Map(files.map((f) => [f.path, f])) });
        })
        // Not a Git checkout, or no base to compare with: rows simply carry no marks.
        .catch(() => live && setChanges(null));
    }
    return () => {
      live = false;
    };
  }, [open, reader, root]);

  useEffect(() => {
    if (!open || !reader.countFiles) return;
    let live = true;
    const countFiles = reader.countFiles.bind(reader);
    Promise.resolve()
      .then(() => countFiles({ includeIgnored }))
      .then((c) => live && setCount(c), () => live && setCount(null));
    return () => {
      live = false;
    };
  }, [open, reader, includeIgnored]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = window.setTimeout(async () => {
      const find = reader.findFiles?.bind(reader);
      const hits = find ? await Promise.resolve().then(() => (includeIgnored ? find(q, LIMIT, { includeIgnored }) : find(q, LIMIT))).catch(() => []) : [];
      if (live) {
        setResult({ q, includeIgnored, hits });
        setSel(0);
      }
    }, 40);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [open, q, reader, includeIgnored]);

  const typed = q.trim() !== "";
  const current = result && result.q === q && result.includeIgnored === includeIgnored ? result : null;
  const hits = current?.hits ?? [];
  const { rows, files } = useMemo(() => {
    const rows: Row[] = [];
    const files: FileHit[] = [];
    const push = (hit: FileHit) => rows.push({ kind: "file", hit, index: files.push(hit) - 1 });
    if (typed) {
      hits.forEach(push);
    } else {
      const shown = new Set(recent.map((r) => r.path));
      const rest = hits.filter((h) => !shown.has(h.path));
      if (recent.length) {
        rows.push({ kind: "heading", label: "Recent" });
        recent.forEach(push);
        if (rest.length) rows.push({ kind: "heading", label: "All files" });
      }
      rest.forEach(push);
    }
    return { rows, files };
  }, [typed, hits, recent]);
  const noMatch = typed && !!current && !hits.length && !!reader.findFiles;
  const selected = files[Math.min(sel, files.length - 1)];

  const choose = (h: FileHit | undefined) => {
    if (!h) return;
    openFile(sessionId, root, h.path, undefined, root, cloudKey);
    setOpen(false);
  };

  const chooseDiff = (h: FileHit | undefined) => {
    const change = h && changes?.byPath.get(h.path);
    if (!h || !change || !changes) return;
    try {
      openDiff(sessionId, root, h.path, { scope: "all", range: changes.range, oldPath: change.oldPath, target: null, uncommitted: false });
      setOpen(false);
    } catch (error) {
      showError("Couldn’t open the diff", error);
    }
  };

  const copyPath = (h: FileHit | undefined) => {
    if (!h) return;
    // A local path is copied whole, as the file tree's Copy path does; a cloud one is the workspace's.
    const path = reader.kind === "local" ? `${root.replace(/\/$/, "")}/${h.path}` : h.path;
    copyText(path).then(
      () => setCopied(true),
      (error: unknown) => showError("Couldn’t copy the path", error),
    );
  };

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const searchInside = useCallback(() => {
    if (!openProjectSearch(q.trim())) return false;
    setOpen(false);
  }, [q]);
  // With nothing matching, the search in files shortcut carries the query across.
  useShortcut("files.search", searchInside, { enabled: open && noMatch, priority: 1 });

  const mod = (e: React.KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showClose={false} width="max-w-[38.5rem]" className="bottom-auto top-[12%] gap-0 overflow-hidden p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle className="sr-only">Open file</DialogTitle>
        <div className="flex h-12 items-center gap-2.5 border-b border-hairline px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={input}
            value={q}
            aria-label="Search files"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(files.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (mod(e)) chooseDiff(selected);
                else choose(selected);
              } else if (e.code === "KeyC" && e.altKey && mod(e) && !e.shiftKey) {
                e.preventDefault();
                copyPath(selected);
              }
            }}
            placeholder="Search files…"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
          <Kbd className="shrink-0 text-muted-foreground">{keycaps("escape")[0]}</Kbd>
        </div>
        {noMatch ? (
          <NoMatch
            query={q.trim()}
            branch={branch}
            includeIgnored={includeIgnored}
            canIncludeIgnored={!!reader.findsIgnored}
            searchKeys={searchKeys}
            onSearchInside={searchInside}
            onToggleIgnored={() => setIncludeIgnored((v) => !v)}
          />
        ) : (
          <ul className="max-h-[26rem] overflow-auto p-1.5 scrollbar-thin" role="listbox" aria-label="Files">
            {rows.map((row) =>
              row.kind === "heading" ? (
                <li key={`h:${row.label}`} role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[.08em] text-faint">
                  {row.label}
                </li>
              ) : (
                <FileRow
                  key={row.hit.path}
                  hit={row.hit}
                  change={changes?.byPath.get(row.hit.path)}
                  selected={row.index === sel}
                  onHover={() => setSel(row.index)}
                  onOpen={() => choose(row.hit)}
                />
              ),
            )}
            {!rows.length && current && (
              <li className="px-3 py-6 text-center text-xs text-faint">{reader.findFiles ? "No files in this worktree." : "Finding files by name is not available in this workspace."}</li>
            )}
          </ul>
        )}
        <div className="flex h-9 items-center gap-4 border-t border-hairline px-4 text-[11.5px] text-faint">
          {noMatch ? (
            <span className="flex items-center gap-1.5">
              <Kbd>{keycaps("backspace")[0]}</Kbd>edit the query
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <Kbd>{keycaps("enter")[0]}</Kbd>open
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>{cap(keycaps("mod+enter"))}</Kbd>
                open diff
              </span>
              <span className="flex items-center gap-1.5" aria-live="polite">
                <Kbd>{cap(keycaps("mod+alt+c"))}</Kbd>
                {copied ? "copied" : "copy path"}
              </span>
            </>
          )}
          <span className="ml-auto truncate">
            {[!typed && !noMatch && recent.length ? "Recent files first" : null, includeIgnored ? "Gitignored files included" : null, count ? `${count.truncated ? "Over " : ""}${fileWord(count.files)} in this worktree` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FileRow({ hit, change, selected, onHover, onOpen }: { hit: FileHit; change?: ChangedFile; selected: boolean; onHover: () => void; onOpen: () => void }) {
  const mark = change ? MARK[change.status] : null;
  const dir = dirName(hit.path) || ".";
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        tabIndex={-1}
        onMouseEnter={onHover}
        onClick={onOpen}
        className={cn("flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left", selected ? "bg-veil-strong" : "hover:bg-veil")}
      >
        <FileTypeIcon name={hit.name} isDir={false} size={14} className="shrink-0" />
        <span className="truncate text-[12.5px] text-foreground">{hit.name}</span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-faint">{dir}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {change && (change.additions > 0 || change.deletions > 0) && (
            <span className="font-mono text-[11.5px] tabular-nums" aria-label={`${change.additions} added, ${change.deletions} removed`}>
              {change.additions > 0 && <span className="text-add">+{change.additions}</span>}
              {change.additions > 0 && change.deletions > 0 && " "}
              {change.deletions > 0 && <span className="text-destructive">−{change.deletions}</span>}
            </span>
          )}
          <span className={cn("w-3 text-center font-mono text-[11px]", mark?.tone)} title={mark?.word} aria-label={mark?.word}>
            {mark?.letter}
          </span>
          {selected && (
            <span className="ml-1 flex items-center gap-1 text-[11px] text-faint">
              <Kbd>{keycaps("enter")[0]}</Kbd>
              <span>open</span>
              {change && (
                <>
                  <Kbd className="ml-1">{cap(keycaps("mod+enter"))}</Kbd>
                  <span>diff</span>
                </>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function NoMatch({
  query,
  branch,
  includeIgnored,
  canIncludeIgnored,
  searchKeys,
  onSearchInside,
  onToggleIgnored,
}: {
  query: string;
  branch?: string | null;
  includeIgnored: boolean;
  canIncludeIgnored: boolean;
  searchKeys: string[];
  onSearchInside: () => void;
  onToggleIgnored: () => void;
}) {
  const where = branch ? `in ${branch}` : "in this worktree";
  const action = "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2.5 text-[12px] text-muted-foreground hover:bg-veil hover:text-foreground";
  return (
    <div className="p-1.5">
      <div className="py-9 text-center" role="status">
        <div className="mx-auto grid size-10 place-items-center rounded-lg bg-veil-strong">
          <FileX2 className="size-[18px] text-muted-foreground" />
        </div>
        <div className="mt-3 text-sm font-medium text-foreground">No files match “{query}”</div>
        <div className="mt-1 px-6 text-[12.5px] text-muted-foreground">
          File names and paths {where} were searched. {includeIgnored ? "Gitignored files were searched too." : "Gitignored files are skipped."}
        </div>
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" className={action} onClick={onSearchInside}>
            <TextSearch className="size-[13px]" />
            Search inside files
            {searchKeys.length > 0 && <Kbd className="ml-1">{cap(searchKeys)}</Kbd>}
          </button>
          {canIncludeIgnored && (
            <button type="button" className={action} aria-pressed={includeIgnored} onClick={onToggleIgnored}>
              {includeIgnored ? <EyeOff className="size-[13px]" /> : <Eye className="size-[13px]" />}
              {includeIgnored ? "Skip gitignored files" : "Include gitignored files"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
