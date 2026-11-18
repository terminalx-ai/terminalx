import { useState } from "react";
import { List, ListFilter, ListTree } from "@/icons";
import { Checkbox, Segmented } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { useViewedChanges } from "@/lib/viewedChanges";
import type { ChangedFile } from "@/types/session";
import { FileList } from "./FileList";
import type { MergeGroup } from "./MergeInProgress";

/** Shared review controls for workspace, turn, commit and uncommitted files. */
export function ReviewFileList({ workspace, base, files, groups, selected, onSelect, empty, trailing, loading = false }: {
  workspace: string;
  /** The diff base, so each row can count the review comments made against it. */
  base?: string;
  files: ChangedFile[];
  groups?: MergeGroup[] | null;
  selected: string | null;
  onSelect: (path: string) => void;
  empty: string;
  /** Row actions such as Discard: shown when the row is hovered or focused. */
  trailing?: (file: ChangedFile) => React.ReactNode;
  /** A refresh is reading the list again. */
  loading?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [view, setView] = useState<"flat" | "folders">("flat");
  const viewed = useViewedChanges(workspace);
  const query = filter.trim().toLocaleLowerCase();
  const matches = (file: ChangedFile) => !query || file.path.toLocaleLowerCase().includes(query) || !!file.oldPath?.toLocaleLowerCase().includes(query);
  const visible = files.filter(matches);
  const count = files.filter((file) => viewed.status(file).viewed).length;
  // An empty list is only its empty state: no filter, view toggle or "0 of 0 viewed" over nothing.
  if (!files.length) return <FileList files={[]} selected={null} onSelect={onSelect} empty={empty} />;
  const list = (items: ChangedFile[]) => <FileList base={base} files={items} folders={view === "folders"} expandAll={!!query}
    selected={selected} onSelect={onSelect} empty={query ? "No files match this filter." : empty}
    leading={(file) => {
      const status = viewed.status(file);
      // Once anything is marked the boxes stay, so progress reads down the list; before that they come with the pointer.
      return <Checkbox label={`Viewed ${file.path}`} checked={status.viewed} disabled={!file.blobHash} onChange={(on) => viewed.set(file, on)}
        title={!file.blobHash ? "Viewed marks require file identities from the workspace. Update its runtime and reconnect." : "Viewed"}
        className={cn(count === 0 && !status.changed && "opacity-0 focus-within:opacity-100 group-hover:opacity-100")} />;
    }}
    trailing={(file) => {
      const status = viewed.status(file);
      const actions = trailing?.(file);
      if (!status.changed && !actions) return null;
      return <div className="flex shrink-0 items-center gap-1 pr-1">
        {status.changed && <span title="Changed since viewed" className="whitespace-nowrap text-[10px] text-warning" aria-label={`Changed since viewed: ${file.path}`}>Changed since viewed</span>}
        {actions && <div className="hidden items-center group-focus-within:flex group-hover:flex">{actions}</div>}
      </div>;
    }} />;
  return <>
    <div className="sticky top-0 z-10 bg-background text-xs">
      <div className="flex h-9 items-center gap-2 border-b border-hairline px-3 text-muted-foreground">
        <span className="shrink-0 tabular-nums">{count} of {files.length} viewed{query && ` · ${visible.length} matching`}</span>
        <div role="progressbar" aria-label="Files viewed" aria-valuemin={0} aria-valuemax={files.length} aria-valuenow={count} className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-veil-raised">
          <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${files.length ? (count / files.length) * 100 : 0}%` }} />
        </div>
        {loading && <span aria-hidden className="text-faint">…</span>}
        <Segmented value={view} onChange={setView} aria-label="File list view" className="h-6"
          options={[{ value: "flat", "aria-label": "Flat", title: "Flat list", label: <List aria-hidden className="size-3.5" /> }, { value: "folders", "aria-label": "Folders", title: "Folders", label: <ListTree aria-hidden className="size-3.5" /> }]} />
        <button type="button" aria-label="Filter files" aria-pressed={filtering || !!query} title="Filter files" onClick={() => { if (filtering) setFilter(""); setFiltering(!filtering); }}
          className={cn("grid size-6 shrink-0 place-items-center rounded-md text-faint outline-none hover:bg-veil-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40", (filtering || query) && "bg-selected text-foreground")}>
          <ListFilter aria-hidden className="size-3.5" />
        </button>
      </div>
      {(filtering || query) && <div className="border-b border-hairline px-3 py-1.5">
        <input type="search" autoFocus aria-label="Filter changed files" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") { setFilter(""); setFiltering(false); } }}
          className="h-7 w-full rounded-md bg-well px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
      </div>}
    </div>
    {groups?.length && visible.length ? groups.map((group) => {
      const matching = group.files.filter(matches);
      return matching.length > 0 && <section key={group.key} aria-label={group.title}>
        <h3 className="px-3 pt-2 text-[11px] font-medium text-faint">{group.title} · {matching.length}</h3>{list(matching)}
      </section>;
    }) : list(visible)}
  </>;
}
