import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { FileHit } from "@/lib/api";
import { openFile } from "@/lib/editors";
import { useShortcut } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";
import { dirName } from "@/lib/paths";
import { localFileSource, type FileSource } from "@/lib/workspaceFiles";

/**
 * ⌘P: fuzzy file search over the session's checkout (or `source`, a cloud
 * workspace's files); Enter opens a tab.
 */
export function QuickOpen({ sessionId, root, source }: { sessionId: string; root: string; source?: FileSource }) {
  const reader = useMemo(() => source ?? localFileSource(root), [source, root]);
  const cloudKey = reader.kind === "cloud" ? reader.key : undefined;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<FileHit[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useShortcut("files.quickOpen", () => setOpen(true));

  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = window.setTimeout(async () => {
      const r = reader.findFiles ? await reader.findFiles(q, 40).catch(() => []) : [];
      if (live) {
        setHits(r);
        setSel(0);
      }
    }, 40);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [open, q, reader]);

  useEffect(() => {
    if (open) {
      setQ("");
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const choose = (h: FileHit | undefined) => {
    if (!h) return;
    openFile(sessionId, root, h.path, undefined, root, cloudKey);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showClose={false} width="max-w-[38rem]" className="p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle className="sr-only">Open file</DialogTitle>
        <div className="flex items-center gap-2 border-b border-hairline px-3">
          <Search className="size-4 text-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(hits.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(hits[sel]);
              }
            }}
            placeholder="Open file by name"
            spellCheck={false}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-faint"
          />
        </div>
        <ul className="max-h-[22rem] overflow-auto p-1 scrollbar-thin">
          {hits.map((h, i) => (
            <li key={h.path}>
              <button
                type="button"
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(h)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  i === sel ? "bg-veil-strong text-foreground" : "text-muted-foreground",
                )}
              >
                <FileText className="size-3.5 shrink-0 text-faint" />
                <span className="truncate text-foreground">{h.name}</span>
                <span className="ml-1 truncate text-xs text-faint">{dirName(h.path)}</span>
              </button>
            </li>
          ))}
          {!hits.length && <li className="px-3 py-6 text-center text-xs text-faint">{reader.findFiles ? "No files match." : "Finding files by name is not available in this workspace."}</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
