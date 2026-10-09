import { useEffect, useRef, useState } from "react";
import { FolderGit2, FolderOpen, LoaderCircle } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage, type QuickChatScratch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { closeMoveToProject, closeRenameSession, useDialogs } from "@/lib/dialogs";
import { moveQuickChatToProject, renameSession, useSessionStore } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

/**
 * Dialogs about one session that any window can open: rename, and moving a
 * quick chat into a project. Mounted once per window, beside the other
 * app-level dialogs.
 */
export function SessionDialogs() {
  const dialogs = useDialogs();
  const sessions = useSessionStore().sessions;
  const renaming = sessions.find((session) => session.id === dialogs.renameSession);
  const moving = sessions.find((session) => session.id === dialogs.moveToProject);
  return (
    <>
      {renaming && <RenameSessionDialog key={renaming.id} session={renaming} onClose={closeRenameSession} />}
      {moving && <MoveToProjectDialog key={moving.id} session={moving} onClose={closeMoveToProject} />}
    </>
  );
}

function RenameSessionDialog({ session, onClose }: { session: SessionEntry; onClose: () => void }) {
  const [title, setTitle] = useState(session.title);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  const wanted = title.trim();
  const save = async () => {
    if (!wanted || saving) return;
    if (wanted === session.title) return onClose();
    setSaving(true);
    setError(null);
    try {
      await renameSession(session.id, wanted);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[26rem]" onEscapeKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Rename session</DialogTitle>
          <DialogDescription className="sr-only">Give the session another title.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            ref={input}
            aria-label="Session title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-border bg-well px-2.5 py-1.5 text-sm outline-none focus:border-ring"
          />
          {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!wanted || saving}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Turn a quick chat into an ordinary session of a project. The session, its
 * tabs and its history stay; what changes is where it runs and where it is
 * listed. Its agents are stopped and resume in the project when next opened.
 */
function MoveToProjectDialog({ session, onClose }: { session: SessionEntry; onClose: () => void }) {
  const projects = useSessionStore().projects.filter((project) => !project.archived);
  const [target, setTarget] = useState<string | null>(projects[0]?.path ?? null);
  /** A folder picked here that is not a project yet; moving adds it. */
  const [picked, setPicked] = useState<string | null>(null);
  const [scratch, setScratch] = useState<QuickChatScratch | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = session.tabs.some((tab) => tab.status === "in_progress" || tab.status === "waiting");

  useEffect(() => {
    let cancelled = false;
    api.quickChatScratch(session.id).then((found) => !cancelled && setScratch(found)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const pick = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "Choose a project" });
      if (typeof dir === "string") {
        setPicked(dir);
        setTarget(dir);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const move = async () => {
    if (!target || moving) return;
    setMoving(true);
    setError(null);
    try {
      await moveQuickChatToProject(session.id, target);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setMoving(false);
    }
  };

  const choice = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-veil-strong focus-visible:ring-2 focus-visible:ring-ring/40";
  return (
    <Dialog open onOpenChange={(open) => !open && !moving && onClose()}>
      <DialogContent width="max-w-[30rem]" className="max-h-[calc(100vh-2rem)] overflow-y-auto" onEscapeKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Move to project</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            “{session.title}” becomes a session of the project, with its tabs and its history. It runs in the project’s folder from then on.
          </DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="Project" className="max-h-56 overflow-y-auto rounded-lg bg-well p-1">
          {projects.map((project) => (
            <button
              key={project.path}
              type="button"
              role="radio"
              aria-checked={target === project.path}
              onClick={() => setTarget(project.path)}
              className={cn(choice, target === project.path && "bg-veil-strong text-foreground")}
            >
              {project.kind === "folder" ? <FolderOpen className="size-4 shrink-0" /> : <FolderGit2 className="size-4 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="min-w-0 max-w-[55%] truncate font-mono text-[11px] text-faint" title={project.path}>{project.path}</span>
            </button>
          ))}
          {picked && !projects.some((project) => project.path === picked) && (
            <button type="button" role="radio" aria-checked={target === picked} onClick={() => setTarget(picked)} className={cn(choice, target === picked && "bg-veil-strong text-foreground")}>
              <FolderOpen className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={picked}>{picked}</span>
              <span className="shrink-0 text-[11px] text-faint">added as a project</span>
            </button>
          )}
          {projects.length === 0 && !picked && <p className="px-2 py-1.5 text-xs text-muted-foreground">No projects yet. Add one to move this chat into it.</p>}
        </div>
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => void pick()} disabled={moving}>
          <FolderOpen /> Add a project…
        </Button>
        {running && <p role="status" className="mt-3 text-xs text-warning">An agent is working in this chat. Moving stops it; it resumes the same conversation in the project when you open the tab.</p>}
        {!running && session.tabs.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Its agents restart in the project and resume the same conversation. If an agent cannot resume there, the history stays in the tab and “Continue in New Session…” carries it on.
          </p>
        )}
        {scratch && scratch.files > 0 && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="move-scratch-note">
            Its scratch folder holds {scratch.files}{scratch.more ? " or more" : ""} file{scratch.files === 1 && !scratch.more ? "" : "s"}. {scratch.files === 1 && !scratch.more ? "It stays" : "They stay"} in <span className="break-all font-mono">{scratch.path}</span> until the session is deleted; they are not copied into the project.
          </p>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={moving}>Cancel</Button>
          <Button onClick={() => void move()} disabled={!target || moving}>
            {moving ? <><LoaderCircle className="size-4 animate-spin" />Moving…</> : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
