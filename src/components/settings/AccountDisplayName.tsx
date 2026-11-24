import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "@/icons";
import { displayNameError, updateDisplayName } from "@/lib/account";
import { errorMessage, type AccountIdentity } from "@/lib/api";

export function AccountDisplayName({ identity, revision, children }: {
  identity: AccountIdentity;
  revision: string;
  children: (action: ReactNode) => ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<{ organization: string | null } | null>(null);
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
    if (draft === null || saving) return;
    const invalid = displayNameError(draft);
    setError(invalid);
    if (invalid) return;
    setSaving(true);
    try {
      const organization = await updateDisplayName(draft, revision);
      setSaved(true);
      setNotice({ organization });
      closeEditor();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  return <>
    {children(draft === null && <>
      <Button ref={editButton} size="xs" variant="ghost" onClick={() => {
        setSaved(false);
        setNotice(null);
        setDraft(identity.name ?? "");
      }}>Edit name</Button>
      {saved && <span className="shrink-0 text-[11px] font-medium text-add">Saved</span>}
    </>)}
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
          <input id={fieldId} value={draft} autoFocus readOnly={saving} aria-invalid={!!error}
            aria-describedby={error ? `${fieldId}-error` : undefined}
            onChange={(event) => { setDraft(event.target.value); setError(null); }}
            className="h-8 min-w-32 flex-1 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <Button size="sm" variant="ghost" disabled={saving} onClick={closeEditor}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </div>
        {error && <p id={`${fieldId}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
      </form>
    )}
    {notice && <div role="status" className="fixed bottom-4 right-4 z-(--z-menu) flex max-w-[min(22rem,calc(100vw-2rem))] items-start gap-2 rounded-lg bg-popover px-4 py-3 text-xs text-card-foreground shadow-surface hairline">
      <CheckCircle2 aria-hidden className="size-4 shrink-0 text-add" />
      <div>
        <div className="font-medium">Display name updated</div>
        {notice.organization && <p className="mt-1 text-muted-foreground">
          Teammates in {notice.organization} now see your new name on shared sessions, mentions and nudges.
        </p>}
      </div>
    </div>}
  </>;
}
