import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, FileText, Loader2, Regex, Search } from "lucide-react";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { EditorSplit } from "@/components/editor/EditorSplit";
import { SearchToggle } from "@/components/editor/SearchControls";
import { FileTreeView } from "@/components/files/FileTreeView";
import { openFile, useEditors } from "@/lib/editors";
import type { TextHit, TextSearch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { cloudFileSource, fileErrorText, registerFileSource, StaleRequestError, type FileSource } from "@/lib/workspaceFiles";

/** The display root of a cloud workspace's files; never a path on this computer. */
export function cloudRoot(workspaceKey: string): string {
  return `cloud://${workspaceKey}`;
}

/**
 * A cloud workspace's files (PRO-24): the same tree and editor as a local
 * checkout, reading and writing through the runtime's `fs/1`. Editors stay
 * open (and unsaved text is kept) across reconnects and while the page is
 * closed; requests still on their way when the workspace closes are
 * cancelled or dropped.
 */
export function CloudFilesView({
  workspaceKey,
  name,
  client,
  state,
  active,
}: {
  workspaceKey: string;
  name: string;
  client: WorkspaceRpcClient;
  state: WorkspaceConnectionState;
  active: boolean;
}) {
  const connected = state.state === "connected";
  // Read-only until the runtime says this attachment may manage it.
  const authority = useRef<"manage" | "participate">("participate");
  if (connected) authority.current = state.authority;
  const readOnly = authority.current !== "manage";
  const source = useMemo(() => cloudFileSource(workspaceKey, client, readOnly), [workspaceKey, client, readOnly]);
  useEffect(() => {
    const unregister = registerFileSource(source);
    return () => {
      unregister();
      source.dispose();
    };
  }, [source]);
  const [panel, setPanel] = useState<"files" | "search">("files");
  const root = cloudRoot(workspaceKey);
  const editors = useEditors();
  const open = editors.editors.some((entry) => entry.sessionId === workspaceKey);

  return (
    <div className="flex min-h-0 flex-1" data-testid="cloud-files">
      <aside className="flex w-64 shrink-0 flex-col border-r border-hairline">
        <div className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1" role="tablist" aria-label="Files panel">
          <Button size="xs" role="tab" aria-selected={panel === "files"} variant={panel === "files" ? "secondary" : "ghost"} onClick={() => setPanel("files")}>
            <FileText className="size-3.5" /> Files
          </Button>
          <Button size="xs" role="tab" aria-selected={panel === "search"} variant={panel === "search" ? "secondary" : "ghost"} onClick={() => setPanel("search")}>
            <Search className="size-3.5" /> Search
          </Button>
          {readOnly && connected && <span className="ml-auto text-[11px] text-faint">read-only</span>}
        </div>
        <div className={cn("min-h-0 flex-1", panel !== "files" && "hidden")}>
          <FileTreeView sessionId={workspaceKey} root={root} rootName={name} active={active && panel === "files"} source={source} />
        </div>
        <div className={cn("flex min-h-0 flex-1 flex-col", panel !== "search" && "hidden")}>
          <CloudSearch source={source} sessionId={workspaceKey} root={root} active={active && panel === "search"} />
        </div>
      </aside>
      <div className="@container/editor-host relative flex min-h-0 min-w-0 flex-1">
        {!open && (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            {connected ? "Open a file from the tree." : "Files appear once the workspace is connected."}
          </div>
        )}
        <EditorSplit sessionId={workspaceKey} active={active} fill />
      </div>
    </div>
  );
}

/**
 * Search a cloud workspace's files. A new query cancels the one before it on
 * the runtime, and only the latest query's answer is ever shown.
 */
export function CloudSearch({ source, sessionId, root, active }: { source: FileSource; sessionId: string; root: string; active: boolean }) {
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<TextSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!active || !query.trim() || !source.search) {
      setResult(null);
      setError(null);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      source
        .search!({ query, regex, caseSensitive }, controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return;
          setResult(found);
          setError(null);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted || e instanceof StaleRequestError || (e instanceof Error && e.name === "AbortError")) return;
          setError(fileErrorText(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, query, regex, caseSensitive, source]);

  const groups = useMemo(() => {
    const byFile = new Map<string, TextHit[]>();
    for (const hit of result?.hits ?? []) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit]);
    return [...byFile.entries()];
  }, [result]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cloud-search">
      <div className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1">
        <input
          aria-label="Search the workspace"
          className="min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-2 py-1 text-xs"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SearchToggle label="Match case" pressed={caseSensitive} onClick={() => setCaseSensitive((on) => !on)}>
          <CaseSensitive />
        </SearchToggle>
        <SearchToggle label="Regular expression" pressed={regex} onClick={() => setRegex((on) => !on)}>
          <Regex />
        </SearchToggle>
      </div>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] text-faint" role="status">
        {busy && <Loader2 className="size-3 animate-spin" />}
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : result ? (
          <span>
            {result.hits.length}
            {result.capped ? "+" : ""} results in {result.files} files{result.capped ? " (narrow the search to see all)" : ""}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        {groups.map(([path, hits]) => (
          <div key={path} className="py-0.5">
            <div className="truncate px-2 text-xs font-medium text-foreground" title={path}>
              {path}
            </div>
            {hits.map((hit) => (
              <button
                key={`${hit.line}:${hit.col}`}
                type="button"
                className="flex w-full min-w-0 gap-2 px-3 py-0.5 text-left text-xs text-muted-foreground hover:bg-veil-raised hover:text-foreground"
                onClick={() => openFile(sessionId, root, hit.path, { line: hit.line, col: hit.col }, root, source.key)}
              >
                <span className="shrink-0 tabular-nums text-faint">{hit.line}</span>
                <span className="truncate font-mono">{hit.text}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
