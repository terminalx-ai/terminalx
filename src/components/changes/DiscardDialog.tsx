import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import type { GitSource } from "@/lib/gitSource";

/** Shared by the file list and the diff header. The base is exactly the one being reviewed. */
export function DiscardDialog({ source, file, base, onClose, onDiscarded }: {
  source: GitSource;
  file: { path: string; oldPath?: string } | null;
  base?: string | null;
  onClose: () => void;
  onDiscarded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discard = async () => {
    if (!file || !source.discard || busy) return;
    setBusy(true);
    setError(null);
    try {
      await source.discard(file.path, base, file.oldPath);
      window.dispatchEvent(new Event("workspace-files-changed"));
      onDiscarded();
      onClose();
    } catch (e) { setError(source.errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <Dialog open={!!file} onOpenChange={(open) => { if (!open && !busy) { setError(null); onClose(); } }}>
    <DialogContent showClose={!busy}>
      <DialogTitle>Discard changes to this file?</DialogTitle>
      <DialogDescription className="mt-2 text-sm text-muted-foreground">
        Restore {file?.path}{file?.oldPath ? ` and ${file.oldPath}` : ""} to {base ? "the comparison’s starting version" : "HEAD"}, including staged changes. Files absent from that version will be deleted. This cannot be undone from this dialog.
      </DialogDescription>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="secondary" disabled={busy} onClick={() => { setError(null); onClose(); }}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={() => void discard()}>{busy ? "Discarding…" : "Discard"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function DiscardButton({ path, onClick }: { path: string; onClick: () => void }) {
  return <Button size="sm" variant="ghost" aria-label={`Discard changes to ${path}`} onClick={onClick}>Discard</Button>;
}
