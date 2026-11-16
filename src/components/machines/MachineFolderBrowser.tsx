import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CornerLeftUp, Folder, FolderGit2, Loader2, RefreshCw, Server } from "@/icons";
import type { MachineFolder, MachineFolderListing, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { folderLabel } from "@/lib/machineProjects";

export interface MachineFolders {
  listing: MachineFolderListing | null;
  loading: boolean;
  error: string | null;
  /** List `path` (the machine user's home when absent). */
  go: (path?: string) => void;
  refresh: () => void;
}

/** The folders of one folder on a machine (`machine.browse`), read while the dialog is open, never kept. */
export function useMachineFolders(client: WorkspaceRpcClient | null, startAt?: string, onListed?: (path: string) => void): MachineFolders {
  const [listing, setListing] = useState<MachineFolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef<{ path: string | undefined; generation: number }>({ path: undefined, generation: 0 });
  const read = useCallback(
    (path?: string) => {
      if (!client) return;
      const generation = ++asked.current.generation;
      asked.current.path = path;
      setLoading(true);
      setError(null);
      client.browseMachineFolders(path).then(
        (next) => {
          if (generation !== asked.current.generation) return;
          setListing(next);
          setLoading(false);
        },
        (e: unknown) => {
          if (generation !== asked.current.generation) return;
          setError(errorMessage(e));
          setLoading(false);
        },
      );
    },
    [client],
  );
  // Opened where the other tab was browsing; read once per client, not on every move.
  const start = useRef(startAt);
  useEffect(() => {
    read(start.current);
    return () => {
      asked.current.generation++;
    };
  }, [read]);
  const listed = useRef(onListed);
  listed.current = onListed;
  useEffect(() => {
    if (listing) listed.current?.(listing.path);
  }, [listing]);
  const refresh = useCallback(() => read(listing?.path ?? asked.current.path), [read, listing?.path]);
  return { listing, loading, error, go: read, refresh };
}

/**
 * The path bar and folder list of the Add a project dialog (21.11): the
 * folder being listed with Up and Refresh, then its folders. A click
 * chooses a folder; a double click or Enter opens it. In `project` mode a
 * folder that already is a project is dimmed and cannot be chosen; in
 * `destination` mode (a clone's parent) every folder can be.
 */
export function MachineFolderBrowser({
  folders,
  selected,
  onSelect,
  mode,
  machineName,
  disabled = false,
}: {
  folders: MachineFolders;
  selected: string | null;
  onSelect: (folder: MachineFolder | null) => void;
  mode: "project" | "destination";
  machineName: string;
  disabled?: boolean;
}) {
  const { listing, loading, error, go, refresh } = folders;
  const list = useRef<HTMLDivElement | null>(null);
  const open = (path: string) => {
    if (disabled) return;
    onSelect(null);
    go(path);
  };
  const choosable = (folder: MachineFolder) => mode === "destination" || !folder.projectId;
  const onRowKey = (event: KeyboardEvent<HTMLButtonElement>, folder: MachineFolder, index: number) => {
    if (event.key === "Enter") {
      event.preventDefault();
      open(folder.path);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = list.current?.querySelectorAll<HTMLButtonElement>("[data-folder-row]");
      rows?.[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (event.key === "Backspace" && listing?.parent) {
      event.preventDefault();
      open(listing.parent);
    }
  };

  let body;
  if (error) {
    body = (
      <p role="alert" className="px-3 py-3 text-[12.5px] text-destructive">
        Could not list this folder: {error}
      </p>
    );
  } else if (!listing) {
    body = (
      <p className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Reading the folders on {machineName}…
      </p>
    );
  } else if (!listing.entries.length) {
    body = <p className="px-3 py-3 text-[12.5px] text-muted-foreground">No folders here.</p>;
  } else {
    body = (
      <div ref={list} role="listbox" aria-label={`Folders in ${listing.path}`} className={cn("divide-y divide-hairline", loading && "opacity-60")}>
        {listing.entries.map((folder, index) => {
          const can = choosable(folder);
          const isSelected = selected === folder.path;
          const Glyph = folder.git ? FolderGit2 : Folder;
          return (
            <button
              key={folder.path}
              type="button"
              role="option"
              data-folder-row
              data-testid="machine-folder"
              data-path={folder.path}
              aria-selected={isSelected}
              aria-disabled={!can || undefined}
              disabled={disabled}
              title={can ? folder.path : `${folder.name} is already a project on ${machineName}`}
              onClick={() => can && onSelect(folder)}
              onDoubleClick={() => open(folder.path)}
              onKeyDown={(event) => onRowKey(event, folder, index)}
              className={cn(
                "flex h-9 w-full min-w-0 items-center gap-2.5 px-3 text-left outline-none focus-visible:bg-selected/60",
                isSelected ? "bg-selected" : "hover:bg-selected/40",
                !can && "text-faint",
              )}
            >
              <Glyph className={cn("size-4 shrink-0", can ? "text-muted-foreground" : "text-faint")} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{folder.name}</span>
              <span className={cn("shrink-0 text-[12px]", can ? "text-faint" : "text-faint/80")} data-testid="machine-folder-label">
                {folderLabel(folder)}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-hairline bg-well pl-3 pr-1" data-testid="machine-folder-path">
        <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={listing?.path}>
          {listing?.path ?? " "}
        </span>
        <Button variant="ghost" size="icon-xs" className="text-faint" aria-label="Up to the folder above" disabled={disabled || !listing?.parent} onClick={() => listing?.parent && open(listing.parent)}>
          <CornerLeftUp />
        </Button>
        <Button variant="ghost" size="icon-xs" className="text-faint" aria-label="Refresh" disabled={disabled || loading} onClick={refresh}>
          <RefreshCw className={cn(loading && listing && "animate-spin")} />
        </Button>
      </div>
      <div className="max-h-[216px] min-h-9 overflow-y-auto rounded-lg border border-hairline scrollbar-thin" data-testid="machine-folders">
        {body}
      </div>
      {listing?.truncated && <p className="text-[12px] text-faint">Only the first 500 folders are listed.</p>}
    </div>
  );
}
