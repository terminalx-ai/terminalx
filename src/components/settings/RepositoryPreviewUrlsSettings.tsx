import { useId, useState } from "react";
import { Globe, Plus, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { moveRepositoryEntry, validatePreviewUrl, type RepositoryPreviewUrl } from "@/lib/repositoryActions";
import { RepositoryFieldError, RepositoryOrderButtons, repositoryInputClass, useRepositoryMutation } from "./repositoryEditor";

/** As with Actions, the parent owns persistence and updates the list only after a successful save. */
export function RepositoryPreviewUrlsSettings({ urls, onChange }: {
  urls: readonly RepositoryPreviewUrl[];
  onChange: (urls: RepositoryPreviewUrl[]) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ entry: RepositoryPreviewUrl; isNew: boolean } | null>(null);
  const mutation = useRepositoryMutation();
  const errorId = useId();
  const change = (next: RepositoryPreviewUrl[]) => mutation.run(() => onChange(next));
  return (
    <section aria-label="Preview URLs" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Preview URLs</h3>
        <Button variant="outline" size="sm" disabled={mutation.busy} onClick={() => {
          mutation.clearError();
          setEditing({ isNew: true, entry: { id: crypto.randomUUID(), name: "", url: "http://localhost:$PORT" } });
        }}><Plus />Add URL</Button>
      </div>
      <p className="text-xs text-muted-foreground">Use $PORT or $PORT_1 for the first workspace port, $PORT_2 for the second, and so on.</p>
      {!urls.length && <p className="text-sm text-muted-foreground">Save a name and URL for each preview you open.</p>}
      <ol aria-label="Saved preview URLs" className="divide-y divide-hairline">
        {urls.map((entry, index) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-1 py-2">
            <Globe aria-hidden className="mr-1 size-4 shrink-0 text-muted-foreground" />
            <button type="button" aria-label={`Edit ${entry.name}`} disabled={mutation.busy} className="min-w-0 flex-1 rounded-md px-1 py-1 text-left outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => {
              mutation.clearError();
              setEditing({ entry, isNew: false });
            }}>
              <span className="block truncate text-sm">{entry.name}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{entry.url}</span>
            </button>
            <RepositoryOrderButtons name={entry.name} index={index} count={urls.length} disabled={mutation.busy} onMove={(direction) => void change(moveRepositoryEntry(urls, entry.id, direction))} />
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${entry.name}`} disabled={mutation.busy} onClick={() => void change(urls.filter((url) => url.id !== entry.id))}><Trash2 /></Button>
          </li>
        ))}
      </ol>
      {!editing && <RepositoryFieldError id={errorId} error={mutation.error} />}
      {editing && <PreviewUrlDialog key={editing.entry.id} entry={editing.entry} urls={urls} isNew={editing.isNew} busy={mutation.busy} error={mutation.error} onClose={() => setEditing(null)} onSave={async (entry) => {
        if (!editing.isNew && !urls.some((url) => url.id === entry.id)) return mutation.run(async () => { throw new Error("This URL was removed. Close the dialog and add it again."); });
        return change(editing.isNew ? [...urls, entry] : urls.map((url) => url.id === entry.id ? entry : url));
      }} />}
    </section>
  );
}

function PreviewUrlDialog({ entry, urls, isNew, busy, error, onClose, onSave }: {
  entry: RepositoryPreviewUrl;
  urls: readonly RepositoryPreviewUrl[];
  isNew: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (entry: RepositoryPreviewUrl) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(entry);
  const [attempted, setAttempted] = useState(false);
  const id = useId();
  const errors = attempted ? validatePreviewUrl(draft, urls) : { name: undefined, url: undefined };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent showClose={!busy}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{isNew ? "Add preview URL" : "Edit preview URL"}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">Give this preview a name. For example, http://localhost:$PORT.</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setAttempted(true);
          if (Object.values(validatePreviewUrl(draft, urls)).some(Boolean)) return;
          void onSave({ ...draft, name: draft.name.trim(), url: draft.url.trim() }).then((saved) => { if (saved) onClose(); });
        }}>
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            <div>
              <label htmlFor={`${id}-name`} className="mb-1 block text-xs font-medium">Name</label>
              <input id={`${id}-name`} autoFocus value={draft.name} aria-invalid={!!errors.name} aria-describedby={errors.name ? `${id}-name-error` : undefined} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className={repositoryInputClass} />
              <RepositoryFieldError id={`${id}-name-error`} error={errors.name} />
            </div>
            <div>
              <label htmlFor={`${id}-url`} className="mb-1 block text-xs font-medium">URL</label>
              <input id={`${id}-url`} type="text" inputMode="url" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={draft.url} aria-invalid={!!errors.url} aria-describedby={errors.url ? `${id}-url-error` : undefined} onChange={(event) => setDraft({ ...draft, url: event.target.value })} className={`${repositoryInputClass} font-mono`} />
              <RepositoryFieldError id={`${id}-url-error`} error={errors.url} />
            </div>
          </fieldset>
          <RepositoryFieldError id={`${id}-save-error`} error={error} />
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save URL"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
