import { useState } from "react";
import { Segmented } from "@/components/ui/controls";
import { useViewedChanges } from "@/lib/viewedChanges";
import type { ChangedFile } from "@/types/session";
import { FileList } from "./FileList";
import type { MergeGroup } from "./MergeInProgress";

/** Shared review controls for workspace, turn, commit and uncommitted files. */
export function ReviewFileList({ workspace, base, files, groups, selected, onSelect, empty, trailing }: {
  workspace: string;
  /** The diff base, so each row can count the review comments made against it. */
  base?: string;
  files: ChangedFile[];
  groups?: MergeGroup[] | null;
  selected: string | null;
  onSelect: (path: string) => void;
  empty: string;
  trailing?: (file: ChangedFile) => React.ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"flat" | "folders">("flat");
  const viewed = useViewedChanges(workspace);
  const query = filter.trim().toLocaleLowerCase();
  const matches = (file: ChangedFile) => !query || file.path.toLocaleLowerCase().includes(query) || !!file.oldPath?.toLocaleLowerCase().includes(query);
  const visible = files.filter(matches);
  const count = files.filter((file) => viewed.status(file).viewed).length;
  const list = (items: ChangedFile[]) => <FileList base={base} files={items} folders={view === "folders"} expandAll={!!query}
    selected={selected} onSelect={onSelect} empty={files.length && query ? "No files match this filter." : empty}
    trailing={(file) => {
      const status = viewed.status(file);
      return <div className="flex shrink-0 items-center gap-1 pr-2">
        {status.changed && <span title="Changed since viewed" className="text-[10px] text-warning" aria-label={`Changed since viewed: ${file.path}`}>Changed since viewed</span>}
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title={!file.blobHash ? "Viewed marks require file identities from the workspace. Update its runtime and reconnect." : undefined}>
          <input type="checkbox" aria-label={`Viewed ${file.path}`} checked={status.viewed} disabled={!file.blobHash}
            onChange={(event) => viewed.set(file, event.target.checked)} />Viewed
        </label>
        {trailing?.(file)}
      </div>;
    }} />;
  return <>
    <div className="sticky top-0 z-10 space-y-2 bg-background px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <input type="search" aria-label="Filter changed files" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)}
          className="min-w-0 flex-1 rounded bg-well px-2 py-1" />
        <Segmented value={view} onChange={setView} aria-label="File list view" options={[{ value: "flat", label: "Flat" }, { value: "folders", label: "Folders" }]} />
      </div>
      <p className="text-muted-foreground">{count} of {files.length} viewed{query && ` · ${visible.length} matching`}</p>
    </div>
    {groups?.length && visible.length ? groups.map((group) => {
      const matching = group.files.filter(matches);
      return matching.length > 0 && <section key={group.key} aria-label={group.title}>
        <h3 className="px-3 pt-2 text-[11px] font-medium text-faint">{group.title} · {matching.length}</h3>{list(matching)}
      </section>;
    }) : list(visible)}
  </>;
}
