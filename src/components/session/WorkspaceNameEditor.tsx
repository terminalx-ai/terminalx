import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export function WorkspaceNameEditor({
  value,
  editable = true,
  onActivate,
  onCommit,
  onError,
  className,
}: {
  value: string;
  editable?: boolean;
  onActivate?: () => void;
  onCommit: (name: string) => string | Promise<string>;
  onError?: (message: string | null) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const clickTimer = useRef<number | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(
    () => () => {
      if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
    },
    [],
  );

  const begin = () => {
    if (!editable || saving) return;
    cancelled.current = false;
    setDraft(value);
    setEditing(true);
    onError?.(null);
  };

  const cancel = () => {
    cancelled.current = true;
    setDraft(value);
    setEditing(false);
    onError?.(null);
  };

  const commit = async () => {
    if (cancelled.current || saving) return;
    const next = draft.trim();
    if (!next || next === value) {
      setDraft(value);
      setEditing(false);
      return;
    }
    setSaving(true);
    onError?.(null);
    try {
      const canonical = await onCommit(next);
      setDraft(canonical);
      setEditing(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError?.(message);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label="Workspace name"
        aria-busy={saving}
        disabled={saving}
        value={draft}
        maxLength={40}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
        className={cn(
          "h-5 min-w-0 rounded-sm bg-raised px-1 font-mono text-inherit outline-none ring-2 ring-inset ring-ring/60 disabled:opacity-60",
          className,
        )}
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={editable ? `Workspace ${value}. Press F2 to rename` : value}
      title={editable ? "Double-click to rename workspace" : undefined}
      onClick={(event) => {
        if (!onActivate) return;
        if (event.detail === 0) {
          onActivate();
          return;
        }
        if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
          clickTimer.current = null;
          onActivate();
        }, 220);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
        clickTimer.current = null;
        begin();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          if (!onActivate) return;
          event.preventDefault();
          onActivate();
        } else if (editable && event.key === "F2") {
          event.preventDefault();
          begin();
        }
      }}
      className={cn(
        "min-w-0 truncate rounded-sm font-mono text-inherit outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        editable && "cursor-text hover:bg-selected/60 hover:no-underline",
        className,
      )}
    >
      {value}
    </button>
  );
}
