import { useId, useState, type FocusEvent } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { moveRepositoryEntry, validatePreviewUrl, type RepositoryPreviewUrl } from "@/lib/repositoryActions";
import { RepositoryFieldError, useRepositoryMutation } from "./repositoryEditor";

const fieldClass = "h-8 min-w-0 rounded-md border border-border bg-well px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-destructive/60";

/**
 * Design 11.02: each preview URL is a name and a URL field side by side, with ↑ ↓ × beside them. A row is saved when
 * focus leaves it (or on Enter) and only once it is valid; Escape puts the saved text back. As with Actions, the parent
 * owns persistence and updates the list only after a successful save.
 */
export function RepositoryPreviewUrlsSettings({ urls, onChange }: {
  urls: readonly RepositoryPreviewUrl[];
  onChange: (urls: RepositoryPreviewUrl[]) => Promise<void>;
}) {
  // Rows being edited, by id, and rows added but not yet saved.
  const [drafts, setDrafts] = useState<Record<string, RepositoryPreviewUrl>>({});
  const [added, setAdded] = useState<RepositoryPreviewUrl[]>([]);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const mutation = useRepositoryMutation();
  const id = useId();
  const change = (next: RepositoryPreviewUrl[]) => mutation.run(() => onChange(next));
  const rows = [...urls.map((url) => ({ entry: drafts[url.id] ?? url, saved: url as RepositoryPreviewUrl | undefined })), ...added.map((entry) => ({ entry, saved: undefined }))];
  const forget = (entryId: string) => {
    setDrafts(({ [entryId]: _, ...rest }) => rest);
    setShown((ids) => { const next = new Set(ids); next.delete(entryId); return next; });
  };
  const edit = (entry: RepositoryPreviewUrl, isNew: boolean) => {
    mutation.clearError();
    if (isNew) setAdded((list) => list.map((row) => row.id === entry.id ? entry : row));
    else setDrafts((all) => ({ ...all, [entry.id]: entry }));
  };
  const commit = async (entry: RepositoryPreviewUrl, saved: RepositoryPreviewUrl | undefined) => {
    if (mutation.busy) return;
    const trimmed = { ...entry, name: entry.name.trim(), url: entry.url.trim() };
    if (saved && trimmed.name === saved.name && trimmed.url === saved.url) return forget(entry.id);
    // A new row left blank is dropped rather than flagged.
    if (!saved && !trimmed.name && !trimmed.url) { setAdded((list) => list.filter((row) => row.id !== entry.id)); return forget(entry.id); }
    if (Object.values(validatePreviewUrl(trimmed, urls)).some(Boolean)) { setShown((ids) => new Set(ids).add(entry.id)); return; }
    if (saved && !urls.some((url) => url.id === entry.id)) return void mutation.run(async () => { throw new Error("This URL was removed. Add it again."); });
    const ok = await change(saved ? urls.map((url) => url.id === entry.id ? trimmed : url) : [...urls, trimmed]);
    if (!ok) return;
    if (!saved) setAdded((list) => list.filter((row) => row.id !== entry.id));
    forget(entry.id);
  };
  const leave = (event: FocusEvent<HTMLElement>, entry: RepositoryPreviewUrl, saved: RepositoryPreviewUrl | undefined) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    void commit(entry, saved);
  };
  return (
    <section aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`} className="text-sm font-medium">Preview URLs</h4>
      <p className="mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground">Use $PORT or $PORT_1 for the first workspace port, $PORT_2 for the second, and so on.</p>
      <ol aria-label="Saved preview URLs" className="mt-2.5 grid gap-2">
        {rows.map(({ entry, saved }, index) => {
          const errors = shown.has(entry.id) ? validatePreviewUrl(entry, urls) : { name: undefined, url: undefined };
          const label = saved?.name || entry.name.trim() || "new preview URL";
          const errorId = `${id}-${entry.id}-error`;
          const message = errors.name ?? errors.url;
          return (
            <li key={entry.id} className="min-w-0" onBlur={(event) => leave(event, entry, saved)} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") { event.preventDefault(); void commit(entry, saved); }
              if (event.key === "Escape" && (saved ? drafts[entry.id] : true)) {
                event.preventDefault();
                event.stopPropagation();
                if (saved) forget(entry.id);
                else { setAdded((list) => list.filter((row) => row.id !== entry.id)); forget(entry.id); }
              }
            }}>
              <div className="flex items-center gap-2">
                <input aria-label={`Name of ${label}`} placeholder="Name" value={entry.name} disabled={mutation.busy} autoFocus={!saved}
                  aria-invalid={!!errors.name} aria-describedby={message ? errorId : undefined}
                  onChange={(event) => edit({ ...entry, name: event.target.value }, !saved)} className={cn(fieldClass, "w-[150px] shrink-0")} />
                <input aria-label={`URL of ${label}`} placeholder="http://localhost:$PORT" value={entry.url} disabled={mutation.busy}
                  type="text" inputMode="url" spellCheck={false} autoCapitalize="off" autoCorrect="off"
                  aria-invalid={!!errors.url} aria-describedby={message ? errorId : undefined}
                  onChange={(event) => edit({ ...entry, url: event.target.value }, !saved)} className={cn(fieldClass, "flex-1 font-mono text-[12px]")} />
                <span className="flex shrink-0 text-faint">
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${label} up`} disabled={mutation.busy || !saved || index === 0}
                    onClick={() => void change(moveRepositoryEntry(urls, entry.id, -1))}><ArrowUp /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${label} down`} disabled={mutation.busy || !saved || index >= urls.length - 1}
                    onClick={() => void change(moveRepositoryEntry(urls, entry.id, 1))}><ArrowDown /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${label}`} disabled={mutation.busy}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (!saved) { setAdded((list) => list.filter((row) => row.id !== entry.id)); return forget(entry.id); }
                      void change(urls.filter((url) => url.id !== entry.id)).then((ok) => { if (ok) forget(entry.id); });
                    }}><X /></Button>
                </span>
              </div>
              <RepositoryFieldError id={errorId} error={message} />
            </li>
          );
        })}
      </ol>
      <div className={cn(rows.length > 0 && "mt-2")}>
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" disabled={mutation.busy} onClick={() => {
          mutation.clearError();
          setAdded((list) => [...list, { id: crypto.randomUUID(), name: "", url: "" }]);
        }}><Plus />Add preview URL</Button>
      </div>
      <RepositoryFieldError id={`${id}-save-error`} error={mutation.error} />
    </section>
  );
}
