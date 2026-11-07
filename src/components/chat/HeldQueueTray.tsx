import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Pencil, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import type { HeldQueue } from "@/types/events";
import type { HeldQueueChange } from "@/lib/heldQueue";
import { usePromptTextProps } from "@/lib/autocorrect";

export function HeldQueueTray({ queue, onChange, disabled, busy }: {
  queue: HeldQueue;
  onChange(change: HeldQueueChange): Promise<void>;
  disabled?: boolean;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const textProps = usePromptTextProps();
  if (!queue.items.length && !queue.paused && !queue.error) return null;
  const locked = disabled || pending || !!queue.sending;
  const change = async (action: HeldQueueChange) => {
    if (locked) return false;
    setPending(true);
    setError(null);
    try {
      await onChange(action);
      if (action.type === "edit" || action.type === "delete") setEditing(null);
      return true;
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "Could not update the queue. Try again.");
      return false;
    } finally { setPending(false); }
  };
  return <section aria-label="Held follow-ups" className="mb-2 rounded-lg border border-hairline bg-well text-xs">
    <div className="flex items-center gap-2 px-3 py-2">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium">
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {queue.items.length} held follow-up{queue.items.length === 1 ? "" : "s"}{queue.paused ? " · Paused" : ""}
      </button>
      <Button size="xs" variant="ghost" disabled={locked} onClick={() => void change({ type: "pause", paused: !queue.paused })}>
        {queue.paused ? "Resume" : "Pause queue"}
      </Button>
      {!busy && !queue.paused && queue.items.length > 0 && <Button size="xs" variant="outline" disabled={locked} onClick={() => void change({ type: "pause", paused: false })}>Send next</Button>}
    </div>
    {expanded && <>
      <p className="px-3 pb-2 text-faint">Held messages are not read mid-turn. One goes after each finished turn.</p>
      <ol className="max-h-64 overflow-y-auto px-2 pb-2">
        {queue.items.map((item, index) => <li key={item.id} className="rounded-md border-t border-hairline p-2"
          onDragOver={e => { if (dragging && !locked) e.preventDefault(); }}
          onDrop={e => { e.preventDefault(); if (dragging && dragging !== item.id) void change({ type: "move", id: dragging, beforeId: item.id }); setDragging(null); }}>
          <div className="flex items-start gap-2">
            <button type="button" aria-label={`Drag follow-up ${index + 1}`} title="Drag to reorder" disabled={locked}
              draggable={!locked} onDragStart={e => { setDragging(item.id); e.dataTransfer.setData("text/plain", item.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => setDragging(null)} className="mt-0.5 cursor-grab text-faint"><GripVertical className="size-3.5" /></button>
            <div className="min-w-0 flex-1">
              {editing?.id === item.id ? <>
                <textarea {...textProps} aria-label="Edit held follow-up" value={editing.text} onChange={e => setEditing({ id: item.id, text: e.target.value })}
                  disabled={locked} className="min-h-16 w-full resize-y rounded border border-hairline bg-background p-2 text-sm" />
                <div className="mt-1 flex gap-1">
                  <Button size="xs" disabled={locked || (!editing.text.trim() && !item.images.length)} onClick={() => void change({ type: "edit", id: item.id, text: editing.text })}>Save</Button>
                  <Button size="xs" variant="ghost" disabled={pending} onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </> : <p className="whitespace-pre-wrap break-words text-sm">{item.text || "Image attachment"}</p>}
              {item.images.length > 0 && <p className="mt-1 text-faint">{item.images.map(image => image.name ?? "Image").join(", ")}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Button size="xs" variant="ghost" disabled={locked || editing?.id === item.id} onClick={() => void change({ type: "sendNow", id: item.id })}>Send now</Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Edit follow-up ${index + 1}`} title="Edit (pauses the queue)" disabled={locked} onClick={() => void change({ type: "pause", paused: true }).then(saved => { if (saved) setEditing({ id: item.id, text: item.text }); })}><Pencil /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Delete follow-up ${index + 1}`} disabled={locked} onClick={() => void change({ type: "delete", id: item.id })}><Trash2 /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Move follow-up ${index + 1} up`} disabled={locked || index === 0} onClick={() => void change({ type: "move", id: item.id, beforeId: queue.items[index - 1].id })}><ArrowUp /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Move follow-up ${index + 1} down`} disabled={locked || index === queue.items.length - 1} onClick={() => void change({ type: "move", id: item.id, beforeId: queue.items[index + 2]?.id ?? null })}><ArrowDown /></Button>
              </div>
            </div>
          </div>
        </li>)}
        <li aria-hidden className="h-2" onDragOver={e => { if (dragging && !locked) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragging) void change({ type: "move", id: dragging, beforeId: null }); setDragging(null); }} />
      </ol>
    </>}
    {(error || queue.error) && <p role="alert" className="px-3 pb-2 text-destructive">{error || queue.error}</p>}
  </section>;
}
