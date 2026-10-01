import { useEffect, useReducer, useState } from "react";
import { Keyboard, Lock, StickyNote, Users, X } from "lucide-react";
import type { WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import { leaseHeldBy, leaseLive, type TabLease } from "@terminalx/portable/workspaceCollab";
import { Button } from "@/components/ui/button";
import { acquireLease, canDrive, loadNotes, postNote, releaseLease, sharingKnown, takeOverLease, useCollab } from "@/lib/cloudCollab";
import { initials, usePeople } from "@/lib/cloudPeople";
import { cn } from "@/lib/cn";

const ROLE_BADGE: Record<string, string> = { manager: "Admin", driver: "Driver", viewer: "Viewer", none: "No access" };

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return error instanceof Error ? error.message : String(error);
}

/** The current time, re-rendered once `until` passes (a lease expiring). */
export function useNowUntil(until: number | null | undefined): number {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const timer = setTimeout(tick, Math.min(until - Date.now() + 5, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [until]);
  return now;
}

/** Who else is in the workspace, what they look at, and whether they are typing. */
export function ParticipantsBar({ collabKey, you, tabLabel }: { collabKey: string; you: WorkspaceYou | null; tabLabel: (tabId: string) => string | null }) {
  const collab = useCollab(collabKey);
  const nameOf = usePeople();
  if (!collab.available || !collab.participants.length) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-testid="cloud-participants" aria-label="People in this workspace">
      <Users className="size-3.5 shrink-0 text-muted-foreground" />
      {collab.participants.map((person) => {
        const self = person.userId === you?.userId;
        const name = self ? "You" : nameOf(person.userId);
        const where = person.tabId ? tabLabel(person.tabId) : null;
        const typing = person.activity === "typing";
        return (
          <span
            key={person.userId}
            className="inline-flex items-center gap-1 rounded-full border border-hairline py-0.5 pl-0.5 pr-2 text-[11px]"
            data-testid="cloud-participant"
            title={`${name} · ${ROLE_BADGE[person.role] ?? person.role}${person.canApprove ? " · can approve" : ""}${person.surfaces > 1 ? ` · ${person.surfaces} windows` : ""}${where ? ` · on ${where}` : ""}`}
          >
            <span className={cn("flex size-5 items-center justify-center rounded-full bg-well text-[9px] font-medium", typing && "ring-1 ring-accent")}>
              {initials(nameOf(person.userId))}
            </span>
            <span className="max-w-24 truncate">{name}</span>
            <span className="rounded bg-well px-1 text-[10px] text-muted-foreground">{ROLE_BADGE[person.role] ?? person.role}</span>
            {person.surfaces > 1 && <span className="text-faint">×{person.surfaces}</span>}
            {where && <span className="max-w-28 truncate text-muted-foreground">on {where}</span>}
            {typing && (
              <span className="inline-flex items-center gap-0.5 text-accent" data-testid="cloud-participant-typing">
                <Keyboard className="size-3" /> typing
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** At most this many faces in a session header; the rest are counted. */
const HEADER_FACES = 3;

/**
 * Who else is in a shared workspace, compact enough for a session header:
 * initials (ringed while typing), with the details in the tooltip.
 */
export function PresenceAvatars({ collabKey, you, tabLabel }: { collabKey: string; you: WorkspaceYou | null; tabLabel?: (tabId: string) => string | null }) {
  const collab = useCollab(collabKey);
  const nameOf = usePeople();
  const others = collab.participants.filter((person) => person.userId !== you?.userId);
  if (!collab.available || !others.length) return null;
  const shown = others.slice(0, HEADER_FACES);
  const describe = (person: (typeof others)[number]) => {
    const where = person.tabId && tabLabel ? tabLabel(person.tabId) : null;
    return `${nameOf(person.userId)} · ${ROLE_BADGE[person.role] ?? person.role}${person.activity === "typing" ? " · typing" : ""}${where ? ` · on ${where}` : ""}`;
  };
  return (
    <span className="ml-1 flex shrink-0 items-center -space-x-1" data-testid="session-presence" aria-label={`Also here: ${others.map((person) => nameOf(person.userId)).join(", ")}`}>
      {shown.map((person) => (
        <span
          key={person.userId}
          className={cn(
            "flex size-5 items-center justify-center rounded-full border border-background bg-well text-[9px] font-medium text-foreground",
            person.activity === "typing" && "ring-1 ring-accent",
          )}
          title={describe(person)}
          data-testid="session-presence-person"
        >
          {initials(nameOf(person.userId))}
        </span>
      ))}
      {others.length > shown.length && (
        <span className="flex h-5 items-center rounded-full border border-background bg-well px-1 text-[9px] text-muted-foreground" title={others.slice(HEADER_FACES).map(describe).join("\n")}>
          +{others.length - shown.length}
        </span>
      )}
    </span>
  );
}

/**
 * The lock chip of a shared workspace this person may only read, or is not
 * shared with (PRO-23 view-only rule). Nothing when sharing is unknown.
 */
export function AccessChip({ you, className }: { you: WorkspaceYou | null; className?: string }) {
  if (!sharingKnown(you) || (you.role !== "viewer" && you.role !== "none")) return null;
  const viewer = you.role === "viewer";
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1 rounded-sm bg-veil-raised px-1 text-[10px] text-muted-foreground", className)}
      title={viewer ? "Shared with you as a viewer: you can read it; ask an admin for driver access to send or type." : "Not shared with you: ask an organization admin or its creator to share it."}
      data-testid="cloud-access-chip"
    >
      <Lock className="size-2.5" />
      {viewer ? "View only" : "Not shared"}
    </span>
  );
}

/**
 * A sidebar row's sharing state (saas contract §21.2, from the workspace
 * list): the lock chip for a viewer or someone it is not shared with, else
 * how many people it is shared with. Nothing on an older server.
 */
export function ShareBadge({ you, sharedWith, className }: { you?: { role: WorkspaceYou["role"]; canApprove: boolean } | null; sharedWith?: number | null; className?: string }) {
  if (!you) return null;
  if (you.role === "viewer" || you.role === "none") return <AccessChip you={{ userId: "", ...you }} className={className} />;
  if (!sharedWith) return null;
  return (
    <span
      className={cn("flex shrink-0 items-center gap-0.5 text-[10px] text-faint", className)}
      title={`Shared with ${sharedWith} ${sharedWith === 1 ? "person" : "people"}`}
      data-testid="cloud-share-badge"
    >
      <Users className="size-2.5" />
      {sharedWith}
    </span>
  );
}

/** Explains an empty workspace to someone it was not shared with. */
export function NotSharedNotice() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-xs text-muted-foreground" data-testid="cloud-not-shared">
      <Lock className="size-4" />
      <p className="text-sm text-foreground">This workspace has not been shared with you</p>
      <p>You can see that it exists, but not its agent tabs, terminals or files. Ask an organization admin or its creator to share it with you.</p>
    </div>
  );
}

/** Who drives an agent tab, and the controls to take, release or take over the wheel. */
export function LeaseBar({
  collabKey,
  client,
  tabId,
  lease,
  turnRunning,
  you,
  notesOpen,
  onToggleNotes,
  noteCount,
}: {
  collabKey: string;
  client: WorkspaceRpcClient;
  tabId: string;
  lease: TabLease | null;
  /** The runtime keeps a lease while its turn runs, past `expiresAt`. */
  turnRunning: boolean;
  you: WorkspaceYou | null;
  notesOpen: boolean;
  onToggleNotes: () => void;
  noteCount: number;
}) {
  const nameOf = usePeople();
  const now = useNowUntil(lease?.expiresAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = leaseLive(lease, now) || (lease && turnRunning) ? lease : null;
  const mine = !!live && live.holderId === you?.userId;
  const driver = canDrive(you);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      const held = leaseHeldBy(e);
      const code = codeOf(e);
      setError(
        held
          ? `${nameOf(held.holderId)} is driving this tab.`
          : code === "lease_cooldown"
            ? "You drove this tab moments ago; others get the first chance. Try again in two minutes."
            : `Could not change who drives this tab (${code}).`,
      );
    } finally {
      setBusy(false);
    }
  };

  let text: string;
  if (mine) text = "You are driving";
  else if (live) text = `Driving: ${nameOf(live.holderId)}`;
  else text = "No one is driving";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1 text-xs" data-testid="cloud-agent-lease">
      <span className={cn(live && !mine ? "text-foreground" : "text-muted-foreground")} data-testid="cloud-agent-driver">
        {text}
      </span>
      {driver && !live && (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(() => acquireLease(collabKey, client, tabId))}>
          Take the wheel
        </Button>
      )}
      {mine && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run(() => releaseLease(collabKey, client, tabId))}>
          Release
        </Button>
      )}
      {live && !mine && you?.role === "manager" && (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(() => takeOverLease(collabKey, client, tabId))}>
          Take over
        </Button>
      )}
      {error && <span className="text-destructive">{error}</span>}
      <Button
        size="xs"
        variant={notesOpen ? "secondary" : "ghost"}
        className="ml-auto"
        aria-pressed={notesOpen}
        aria-label="Notes"
        onClick={onToggleNotes}
      >
        <StickyNote className="size-3" /> Notes{noteCount ? ` (${noteCount})` : ""}
      </Button>
    </div>
  );
}

