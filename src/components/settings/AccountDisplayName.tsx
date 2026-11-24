import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Check, CheckCircle2, Pencil, X } from "@/icons";
import { DISPLAY_NAME_UNSUPPORTED, displayNameError, updateDisplayName } from "@/lib/account";
import { errorMessage, type AccountIdentity } from "@/lib/api";

const unsupportedMessage = "This server does not support editing display names yet.";

export function AccountDisplayName({ identity, revision, children }: {
  identity: AccountIdentity;
  revision: string;
  children: (action: ReactNode, saved: boolean) => ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<Awaited<ReturnType<typeof updateDisplayName>> | null>(null);
  const fieldId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (draft === null && restoreFocus.current) {
      restoreFocus.current = false;
      editButton.current?.focus();
    }
  }, [draft]);

  function closeEditor() {
    restoreFocus.current = true;
    setDraft(null);
    setError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (draft === null || saving || unsupported) return;
    const invalid = displayNameError(draft);
    setError(invalid);
    if (invalid) return;
    setSaving(true);
    try {
      const updated = await updateDisplayName(draft, revision);
      if (updated) {
        setSaved(true);
        setNotice(updated);
      }
      closeEditor();
    } catch (failure) {
      const message = errorMessage(failure);
      if (message === DISPLAY_NAME_UNSUPPORTED) {
        setUnsupported(true);
        setError(unsupportedMessage);
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  return <>
    {children(draft === null && <>
      {saved && <span className="inline-flex h-[18px] items-center gap-1 rounded bg-add/12 px-1.5 text-[11px] font-medium text-add">
        <Check aria-hidden className="size-3" /> Saved
      </span>}
      <Button ref={editButton} size="sm" variant="ghost" onClick={() => {
        setSaved(false);
        setNotice(null);
        setDraft(identity.name ?? "");
        if (unsupported) setError(unsupportedMessage);
      }}><Pencil aria-hidden /> Edit name</Button>
    </>, saved)}
    {draft !== null && (
      <form onSubmit={(event) => void save(event)} onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) {
          event.preventDefault();
          event.stopPropagation();
          closeEditor();
        }
      }} className="mb-4 flex max-w-lg flex-col gap-2">
        <label htmlFor={fieldId} className="text-[13px] font-medium">Display name</label>
        <div className="flex flex-wrap items-center gap-2">
          <input id={fieldId} value={draft} autoFocus readOnly={saving || unsupported} aria-invalid={!!error}
            aria-describedby={error ? `${fieldId}-error` : undefined}
            onChange={(event) => { setDraft(event.target.value); if (!unsupported) setError(null); }}
            className="h-8 min-w-32 flex-1 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <Button size="sm" variant="ghost" disabled={saving} onClick={closeEditor}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving || unsupported}>{saving ? "Saving…" : "Save"}</Button>
        </div>
        {error && <p id={`${fieldId}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
      </form>
    )}
    {notice && <div className="fixed bottom-6 right-6 z-(--z-menu) flex w-[min(380px,calc(100vw-3rem))] items-start gap-2.5 rounded-lg bg-popover px-3.5 py-3 text-card-foreground shadow-surface hairline">
      <CheckCircle2 aria-hidden className="mt-px size-4 shrink-0 text-add" />
      <div role="status" className="min-w-0 flex-1 wrap-anywhere">
        <div className="text-[13px] font-medium">Display name updated</div>
        {notice.organization && <p className="mt-0.5 text-xs text-muted-foreground">
          Teammates in {notice.organization} now see “{notice.name}” on shared sessions, mentions and nudges.
        </p>}
      </div>
      <button type="button" aria-label="Dismiss display name notification" onClick={() => setNotice(null)}
        className="shrink-0 rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground">
        <X aria-hidden className="size-3.5" />
      </button>
    </div>}
  </>;
}
