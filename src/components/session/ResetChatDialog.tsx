import { useState } from "react";
import { joinKeycaps } from "@/lib/shortcuts";
import { errorMessage } from "@/lib/api";
import { usePref } from "@/lib/prefs";
import { Button } from "@/components/ui/button";
import { keycaps } from "@/lib/hotkeys";
import type { ResetTarget } from "@/components/chat/Chat";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Starts the backend's refusal when restoring files would overwrite other changes (session_reset.rs `OVERLAP`). */
const OVERLAP = "Other changes to these files would be overwritten: ";
/** Ends that refusal: the token that confirms exactly the plan it lists (session_reset.rs `CONFIRM`). */
const CONFIRM = "Confirm: ";

/** The paths and confirmation token in an overlap refusal, or null for any other error. */
export function overlapRefusal(message: string): { paths: string[]; token: string } | null {
  const at = message.indexOf(OVERLAP);
  const confirm = message.lastIndexOf(CONFIRM);
  if (at < 0 || confirm < at) return null;
  const rest = message.slice(at + OVERLAP.length, confirm);
  const token = message.slice(confirm + CONFIRM.length).trim();
  try {
    const paths: unknown = JSON.parse(rest.slice(0, rest.lastIndexOf("]") + 1));
    return token && Array.isArray(paths) && paths.every((path) => typeof path === "string") ? { paths, token } : null;
  } catch {
    return null;
  }
}

const SHOWN = 5;

/** Mounted per selection, so confirmation always names the selected turn. */
export function ResetChatDialog({ reset: run, endSeq, target, agent: agentLabel, filesRestored, onClose, onWarning }: {
  /**
   * The session's reset (`TurnActions.reset`): this computer's runtime for a
   * local tab, the session's own for a cloud or machine one (#1326). Resolves
   * to a warning about what went wrong after the reset, or null.
   */
  reset: (endSeq: number | null, resetFiles: boolean, confirm: string | null) => Promise<string | null>;
  endSeq: number | null;
  /** The turn reset to, the turns that go, and how many files changed since: what the dialog names. */
  target?: ResetTarget;
  /** The agent's name, for what it remembers ("Claude Code"). */
  agent?: string;
  /** Undo only: how many files the reset being undone restored. */
  filesRestored?: number;
  onClose: () => void; onWarning: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The overlap the backend listed, with the token that confirms exactly that plan. It lives
  // only in this dialog: Cancel, a changed choice or a new refusal replace it.
  const [refusal, setRefusal] = useState<{ paths: string[]; token: string } | null>(null);
  const overlap = refusal?.paths ?? null;
  const [resetFiles, setResetFiles] = usePref("resetFiles");
  const undo = endSeq === null;
  async function reset() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // "Reset anyway" hands back the token of the list that was shown; the backend
      // goes ahead only if nothing changed since that plan was made.
      const warning = await run(endSeq, !undo && resetFiles, refusal?.token ?? null);
      if (warning) onWarning(warning);
      onClose();
    } catch (e) {
      const message = errorMessage(e);
      // Undo can restore files even when this window has no count of them.
      const next = overlapRefusal(message);
      setRefusal(next);
      if (!next) setError(message);
    } finally {
      setBusy(false);
    }
  }
  const action = undo ? "Undo reset" : "Reset";
  const n = target?.turn;
  const removed = target?.removed ?? [];
  const turnsGo = !removed.length ? "Later messages are" : removed.length === 1 ? `Turn ${removed[0]} is` : `Turns ${listed(removed)} are`;
  const files = target?.files ?? 0;
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent showClose={!busy} onKeyDown={(event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void reset();
      }
    }}>
      <DialogHeader>
        <DialogTitle>{undo ? "Undo chat reset?" : n ? `Reset the chat to turn ${n}?` : "Reset the chat to here?"}</DialogTitle>
        <DialogDescription>{undo
          ? `Restore the conversation saved before the last reset. Messages sent since that reset will leave this chat.${filesRestored ? ` The ${filesRestored === 1 ? "file it restored goes" : `${filesRestored} files it restored go`} back to how ${filesRestored === 1 ? "it was" : "they were"} before the reset.` : ""}`
          : `${turnsGo} removed from this chat and from what ${agentLabel ?? "the agent"} remembers. You can undo one reset afterwards.`}</DialogDescription>
      </DialogHeader>
      <div className="my-4 space-y-2 text-sm">
        {!undo && <>
          <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 ${resetFiles ? "border-hairline-strong bg-veil-raised" : "border-hairline"}`}>
            <input type="checkbox" className="mt-0.5 accent-accent" checked={resetFiles} disabled={busy} aria-labelledby="reset-files-label" aria-describedby="reset-files-hint"
              onChange={(e) => { setResetFiles(e.target.checked); setRefusal(null); setError(null); }} />
            <span className="min-w-0">
              <span id="reset-files-label" className="block">Also reset files</span>
              <span id="reset-files-hint" className="block text-xs text-muted-foreground">{files
                ? `${files === 1 ? "1 file" : `${files} files`} changed since ${n ? `turn ${n}` : "this turn"} ${files === 1 ? "goes" : "go"} back to how ${files === 1 ? "it was" : "they were"} then`
                : `Files changed since ${n ? `turn ${n}` : "this turn"} go back to how they were then`}</span>
            </span>
          </label>
        </>}
        {overlap && <div role="alert" className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs">
          <p>{overlap.length === 1 ? "This file was" : `${overlap.length} files were`} changed by another chat or by hand since {undo ? "the reset" : "this turn"}:</p>
          <ul className="my-1.5 space-y-0.5 font-mono">
            {overlap.slice(0, SHOWN).map((path) => <li key={path} className="truncate" title={path}>{path}</li>)}
            {overlap.length > SHOWN && <li className="font-sans text-muted-foreground">and {overlap.length - SHOWN} more</li>}
          </ul>
          <p>{undo ? "Undoing the reset" : "Resetting files"} removes those changes too.</p>
        </div>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy} onClick={() => void reset()}>{busy ? "Resetting…" : overlap ? `${undo ? "Undo" : "Reset"} anyway` : action}{!busy && <kbd aria-hidden className="ml-1 rounded-sm bg-current/15 px-1 font-sans text-[12px] leading-5 opacity-80">{joinKeycaps(keycaps("mod+enter"))}</kbd>}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** "3", "3 and 4", "3, 4 and 5", then "3 to 9": later turns always run on to the last. */
function listed(numbers: number[]): string {
  if (numbers.length > 3) return `${numbers[0]} to ${numbers.at(-1)}`;
  return numbers.length < 2 ? numbers.join("") : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}