/**
 * Notes between the people on a workspace, per agent tab. Kept apart from
 * the agent's conversation: a note never reaches the agent.
 */
export function NotesPanel({ collabKey, client, tabId, onClose }: { collabKey: string; client: WorkspaceRpcClient; tabId: string; onClose: () => void }) {
  const collab = useCollab(collabKey);
  const nameOf = usePeople();
  const tabNotes = collab.notes[tabId];
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadNotes(collabKey, client, tabId).catch((e: unknown) => setError(`Could not load notes (${codeOf(e)}).`));
  }, [collabKey, client, tabId]);

  const post = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await postNote(collabKey, client, tabId, text);
      setText("");
    } catch (e) {
      setError(`The note was not posted (${codeOf(e)}).`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-hairline bg-well/40" data-testid="cloud-agent-notes" aria-label="Notes for teammates">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-1.5 text-xs">
        <StickyNote className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Notes</span>
        <span className="text-faint">for people, not the agent</span>
        <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label="Close notes" onClick={onClose}>
          <X />
        </Button>
      </div>
      <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2 text-xs">
        {!tabNotes?.loaded && !tabNotes?.notes.length && <li className="text-muted-foreground">Loading notes…</li>}
        {tabNotes?.loaded && !tabNotes.notes.length && <li className="text-muted-foreground">No notes on this tab yet.</li>}
        {tabNotes?.notes.map((note) => (
          <li key={note.id} className="flex flex-col gap-0.5" data-testid="cloud-note">
            <span className="text-[11px] text-muted-foreground">
              <span className="text-foreground">{note.authorId === collab.you?.userId ? "You" : nameOf(note.authorId)}</span> ·{" "}
              {new Date(note.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="whitespace-pre-wrap break-words">{note.text}</span>
          </li>
        ))}
      </ol>
      <form
        className="flex flex-col gap-1.5 border-t border-hairline p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void post();
        }}
      >
        <textarea
          aria-label="Note for teammates"
          className="min-h-14 resize-none rounded-md border border-hairline bg-transparent px-2 py-1 text-xs outline-none placeholder:text-faint"
          placeholder="Add a note for teammates (not sent to the agent)"
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <span className="text-xs text-destructive">{error}</span>}
        <Button size="xs" type="submit" disabled={busy || !text.trim()} className="self-end">
          Post note
        </Button>
      </form>
    </aside>
  );
}
