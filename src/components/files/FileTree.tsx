import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { fs, type DirEntry } from "@/lib/api";
import { openFile, useEditors } from "@/lib/editors";
import { cn } from "@/lib/cn";

/**
 * The checkout as a lazy tree: a directory is listed when first opened and
 * re-listed on refresh. Clicking a file opens (or focuses) its editor tab.
 */
export function FileTree({ sessionId, root, active }: { sessionId: string; root: string; active: boolean }) {
  const [children, setChildren] = useState<Record<string, DirEntry[] | undefined>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    if (active && children[""] === undefined) void load("");
  }, [active, children, load]);

  const toggle = (rel: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(rel)) n.delete(rel);
      else {
        n.add(rel);
        if (children[rel] === undefined) void load(rel);
      }
      return n;
    });
  };

  const render = (rel: string, depth: number): React.ReactNode => {
    const list = children[rel];
    if (!list) return depth ? <div className="py-0.5 pl-[calc(var(--d)*12px+22px)] text-xs text-faint" style={{ "--d": depth } as React.CSSProperties}>…</div> : null;
    if (!list.length) return depth ? null : <div className="px-3 py-2 text-xs text-faint">Empty.</div>;
    return list.map((e) => {
      const open = expanded.has(e.path);
      return (
        <div key={e.path}>
          <button
            type="button"
            onClick={() => (e.isDir ? toggle(e.path) : openFile(sessionId, root, e.path))}
            style={{ paddingLeft: depth * 12 + 6 }}
            className={cn(
              "flex h-[22px] w-full items-center gap-1 pr-2 text-left text-xs",
              activeRel === e.path ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
            )}
          >
            {e.isDir ? (
              open ? (
                <ChevronDown className="size-3 shrink-0 text-faint" />
              ) : (
                <ChevronRight className="size-3 shrink-0 text-faint" />
              )
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {e.isDir ? (
              open ? (
                <FolderOpen className="size-3.5 shrink-0 text-accent-mention" />
              ) : (
                <Folder className="size-3.5 shrink-0 text-accent-mention" />
              )
            ) : (
              <File className="size-3.5 shrink-0 text-faint" />
            )}
            <span className="truncate">{e.name}</span>
          </button>
          {e.isDir && open && render(e.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="h-full overflow-auto py-1 scrollbar-thin">
      {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
      {render("", 0)}
    </div>
  );
}
