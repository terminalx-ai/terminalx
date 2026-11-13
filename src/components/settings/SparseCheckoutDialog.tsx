import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogScrollArea, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/tooltip";
import { Check, ChevronDown, ChevronRight, Folder, HardDrive, Info, Lock, Minus, Search } from "@/icons";
import { api, errorMessage, issues } from "@/lib/api";
import { configuration } from "@/lib/configuration";
import { cn } from "@/lib/cn";
import { formatSize } from "@/lib/workspaceSizes";
import type { Project } from "@/types/session";
import type { RepositoryFolder, RepositoryFolders, SparseCheckout } from "@/types/repositoryFolders";

export const SPARSE_CHECKOUT_KEY = "sparseCheckout";

/** The saved value as the settings file holds it, or null when it is not a list of paths. */
export function readSparseCheckout(value: unknown): SparseCheckout {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

const within = (path: string, ancestor: string) => path === ancestor || path.startsWith(`${ancestor}/`);

/** Whether a top-level folder is checked out under `value`: it, something inside it, or a parent of it was chosen. */
function topChosen(top: string, value: string[]) {
  return value.some((path) => within(path, top) || within(top, path));
}

/** How many of the listed top-level folders a saved value checks out. */
export function chosenTopCount(folders: RepositoryFolder[], value: SparseCheckout) {
  return value === null ? folders.length : folders.filter((folder) => topChosen(folder.path, value)).length;
}

/** The row's text for the current choice. */
export function describeChoice(folders: RepositoryFolder[], value: SparseCheckout) {
  const total = folders.length;
  return value === null ? `All ${total} folder${total === 1 ? "" : "s"}` : `${chosenTopCount(folders, value)} of ${total} folder${total === 1 ? "" : "s"}`;
}

/** The folders a box stands for: a folder's children when it lists them, else the folder itself. */
const units = (folder: RepositoryFolder): RepositoryFolder[] => (folder.children.length ? folder.children : [folder]);
const allUnits = (folders: RepositoryFolder[]) => folders.flatMap(units);

/** The boxes ticked for a saved value, and the saved paths that no listed folder stands for (kept as they are). */
function initialChoice(folders: RepositoryFolder[], value: SparseCheckout): { chosen: Set<string>; extras: string[] } {
  const leaves = allUnits(folders);
  if (value === null) return { chosen: new Set(leaves.map((leaf) => leaf.path)), extras: [] };
  const chosen = new Set(leaves.filter((leaf) => value.some((path) => within(leaf.path, path))).map((leaf) => leaf.path));
  const listed = new Set(folders.flatMap((folder) => [folder.path, ...folder.children.map((child) => child.path)]));
  // A path deeper than the list shows (or no longer in the repository) stays saved unless a chosen folder already covers it.
  const extras = value.filter((path) => !listed.has(path) && ![...chosen].some((leaf) => within(path, leaf)));
  return { chosen, extras };
}

/**
 * The value to save: null when every folder is chosen (a full checkout), else
 * the chosen folders with a fully chosen parent saved as the parent and a
 * partly chosen one as its chosen children.
 */
export function sparseCheckoutValue(folders: RepositoryFolder[], chosen: ReadonlySet<string>, extras: readonly string[] = []): SparseCheckout {
  const paths: string[] = [];
  let everything = true;
  for (const folder of folders) {
    const picked = units(folder).filter((unit) => chosen.has(unit.path));
    if (picked.length === units(folder).length) paths.push(folder.path);
    else {
      everything = false;
      paths.push(...picked.map((unit) => unit.path));
    }
  }
  if (everything) return null;
  return [...paths, ...extras.filter((extra) => !paths.some((path) => within(extra, path)))];
}

type BoxState = "checked" | "partial" | "empty";
function boxState(folder: RepositoryFolder, chosen: ReadonlySet<string>): BoxState {
  const picked = units(folder).filter((unit) => chosen.has(unit.path)).length;
  return picked === 0 ? "empty" : picked === units(folder).length ? "checked" : "partial";
}

function matches(folder: RepositoryFolder, query: string) {
  return folder.path.toLowerCase().includes(query) || (folder.description ?? "").toLowerCase().includes(query);
}

type Sizes = "measuring" | "measured" | "unreadable";

export function SparseCheckoutDialog({ project, value, onClose, onSaved }: {
  project: Project;
  value: SparseCheckout;
  onClose: () => void;
  onSaved?: (value: SparseCheckout) => void;
}) {
  const [listing, setListing] = useState<RepositoryFolders | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Sizes>("measuring");
  const [sizesError, setSizesError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [repository, setRepository] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // The list comes at once; sizes, which walk every tracked file, follow.
    void Promise.resolve().then(() => api.repositoryFolders(project.path, false)).then((quick) => {
      if (!live) return;
      setListing((current) => current ?? quick);
      const start = initialChoice(quick.folders, value);
      setChosen(start.chosen);
      setExtras(start.extras);
      setExpanded(new Set(quick.folders.filter((folder) => boxState(folder, start.chosen) === "partial").map((folder) => folder.path)));
      return api.repositoryFolders(project.path, true).then((measured) => {
        if (!live) return;
        setListing(measured);
        const unread = measured.sizesError ?? (measured.totalSize === null ? "No sizes came back." : null);
        setSizes(unread ? "unreadable" : "measured");
        setSizesError(measured.sizesError);
      }, (error) => {
        if (!live) return;
        setSizes("unreadable");
        setSizesError(errorMessage(error));
      });
    }, (error) => { if (live) setListError(errorMessage(error)); });
    void Promise.resolve().then(() => issues.githubRepo(project.path)).then((repo) => { if (live) setRepository(repo); }, () => {});
    return () => { live = false; };
    // The saved value is read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path]);

  const folders = listing?.folders ?? [];
  const query = filter.trim().toLowerCase();
  const shown = useMemo(() => folders.flatMap((folder) => {
    if (!query || matches(folder, query)) return [{ folder, children: folder.children, open: expanded.has(folder.path) }];
    const children = folder.children.filter((child) => matches(child, query));
    return children.length ? [{ folder, children, open: true }] : [];
  }), [folders, query, expanded]);

  const toggleUnits = (targets: RepositoryFolder[], on: boolean) => setChosen((current) => {
    const next = new Set(current);
    for (const target of targets) on ? next.add(target.path) : next.delete(target.path);
    return next;
  });
  const toggleFolder = (folder: RepositoryFolder) => {
    const on = boxState(folder, chosen) !== "checked";
    toggleUnits(units(folder), on);
    if (!on) setExtras((current) => current.filter((extra) => !within(extra, folder.path)));
  };

  const chosenTops = folders.filter((folder) => boxState(folder, chosen) !== "empty" || extras.some((extra) => within(extra, folder.path))).length;
  const chosenUnits = allUnits(folders).filter((unit) => chosen.has(unit.path));
  const chosenBytes = sizes === "measured" && listing?.rootFiles.size != null && chosenUnits.every((unit) => unit.size !== null)
    ? listing.rootFiles.size + chosenUnits.reduce((sum, unit) => sum + (unit.size ?? 0), 0)
    : null;
  const totalBytes = sizes === "measured" ? listing?.totalSize ?? null : null;

  const save = async () => {
    if (!listing || saving) return;
    const next = sparseCheckoutValue(listing.folders, chosen, extras);
    setSaving(true);
    setSaveError(null);
    try {
      await configuration.write(project.path, "repositoryShared", SPARSE_CHECKOUT_KEY, next);
      onSaved?.(next);
      onClose();
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally { setSaving(false); }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
  };

  const subtitle = [
    project.name,
    repository,
    sizes === "measuring" ? "measuring size…" : listing?.totalSize != null ? `${formatSize(listing.totalSize)} when checked out in full` : null,
  ].filter(Boolean).join(" · ");
  const sizeCell = (size: number | null, dim: boolean) => (
    <span className={cn("w-16 shrink-0 text-right text-xs tabular-nums", dim ? "text-faint" : "text-muted-foreground")} data-size-cell>
      {size !== null ? formatSize(size) : sizes === "measuring" ? <span aria-label="Measuring size" className="inline-block h-2 w-8 animate-pulse rounded-sm bg-veil-strong align-middle" /> : "—"}
    </span>
  );
  const box = (state: BoxState, label: string, onToggle: () => void) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "checked" ? true : state === "partial" ? "mixed" : false}
      aria-label={label}
      disabled={saving}
      onClick={onToggle}
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3",
        state === "empty" ? "border border-muted-foreground/60" : "bg-accent text-accent-foreground",
      )}
    >
      {state === "checked" ? <Check /> : state === "partial" ? <Minus /> : null}
    </button>
  );
  const folderRow = (folder: RepositoryFolder, state: BoxState, depth: 0 | 1, chevron: { open: boolean; toggle: () => void } | null, onToggle: () => void) => {
    const dim = state === "empty";
    return (
      <li key={folder.path} className={cn("flex min-h-9 items-center gap-2.5 border-b border-hairline py-1.5 pr-3", depth ? "pl-9" : "pl-3")} data-folder-row={folder.path}>
        {chevron ? (
          <button type="button" aria-label={`${chevron.open ? "Hide" : "Show"} folders in ${folder.path}/`} aria-expanded={chevron.open} onClick={chevron.toggle} className="grid size-3 shrink-0 place-items-center text-faint outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3">
            {chevron.open ? <ChevronDown /> : <ChevronRight />}
          </button>
        ) : <span className="w-3 shrink-0" />}
        {box(state, `${folder.path}/`, onToggle)}
        <Folder aria-hidden className={cn("size-3.5 shrink-0", dim ? "text-faint" : "text-accent")} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={cn("min-w-0 break-all font-mono text-[12.5px]", dim && "text-faint")}>{folder.path}/</span>
          {folder.description && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={folder.description}>{folder.description}</span>}
        </span>
        {sizeCell(folder.size, dim)}
      </li>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent width="max-w-[600px]" layout="pinned" className="mt-14 max-h-[calc(100dvh-4.5rem)] p-0" aria-describedby="sparse-checkout-subtitle" onKeyDown={onKeyDown}>
        <div className="shrink-0 px-5 pb-3 pt-4 pr-12">
          <DialogTitle className="text-[15px] font-semibold">Check out only some folders</DialogTitle>
          <DialogDescription id="sparse-checkout-subtitle" className="mt-0.5 break-words text-[12.5px] text-muted-foreground">{subtitle}</DialogDescription>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5">
          <label className="flex h-8 min-w-40 flex-1 items-center gap-2 rounded-md border border-border px-2.5 text-[12.5px] focus-within:ring-1 focus-within:ring-ring/50 [&_svg]:size-3.5">
            <Search aria-hidden className="shrink-0 text-faint" />
            <input type="search" aria-label="Filter folders" placeholder="Filter folders" value={filter} onChange={(event) => setFilter(event.target.value)} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
          </label>
          <Button size="sm" variant="ghost" disabled={!listing || saving} onClick={() => { setChosen(new Set(allUnits(folders).map((unit) => unit.path))); setExtras([]); }}>Select all</Button>
          <Button size="sm" variant="ghost" disabled={!listing || saving} onClick={() => { setChosen(new Set()); setExtras([]); }}>Clear</Button>
        </div>
        <DialogScrollArea aria-label="Folders" className="mx-5 mr-3 mt-3 min-h-24 rounded-lg border border-hairline pr-0">
          {listError ? (
            <p role="alert" className="break-words p-3 text-xs text-destructive">Could not list this repository's folders: {listError}</p>
          ) : !listing ? (
            <p role="status" className="p-3 text-xs text-muted-foreground">Reading folders…</p>
          ) : (
            <ul className="min-w-0">
              {!shown.length && <li className="border-b border-hairline px-3 py-2.5 text-xs text-muted-foreground">{folders.length ? "No folders match." : "This repository has no folders."}</li>}
              {shown.flatMap(({ folder, children, open }) => {
                const hasChildren = folder.children.length > 0;
                const row = folderRow(folder, boxState(folder, chosen), 0,
                  hasChildren ? { open, toggle: () => setExpanded((current) => { const next = new Set(current); next.has(folder.path) ? next.delete(folder.path) : next.add(folder.path); return next; }) } : null,
                  () => toggleFolder(folder));
                const kids = hasChildren && open ? children.map((child) => folderRow(child, chosen.has(child.path) ? "checked" : "empty", 1, null, () => toggleUnits([child], !chosen.has(child.path)))) : [];
                return [row, ...kids];
              })}
              <li className="flex min-h-9 items-center gap-2.5 py-1.5 pl-3 pr-3" data-folder-row=":root">
                <span className="w-3 shrink-0" />
                <span className="w-4 shrink-0" />
                <Lock aria-hidden className="size-3.5 shrink-0 text-faint" />
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="text-[12.5px]">Files at the root</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">always checked out</span>
                </span>
                {sizeCell(listing.rootFiles.size, false)}
              </li>
            </ul>
          )}
        </DialogScrollArea>
        <div className="shrink-0 px-5">
          {listing && (
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]" aria-live="polite" data-sparse-summary>
              <HardDrive aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span>{chosenTops} of {folders.length} folder{folders.length === 1 ? "" : "s"}</span>
              {sizes === "measuring" ? <span className="text-muted-foreground">· measuring sizes…</span>
                : chosenBytes !== null && totalBytes !== null ? <span className="text-muted-foreground">· about {formatSize(chosenBytes)} of {formatSize(totalBytes)}</span>
                : null}
            </p>
          )}
          {listing && sizes === "unreadable" && (
            <p role="status" className="mt-1 break-words text-xs text-warning">Sizes could not be read{sizesError ? `: ${sizesError}` : "."}</p>
          )}
          {extras.length > 0 && (
            <p className="mt-1 break-all text-xs text-muted-foreground">Also checked out, from the settings file: <span className="font-mono">{extras.join(", ")}</span></p>
          )}
          <div className="mb-4 mt-2 flex items-start gap-2 text-xs text-faint">
            <Info aria-hidden className="mt-[3px] size-3.5 shrink-0" />
            <p>New workspaces check out only these. Existing workspaces are unaffected. Agents can’t open folders that aren’t checked out; they ask you to add one.</p>
          </div>
          {saveError && <p role="alert" className="mb-3 break-words text-xs text-destructive">Could not save: {saveError}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-hairline px-5 py-3">
          <span className="min-w-0 text-xs text-faint">Saved in <span className="font-mono">.terminalx/settings.json</span> for everyone on this project</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
            <Button disabled={!listing || saving} onClick={() => void save()} aria-label={saving ? "Saving…" : "Save"} aria-keyshortcuts="Meta+Enter Control+Enter">
              {saving ? "Saving…" : "Save"}<Kbd className="ml-0.5 bg-transparent text-xs text-current opacity-70">⌘↵</Kbd>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
