import { forwardRef, useCallback, useEffect, useState, type HTMLAttributes } from "react";
import { Button } from "@/components/ui/button";
import { FolderTree } from "@/icons";
import { api, errorMessage } from "@/lib/api";
import { configuration } from "@/lib/configuration";
import type { Project } from "@/types/session";
import type { RepositoryFolder, SparseCheckout } from "@/types/repositoryFolders";
import { resolveSetting } from "./settingsRegistry";
import { describeChoice, readSparseCheckout, SPARSE_CHECKOUT_KEY, SparseCheckoutDialog } from "./SparseCheckoutDialog";

/**
 * Settings → project → General → Check out only some folders: the current
 * choice from the repository's shared settings file, and the dialog that
 * changes it. Read again whenever the configuration files change.
 */
export const SparseCheckoutRow = forwardRef<HTMLDivElement, { project: Project } & HTMLAttributes<HTMLDivElement>>(({ project, className, ...anchor }, ref) => {
  const setting = resolveSetting("repositories.sparseCheckout");
  const [value, setValue] = useState<SparseCheckout | undefined>(undefined);
  const [locked, setLocked] = useState(false);
  const [folders, setFolders] = useState<RepositoryFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const read = useCallback(() => Promise.resolve().then(() => configuration.resolve(project.path)).then((resolved) => {
    const entry = resolved.values[SPARSE_CHECKOUT_KEY];
    return { value: readSparseCheckout(entry?.value), locked: !!entry?.locked };
  }), [project.path]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | null = null;
    const refresh = () => read().then((next) => {
      if (!live) return;
      setValue(next.value);
      setLocked(next.locked);
      setError(null);
    }, (failure) => { if (live) setError(errorMessage(failure)); });
    void refresh();
    void Promise.resolve().then(() => api.repositoryFolders(project.path, false)).then((listing) => { if (live) setFolders(listing.folders); }, (failure) => { if (live) setError(errorMessage(failure)); });
    void Promise.resolve().then(() => configuration.watch(project.path, () => void refresh())).then((unwatch) => {
      if (live) stop = unwatch;
      else unwatch();
    }, () => {});
    return () => { live = false; stop?.(); };
  }, [project.path, read]);

  const choice = value === undefined || folders === null ? null : describeChoice(folders, value);
  return (
    <div ref={ref} {...anchor} className={className ?? "min-w-0 border-b border-hairline py-4 outline-none"}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <h4 className="text-sm font-medium">{setting.title}</h4>
          <p className="text-xs leading-relaxed text-muted-foreground">{setting.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="whitespace-nowrap text-xs text-muted-foreground" data-sparse-choice>{choice ?? (error ? "" : "Reading folders…")}</span>
          <Button size="sm" variant="outline" disabled={value === undefined || locked} onClick={() => setOpen(true)}><FolderTree aria-hidden />Choose folders…</Button>
        </div>
      </div>
      {locked && <p className="mt-1.5 text-xs text-muted-foreground">Set by managed configuration.</p>}
      {error && <p role="status" className="mt-1.5 break-words text-xs text-destructive">Could not read this setting: {error}</p>}
      {open && value !== undefined && (
        <SparseCheckoutDialog project={project} value={value} onClose={() => setOpen(false)} onSaved={(next) => setValue(next)} />
      )}
    </div>
  );
});
SparseCheckoutRow.displayName = "SparseCheckoutRow";
