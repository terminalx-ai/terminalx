import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { openWorkspaceInEditor, SSH_EDITORS, type SshEditor } from "@/lib/cloudSsh";

/**
 * Opening a cloud workspace in an editor over SSH (PRO-215, 14.06 and 14.16):
 * one open at a time per workspace, whatever started it. The SSH setup can
 * take up to 25 seconds, so the attempt is kept here, for the menu's status
 * dialog and the move dialog to show; a later attempt clears an old error.
 */
export interface EditorOpenTarget {
  orgId: string;
  workspaceId: string;
  /** The checkout to open, when the caller knows it from the runtime. */
  path?: string | null;
  /** The repository to prefer among the runtime's checkouts. */
  preferredRepo?: string | null;
}

export type EditorOpenState =
  | { editor: SshEditor; phase: "opening" }
  | { editor: SshEditor; phase: "opened" }
  | { editor: SshEditor; phase: "failed"; message: string };

const states = new Map<string, EditorOpenState>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of [...listeners]) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const editorLabel = (editor: SshEditor) => SSH_EDITORS.find((entry) => entry.id === editor)?.label ?? editor;

/** What the native command and the setup say, plainly; never an object dump. */
export function editorErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "The editor did not open";
}

export function useEditorOpen(workspaceId: string): EditorOpenState | null {
  return useSyncExternalStore(subscribe, () => states.get(workspaceId) ?? null, () => null);
}

/** Starts an open unless one is already running for the workspace. */
export async function openInEditor(target: EditorOpenTarget, editor: SshEditor): Promise<void> {
  if (states.get(target.workspaceId)?.phase === "opening") return;
  states.set(target.workspaceId, { editor, phase: "opening" });
  changed();
  try {
    await openWorkspaceInEditor({ orgId: target.orgId, workspaceId: target.workspaceId }, editor, target.path, target.preferredRepo);
    states.set(target.workspaceId, { editor, phase: "opened" });
  } catch (error) {
    states.set(target.workspaceId, { editor, phase: "failed", message: editorErrorMessage(error) });
  }
  changed();
}

export function clearEditorOpen(workspaceId: string) {
  if (states.get(workspaceId)?.phase === "opening") return;
  if (states.delete(workspaceId)) changed();
}

/** The open's progress or its error, for wherever the editors are offered. */
export function EditorOpenStatus({ state }: { state: EditorOpenState | null }) {
  if (!state) return null;
  const label = editorLabel(state.editor);
  if (state.phase === "opening") {
    return <p role="status" className="text-xs text-muted-foreground">Setting up SSH and opening {label}… This can take up to half a minute.</p>;
  }
  if (state.phase === "opened") return <p role="status" className="text-xs text-muted-foreground">Opened in {label}.</p>;
  return <p role="alert" className="text-xs text-destructive">{state.message}</p>;
}

export function EditorButtonNote({ editor }: { editor: SshEditor }) {
  return SSH_EDITORS.find((entry) => entry.id === editor)?.needsForwarding
    ? <span className="text-[10px] text-muted-foreground">Experimental</span>
    : null;
}

/** The forwarding note, shown once beside the editors that need it. */
export const forwardingNote = "VS Code and Cursor may not connect yet: they need SSH forwarding, which is off.";

let dialogTarget: (EditorOpenTarget & { name: string }) | null = null;
const dialogListeners = new Set<() => void>();

/** From the workspace menu: start the open and show how it goes. */
export function openEditorDialog(target: (EditorOpenTarget & { name: string }) | null, editor?: SshEditor) {
  dialogTarget = target;
  for (const listener of [...dialogListeners]) listener();
  if (target && editor) void openInEditor(target, editor);
}

/** Mounted once (AppShell): the status dialog for `openEditorDialog`. */
export function CloudEditorOpenHost() {
  const target = useSyncExternalStore(
    (listener) => { dialogListeners.add(listener); return () => { dialogListeners.delete(listener); }; },
    () => dialogTarget,
    () => null,
  );
  if (!target) return null;
  return <CloudEditorOpenDialog target={target} onClose={() => { clearEditorOpen(target.workspaceId); openEditorDialog(null); }} />;
}

function CloudEditorOpenDialog({ target, onClose }: { target: EditorOpenTarget & { name: string }; onClose: () => void }) {
  const state = useEditorOpen(target.workspaceId);
  const opening = state?.phase === "opening";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-md">
        <DialogHeader>
          <DialogTitle>Open {target.name} in an editor</DialogTitle>
          <DialogDescription>Over SSH, through this workspace's own host alias.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            {SSH_EDITORS.map(({ id, label }) => (
              <Button key={id} variant="outline" className="h-auto flex-col items-start gap-0.5 py-2" disabled={opening}
                aria-busy={opening && state?.editor === id} onClick={() => void openInEditor(target, id)}>
                <span>{opening && state?.editor === id ? `Opening ${label}…` : label}</span>
                <EditorButtonNote editor={id} />
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{forwardingNote}</p>
          <EditorOpenStatus state={state} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{state?.phase === "opened" ? "Done" : "Close"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
