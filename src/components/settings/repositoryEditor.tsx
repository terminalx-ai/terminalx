import { useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "@/icons";
import { Button } from "@/components/ui/button";

export const repositoryInputClass = "w-full rounded-md border border-border bg-well px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";

/** One write at a time, including two submit events before React renders. */
export function useRepositoryMutation() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (save: () => Promise<void>): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await save();
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
      setError(message.trim() || "Could not save changes. Try again.");
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run, clearError: () => setError(null) };
}

export function RepositoryOrderButtons({ name, index, count, disabled, onMove }: {
  name: string;
  index: number;
  count: number;
  disabled: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  return <>
    <Button variant="ghost" size="icon-sm" aria-label={`Move ${name} up`} disabled={disabled || index === 0} onClick={() => onMove(-1)}><ArrowUp /></Button>
    <Button variant="ghost" size="icon-sm" aria-label={`Move ${name} down`} disabled={disabled || index === count - 1} onClick={() => onMove(1)}><ArrowDown /></Button>
  </>;
}

export function RepositoryFieldError({ id, error }: { id: string; error?: string | null }) {
  return error ? <p id={id} role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null;
}
