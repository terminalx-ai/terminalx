import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FileText, GripVertical, Image, Pause, Pencil, Play, Send, Undo2, X } from "@/icons";
import { Button } from "@/components/ui/button";
import type { HeldFollowUp, HeldQueue } from "@/types/events";
import type { HeldQueueChange } from "@/lib/heldQueue";
import { usePromptTextProps } from "@/lib/autocorrect";
import { chordOf, isMac } from "@/lib/shortcuts";
import { cn } from "@/lib/cn";
import { dismissErrorKey, showError } from "@/lib/errorToasts";

const ORDINALS = ["1st", "2nd", "3rd"];
export const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`;

/** A held message named in a toast: its words, cut short, or what is attached. */
function quoted(item: HeldFollowUp | undefined): string {
  const text = item?.text.trim().split("\n")[0] ?? "";
  const name = text || (item?.images.length ? "Image attachment" : "Attached files");
  return `“${name.length > 60 ? `${name.slice(0, 59)}…` : name}”`;
}

/**
 * What a failed change says (PRO-380, design 03.21): which action failed as
 * the title, and what state the queue is in now as the body. The agent's own
 * line follows it.
 */
function failure(change: HeldQueueChange, queue: HeldQueue): { title: string; state: string } {
  const index = "id" in change ? queue.items.findIndex(item => item.id === change.id) : -1;
  const item = queue.items[index];
  switch (change.type) {
    case "move": return { title: "Couldn't reorder held messages", state: `${quoted(item)} went back to ${ordinal(index + 1)}` };
    case "pause": return change.paused
      ? { title: "Couldn't pause the held messages", state: "They still go out one after each turn" }
      : { title: "Couldn't resume the held messages", state: "They're still paused and in the same order" };
    case "edit": return { title: "Couldn't save the held message", state: `${quoted(item)} still reads as it did` };
    case "delete": return { title: "Couldn't delete the held message", state: `${quoted(item)} is still held` };
    case "sendNow": return { title: "Couldn't send the held message now", state: `${quoted(item)} is still held in its place` };
    case "enqueue": return { title: "Couldn't hold the message", state: "It was not added to the queue" };
  }
}

/**
 * A failed change as it is tried again on `queue` as it is now: a move goes to
 * the same position (`target`), and one about a message that is no longer
 * held cannot be tried at all.
 */
export function againNow(action: HeldQueueChange, target: number, queue: HeldQueue): HeldQueueChange {
  if (!("id" in action)) return action;
  if (!queue.items.some(item => item.id === action.id)) throw new Error("That message is no longer held.");
  if (action.type !== "move") return action;
  const others = queue.items.filter(item => item.id !== action.id);
  return { ...action, beforeId: others[target]?.id ?? null };
}

/**
 * The follow-ups held until the agent's turn ends (PRO-380, design 03.12):
 * one card above the composer, a one-line row each. Editing one keeps the
 * queue running; a change that fails is said in a toast with Try again.
 */
export function HeldQueueTray({ queue, onChange, disabled, busy, scope = "held", unavailable, row }: {
  queue: HeldQueue;
  onChange(change: HeldQueueChange): Promise<void>;
  disabled?: boolean;
  busy: boolean;
  /** Keeps one tab's failure toasts apart from another's: the tab's id. */
  scope?: string;
  /**
   * What this queue cannot do, and why (#1328: a cloud or machine runtime
   * holds its follow-ups in the order they were sent, and never pauses
   * them). Those controls are shown disabled with the reason.
   */
  unavailable?: { move?: string; pause?: string };
  /** Who sent a held message, and why this person may not change it, where that applies (a shared workspace). */
  row?: (id: string) => { author?: string | null; locked?: string | null } | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  /** The row whose move failed and went back to where it was. */
  const [movedBack, setMovedBack] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /** The row last edited: its Edit button takes focus back once the editor closes (the row is drawn anew). */
  const lastEdited = useRef<string | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const changing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // In the commit that adds or removes the editor: an effect can run a task
  // later (when the edit closes after an await), leaving focus on <body>.
  useLayoutEffect(() => {
    if (editing) editor.current?.focus();
    else if (lastEdited.current) section.current?.querySelector<HTMLButtonElement>(`[data-edit-held="${CSS.escape(lastEdited.current)}"]`)?.focus();
  }, [editing?.id]);
  // The queue keeps running while a message is edited: one that went out first cannot be changed any more.
  const editedGone = !!editing && !queue.items.some(item => item.id === editing.id);
  useEffect(() => {
    if (!editedGone) return;
    showError("It went to the agent before the edit was saved, as it was", undefined, { title: "Couldn't save the held message", key: `${scope}:edit`, copy: false });
    setEditing(null);
  }, [editedGone]);
  const textProps = usePromptTextProps();
  const locked = disabled || pending || !!queue.sending;
  // A toast's Try again runs after this render: it reads the queue and what blocks a change as they are then.
  // A change under way is `changing`, set and cleared at once; `pending` follows it a render later.
  const latest = useRef({ queue, blocked: disabled || !!queue.sending });
  latest.current = { queue, blocked: disabled || !!queue.sending };
  /** `retry`: from a toast's Try again, which says why it cannot run rather than doing nothing. */
  const change = async (action: HeldQueueChange, retry = false): Promise<boolean> => {
    if (latest.current.blocked || changing.current) {
      if (retry) throw new Error("The held messages are changing. Try again in a moment.");
      return false;
    }
    const queue = latest.current.queue;
    changing.current = true;
    setPending(true);
    setAnnouncement("");
    const said = failure(action, queue);
    const key = `${scope}:${action.type === "pause" ? (action.paused ? "pause" : "resume") : action.type}`;
    try {
      await onChange(action);
      dismissErrorKey(key);
      // The row that went back stays marked until a move works.
      if (action.type === "move") setMovedBack(null);
      if (action.type === "delete") setAnnouncement("Deleted held follow-up.");
      if (action.type === "move") {
        const others = queue.items.filter(item => item.id !== action.id);
        const position = action.beforeId ? others.findIndex(item => item.id === action.beforeId) + 1 : queue.items.length;
        setAnnouncement(`Moved held follow-up to position ${position}.`);
      }
      return true;
    } catch (cause) {
      if (action.type === "move") setMovedBack(action.id);
      // A move is tried again to the same place in the queue as it is by then, not before a row that moved since.
      const others = queue.items.filter(item => item.id !== ("id" in action ? action.id : null));
      const target = action.type === "move" ? (action.beforeId ? others.findIndex(item => item.id === action.beforeId) : others.length) : -1;
      showError(said.state, cause, {
        title: said.title,
        key,
        actions: [{
          label: "Try again",
          icon: "retry",
          run: async () => {
            const again = againNow(action, target, latest.current.queue);
            // The tray has gone (its tab closed): nothing else here changes the queue.
            if (!mounted.current) return onChange(again);
            return change(again, true);
          },
        }],
      });
      return false;
    } finally {
      changing.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const finishEdit = async (save: boolean, sendNow = false) => {
    if (!editing || locked || changing.current) return;
    const item = queue.items.find(item => item.id === editing.id);
    if (save && (!item || (!editing.text.trim() && !item.images.length && !item.files?.length))) return;
    if (save && editing.text !== item!.text && !await change({ type: "edit", id: editing.id, text: editing.text })) return;
    setEditing(null);
    if (sendNow) await change({ type: "sendNow", id: editing.id });
  };
  const moveOff = unavailable?.move ?? null;
  const pauseOff = unavailable?.pause ?? null;
  const move = (id: string, beforeId: string | null) => { if (!moveOff) void change({ type: "move", id, beforeId }); };
  const count = queue.items.length;
  const headerButton = "flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11.5px] font-normal normal-case tracking-normal text-muted-foreground hover:bg-veil-strong hover:text-foreground disabled:opacity-50";
  return <>
    <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    {(count > 0 || queue.error) && <section ref={section} aria-label="Held follow-ups" className="mb-2 grid gap-1.5 rounded-xl bg-card/80 p-2 text-xs hairline" data-held-tray="">
    <div className="flex min-h-6 items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">
      <span className="min-w-0 truncate">Held until the turn ends · {count}</span>
      {queue.paused && <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-veil-strong px-1.5 text-[11px] font-normal normal-case tracking-normal text-muted-foreground" data-testid="held-paused">
        <Pause aria-hidden className="size-2.5" />Paused
      </span>}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {!busy && !queue.paused && !pauseOff && count > 0 && <button type="button" className={headerButton} disabled={locked || !!editing} onClick={() => void change({ type: "pause", paused: false })}>
          <Send aria-hidden className="size-3" />Send next
        </button>}
        {queue.paused
          ? <button type="button" disabled={locked} onClick={() => void change({ type: "pause", paused: false })}
              className={cn(headerButton, "px-2.5 text-foreground ring-1 ring-accent/50 hover:ring-accent")}>
              <Play aria-hidden className="size-3" />Resume
            </button>
          : <button type="button" disabled={locked || !!pauseOff} title={pauseOff ?? undefined} onClick={() => void change({ type: "pause", paused: true })} className={headerButton}>
              <Pause aria-hidden className="size-3" />Pause queue
            </button>}
        <button type="button" aria-expanded={expanded} aria-label={expanded ? "Hide held follow-ups" : "Show held follow-ups"}
          onClick={() => setExpanded(!expanded)} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-veil-strong hover:text-foreground">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
      </span>
    </div>
    {expanded && count > 0 && <ol className="grid max-h-[40vh] gap-1.5 overflow-y-auto">
      {queue.items.map((item, index) => {
        const attachments = [...item.images.map(image => ({ name: image.name ?? "Image", image: true })), ...(item.files ?? []).map(file => ({ name: file.name, image: false }))];
        const about = row?.(item.id);
        const rowLocked = locked || !!about?.locked;
        const drop = {
          onDragOver: (e: React.DragEvent) => { if (dragging && !locked) e.preventDefault(); },
          onDrop: (e: React.DragEvent) => { e.preventDefault(); if (dragging && dragging !== item.id) move(dragging, item.id); setDragging(null); },
        };
        if (editing?.id === item.id) {
          const empty = !editing.text.trim() && !attachments.length;
          return <li key={item.id} {...drop} className="grid gap-2 rounded-md border border-accent/50 bg-card p-2" data-testid="held-editor" data-owns-escape="">
            <div className="flex items-center gap-2 text-[11px] text-accent"><Pencil aria-hidden className="size-[11px]" />Editing held message {index + 1}</div>
            <textarea {...textProps} ref={editor} aria-label="Edit held follow-up" value={editing.text} rows={Math.min(6, editing.text.split("\n").length)}
              onChange={e => setEditing({ ...editing, text: e.target.value })}
              onKeyDown={e => {
                if (e.nativeEvent.isComposing) return;
                const chord = chordOf(e.nativeEvent);
                if (e.key === "Escape" || chord === "mod+enter" || (e.key === "Enter" && !e.shiftKey && !e.altKey)) {
                  e.preventDefault(); e.stopPropagation();
                  if (e.key === "Escape") void finishEdit(false);
                  else void finishEdit(true, chord === "mod+enter");
                }
              }}
              disabled={locked} className="w-full resize-none bg-transparent px-1 text-[12.5px] leading-5 outline-none" />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <EditButton label="Cancel" keycap="esc" shortcut="Escape" disabled={locked} onClick={() => void finishEdit(false)} />
              <EditButton label="Save" keycap="↵" shortcut="Enter" outline disabled={locked || empty} onClick={() => void finishEdit(true)} />
              <EditButton label="Save and send now" keycap={isMac ? "⌘↵" : "Ctrl+↵"} shortcut={isMac ? "Meta+Enter" : "Control+Enter"} primary disabled={locked || empty} onClick={() => void finishEdit(true, true)} />
            </div>
          </li>;
        }
        const wentBack = movedBack === item.id;
        return <li key={item.id} {...drop}
          onKeyDown={e => {
            // The rows reorder from the keyboard too: Alt+Up and Alt+Down, as a list in the sidebar does.
            if (!e.altKey || locked || moveOff || editing || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            if (e.key === "ArrowUp" && index > 0) move(item.id, queue.items[index - 1].id);
            if (e.key === "ArrowDown" && index < count - 1) move(item.id, queue.items[index + 2]?.id ?? null);
          }}
          className={cn("group/held flex h-9 min-w-0 items-center gap-2 rounded-md bg-raised px-2 text-[12.5px]", wentBack && "ring-1 ring-warning/40")}>
          <button type="button" aria-label={`Drag follow-up ${index + 1}`} title={moveOff ?? "Drag to reorder (Alt+Up and Alt+Down from the keyboard)"} disabled={locked || !!moveOff}
            tabIndex={-1} draggable={!locked && !moveOff && !editing} onDragStart={e => { setDragging(item.id); e.dataTransfer.setData("text/plain", item.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => setDragging(null)} className="shrink-0 cursor-grab text-faint"><GripVertical className="size-[13px]" /></button>
          <span className="w-4 shrink-0 font-mono text-[11px] text-faint">{index + 1}</span>
          {about?.author && <span className="max-w-32 shrink-0 truncate text-muted-foreground" data-held-author="">{about.author}:</span>}
          <span className="min-w-0 truncate" title={item.text}>{item.text || (item.images.length ? "Image attachment" : "Attached files")}</span>
          {attachments.map((attachment, i) => <span key={i} className="inline-flex h-5 min-w-0 max-w-40 shrink-0 items-center gap-1 rounded bg-veil-strong px-1.5 text-[11px] text-muted-foreground" title={attachment.name}>
            {attachment.image ? <Image aria-hidden className="size-[11px] shrink-0" /> : <FileText aria-hidden className="size-[11px] shrink-0" />}
            <span className="truncate">{attachment.name}</span>
          </span>)}
          {wentBack && <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-warning/15 px-1.5 text-[10.5px] text-warning" data-testid="held-moved-back">
            <Undo2 aria-hidden className="size-2.5" />moved back
          </span>}
          <span className="ml-auto flex shrink-0 items-center gap-0.5 text-faint">
            <RowButton label={`Edit follow-up ${index + 1}`} title={about?.locked ?? undefined} editId={item.id} disabled={rowLocked || !!editing || queue.next === item.id} onClick={() => {
              lastEdited.current = item.id;
              setEditing({ id: item.id, text: item.text });
            }}><Pencil /></RowButton>
            <RowButton label={`Send follow-up ${index + 1} now`} title={about?.locked ?? "Send now: interrupts the turn"} disabled={rowLocked || !!editing} onClick={() => void change({ type: "sendNow", id: item.id })}><Send /></RowButton>
            <RowButton label={`Delete follow-up ${index + 1}`} title={about?.locked ?? undefined} disabled={rowLocked || !!editing} onClick={() => void change({ type: "delete", id: item.id })}><X /></RowButton>
          </span>
        </li>;
      })}
      <li aria-hidden className="-mt-1.5 h-1.5" onDragOver={e => { if (dragging && !locked) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragging) move(dragging, null); setDragging(null); }} />
    </ol>}
    {queue.error && <p role="alert" className="px-1 text-[11.5px] text-destructive">{queue.error}</p>}
    </section>}
  </>;
}

function RowButton({ label, title, editId, disabled, onClick, children }: { label: string; title?: string; editId?: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-label={label} title={title ?? label} data-edit-held={editId} disabled={disabled} onClick={onClick}
    className="grid size-6 place-items-center rounded-md hover:bg-veil-strong hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3">
    {children}
  </button>;
}

function EditButton({ label, keycap, shortcut, outline, primary, disabled, onClick }: { label: string; keycap: string; shortcut: string; outline?: boolean; primary?: boolean; disabled?: boolean; onClick: () => void }) {
  return <Button size="xs" variant="ghost" aria-label={label} aria-keyshortcuts={shortcut} disabled={disabled} onClick={onClick}
    className={cn("h-7 gap-1.5 px-2.5 text-[12px]", primary ? "bg-foreground font-medium text-background hover:bg-foreground/90 hover:text-background" : "text-muted-foreground", outline && "hairline")}>
    {label}
    <kbd className={cn("rounded px-1 font-sans text-[10.5px]", primary ? "text-background/70 ring-1 ring-background/20" : "text-faint ring-1 ring-hairline-strong")}>{keycap}</kbd>
  </Button>;
}
