import { createContext, useContext, useRef, type CSSProperties, type ReactNode } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type Announcements, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "@/icons";
import { usePrefs } from "@/lib/prefs";
import { saveSidebarOrder, useSidebarOrder } from "@/lib/sidebarOrder";

export interface SidebarSortItem { id: string; name: string; members?: string[] }
const Items = createContext<SidebarSortItem[]>([]);

/** A sortable scope never moves a session into another project or branch. */
export function SidebarSortList({ items, kind = "sessions", children }: { items: SidebarSortItem[]; kind?: "sessions" | "projects"; children: ReactNode }) {
  const order = useSidebarOrder();
  const latest = useRef(items);
  latest.current = items;
  // Move by row, not pixels: handles variable-height project groups and gives
  // every arrow press exactly one step, including Left/Right for VoiceOver.
  const coordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
    const step = ["ArrowDown", "ArrowRight"].includes(event.code) ? 1 : ["ArrowUp", "ArrowLeft"].includes(event.code) ? -1 : 0;
    if (!step || !context.active) return;
    event.preventDefault();
    const rows = latest.current;
    const at = rows.findIndex((item) => item.id === (context.over?.id ?? context.active!.id));
    const next = rows[at + step];
    if (!next) return currentCoordinates;
    const rect = context.droppableRects.get(next.id);
    const active = context.collisionRect;
    if (!rect || !active) return currentCoordinates;
    return { x: currentCoordinates.x, y: currentCoordinates.y + rect.top + rect.height / 2 - active.top - active.height / 2 };
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: coordinates, keyboardCodes: { start: ["Space"], end: ["Space"], cancel: ["Escape", "Tab"] }, scrollBehavior: "auto" }));
  const description = (id: string | number, over = id) => {
    const rows = latest.current;
    return `${rows.find((item) => item.id === id)?.name ?? "row"}. Position ${rows.findIndex((item) => item.id === over) + 1} of ${rows.length}.`;
  };
  const announced = useRef<string | number | null>(null);
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      announced.current = active.id;
      return `Picked up ${description(active.id)}`;
    },
    onDragOver: ({ active, over }) => {
      if (announced.current === (over?.id ?? null)) return;
      announced.current = over?.id ?? null;
      return over ? `Moved ${description(active.id, over.id)}` : "Outside the list. Drop to cancel.";
    },
    onDragEnd: ({ active, over }) => over ? `Dropped ${description(active.id, over.id)}` : `Cancelled. ${description(active.id)}`,
    onDragCancel: ({ active }) => `Cancelled. ${description(active.id)}`,
  };
  return (
    <Items.Provider value={order.custom ? items : []}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} accessibility={{ announcements, screenReaderInstructions: { draggable: "To reorder, press Space to pick up. Use the arrow keys to move, Space to drop, or Escape to cancel." } }} onDragEnd={({ active, over }) => {
        if (!order.custom || !over || active.id === over.id) return;
        const from = items.findIndex((item) => item.id === active.id);
        const to = items.findIndex((item) => item.id === over.id);
        if (from < 0 || to < 0) return;
        void saveSidebarOrder({ [kind]: arrayMove(items, from, to).flatMap((item) => item.members ?? [item.id]) });
      }}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>{children}</SortableContext>
      </DndContext>
    </Items.Provider>
  );
}

export function useSidebarSortable(id: string) {
  const items = useContext(Items);
  const item = items.find((item) => item.id === id);
  const { animations } = usePrefs();
  const sortable = useSortable({ id, disabled: !item, transition: animations ? undefined : null });
  const style: CSSProperties = { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition, position: "relative", zIndex: sortable.isDragging ? 10 : undefined };
  const handle = item ? (
    <button type="button" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners}
      aria-label={`Reorder ${item.name}`} title="Drag to reorder, or press Space"
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      className="flex size-5 shrink-0 touch-none cursor-grab items-center justify-center rounded-sm text-faint hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing">
      <GripVertical className="size-3" />
    </button>
  ) : null;
  return { ref: sortable.setNodeRef, style, handle };
}

/** Several visible rows represent one branch; move their whole block together. */
export function SidebarSortGroup({ id, children }: { id: string; children: ReactNode }) {
  const sort = useSidebarSortable(id);
  return <li ref={sort.ref} style={sort.style} className="flex items-start">
    {sort.handle && <div className="pt-1.5">{sort.handle}</div>}
    <ul className="min-w-0 flex-1">{children}</ul>
  </li>;
}

export function SidebarOrderError() {
  const { error } = useSidebarOrder();
  return error ? <div role="alert" className="px-2 py-1 text-xs text-destructive">{error}</div> : null;
}
