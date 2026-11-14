import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { closestCenter, pointerWithin, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDndContext, useDroppable, useSensor, useSensors, type Active, type Announcements, type CollisionDetection, type KeyboardCoordinateGetter, type Over } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import { CSS, getEventCoordinates } from "@dnd-kit/utilities";
import { StatusGroups } from "./StatusGroups";
import { conversationTitle } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";
import { GripVertical } from "@/icons";
import { usePrefs } from "@/lib/prefs";
import { saveSidebarOrder, useSidebarOrder } from "@/lib/sidebarOrder";
import { editLocalSection, useLocalSections } from "@/lib/localSections";
import { reportError } from "@/lib/errorToasts";
import { cn } from "@/lib/cn";

export interface SidebarSortItem { id: string; name: string; members?: string[] }
type Kind = "sessions" | "projects";
type ListProps = { items: SidebarSortItem[]; kind?: Kind; children: ReactNode };
/** What dnd-kit carries for each draggable or droppable in a sidebar drag scope. */
type RowData = { type: "row"; kind: Kind; list: string; section: string | null; name: string; members: string[] };
type ZoneData = { type: "zone"; section: string | null; name: string };
type SectionData = { type: "section"; id: string; name: string };
type DragData = RowData | ZoneData | SectionData;
type ListEntry = { items: SidebarSortItem[]; kind: Kind; section: string | null; custom: boolean };
type ListContext = { byId: ReadonlyMap<string, SidebarSortItem>; list: string; kind: Kind; section: string | null; custom: boolean; rowDrag: boolean };
type Scope = { lists: Map<string, { current: ListEntry }>; moves: boolean };

const EMPTY_LIST: ListContext = { byId: new Map(), list: "", kind: "sessions", section: null, custom: false, rowDrag: false };
const Items = createContext<ListContext>(EMPTY_LIST);
const ScopeContext = createContext<Scope | null>(null);
const SectionContext = createContext<{ id: string; name: string } | null>(null);
const MAIN_LIST = "the main list";
const dataOf = (node: Active | Over | null | undefined) => node?.data.current as DragData | undefined;
const sectionSortId = (id: string) => `section:${id}`;
const noSorting: SortingStrategy = () => null;

/**
 * The simple layout draws its project tree beside the sections, not inside a
 * shared SidebarDragScope, so a session dragged there is in another DndContext
 * than the sections. Sections on screen register here; such a drag finds the
 * one under the pointer by its rect and moves the session into it on drop.
 */
const sectionNodes = new Map<string, { node: HTMLElement; scope: Scope["lists"] }>();
let bridged: string | null = null;
const bridgeListeners = new Set<() => void>();
function setBridged(id: string | null) {
  if (bridged === id) return;
  bridged = id;
  for (const listener of bridgeListeners) listener();
}
const subscribeBridged = (listener: () => void) => { bridgeListeners.add(listener); return () => { bridgeListeners.delete(listener); }; };
function sectionAt(scope: Scope["lists"], x: number, y: number): string | null {
  for (const [id, entry] of sectionNodes) {
    if (entry.scope === scope || !entry.node.isConnected) continue;
    const rect = entry.node.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id;
  }
  return null;
}

/** Rows rendered inside a local section: their lists drop into, and drag out of, that section. */
export function SidebarSection({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  const value = useMemo(() => ({ id, name }), [id, name]);
  return <SectionContext.Provider value={value}>{children}</SectionContext.Provider>;
}

/** Whether a SidebarDragScope is already above; local sections then join it instead of making their own. */
export const useInSidebarDragScope = () => useContext(ScopeContext) !== null;

/** Status groups retain the shared header/count/fold, each with an isolated drag scope.
 * Cloud callers use StatusGroups directly and never acquire local drag handles.
 */
export function SortableStatusGroups({ sessions, children, scope }: { sessions: SessionEntry[]; children: (session: SessionEntry) => ReactNode; scope?: string }) {
  return <StatusGroups sessions={sessions} scope={scope} renderGroup={(rows, content) =>
    <SidebarSortList items={rows.map((session) => ({ id: session.id, name: conversationTitle(session) }))}>{content}</SidebarSortList>
  }>{children}</StatusGroups>;
}

/**
 * One drag scope for the local sidebar (PRO-174): every list inside shares a
 * DndContext, so a session row can be dropped on a local section (its header,
 * its rows or its empty "Drag sessions here" target) or, with `main`, back on
 * the main list; section headers reorder the sections. Within one list a drop
 * still only reorders that list, and a drop on another list of the same
 * section (another project, branch or status group) cancels.
 * Without sections the scope behaves exactly like separate sortable lists.
 */
export function SidebarDragScope({ children, main = true, mainTarget = false, moves: allowMoves = true }: {
  children: ReactNode;
  /** The whole scope is the main list's drop zone (ChatListSidebar). */
  main?: boolean;
  /** Only the sections are inside: a "Drop here to move to the main list" target follows them while a sectioned session is held. */
  mainTarget?: boolean;
  moves?: boolean;
}) {
  const { sections } = useLocalSections();
  const moves = allowMoves && sections.length > 0;
  const lists = useRef(new Map<string, { current: ListEntry }>()).current;
  const scope = useMemo<Scope>(() => ({ lists, moves }), [lists, moves]);
  const latestSections = useRef(sections);
  latestSections.current = sections;
  const { animations } = usePrefs();
  const [active, setActive] = useState<DragData | null>(null);
  // The source list's rows when the drag began: a drop is refused if they changed meanwhile.
  const dragRows = useRef<SidebarSortItem[]>([]);
  const outcome = useRef<"reorder" | "move" | "section" | null>(null);
  const announced = useRef<string | number | null>(null);
  const rowsOf = (data: RowData | undefined) => (data ? lists.get(data.list)?.current.items : undefined) ?? [];
  const sectionName = (id: string | null) => id === null ? MAIN_LIST : latestSections.current.find((section) => section.id === id)?.name ?? "section";
  // Where a session dropped on `over` would go, when that is another section than its own.
  const moveTarget = (from: DragData | undefined, over: Over | null): string | null | undefined => {
    const to = dataOf(over);
    if (!moves || from?.type !== "row" || from.kind !== "sessions" || !to || to.type === "section") return undefined;
    if (to.type === "row" && (to.kind !== "sessions" || to.list === from.list)) return undefined;
    return to.section === from.section ? undefined : to.section;
  };
  const unchanged = (data: RowData) => {
    const before = dragRows.current;
    const now = rowsOf(data);
    return before.length === now.length && before.every((row, i) => row.id === now[i].id
      && (row.members ?? [row.id]).join("\0") === (now[i].members ?? [now[i].id]).join("\0"));
  };
  // Move by row, not pixels: handles variable-height project groups and gives
  // every arrow press exactly one step, including Left/Right for VoiceOver.
  const coordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
    const step = ["ArrowDown", "ArrowRight"].includes(event.code) ? 1 : ["ArrowUp", "ArrowLeft"].includes(event.code) ? -1 : 0;
    if (!step || !context.active) return;
    event.preventDefault();
    const data = dataOf(context.active);
    const ids = data?.type === "section" ? latestSections.current.map((section) => sectionSortId(section.id)) : rowsOf(data?.type === "row" ? data : undefined).map((item) => item.id);
    const at = ids.findIndex((id) => id === (context.over?.id ?? context.active!.id));
    const next = ids[at + step];
    if (!next) return currentCoordinates;
    const rect = context.droppableRects.get(next);
    const current = context.collisionRect;
    if (!rect || !current) return currentCoordinates;
    return { x: currentCoordinates.x, y: currentCoordinates.y + rect.top + rect.height / 2 - current.top - current.height / 2 };
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: coordinates, keyboardCodes: { start: ["Space"], end: ["Space"], cancel: ["Escape", "Tab"] }, scrollBehavior: "auto" }));
  const collisions: CollisionDetection = (args) => {
    const data = dataOf(args.active);
    const among = (keep: (target: DragData) => boolean) => args.droppableContainers.filter((container) => { const target = container.data.current as DragData | undefined; return !!target && keep(target); });
    const detect = (containers: typeof args.droppableContainers) => args.pointerCoordinates ? pointerWithin({ ...args, droppableContainers: containers }) : closestCenter({ ...args, droppableContainers: containers });
    if (!data || data.type === "zone") return detect(args.droppableContainers);
    if (data.type === "section") return detect(among((target) => target.type === "section"));
    const ownList = among((target) => target.type === "row" && target.list === data.list);
    // The keyboard stays in its own list; a pointer can also reach the other sections.
    if (!args.pointerCoordinates || !moves || data.kind !== "sessions") return detect(ownList);
    const own = detect(ownList);
    if (own.length) return own;
    const area = (id: string | number) => { const rect = args.droppableRects.get(id); return rect ? rect.width * rect.height : Infinity; };
    const rows = detect(among((target) => target.type === "row" && target.kind === "sessions")).sort((a, b) => area(a.id) - area(b.id));
    if (rows.length) return rows.slice(0, 1);
    const zones = detect(among((target) => target.type === "zone"));
    const isMain = (zone: (typeof zones)[number]) => (zone.data?.droppableContainer?.data.current as ZoneData | undefined)?.section === null;
    return zones.sort((a, b) => Number(isMain(a)) - Number(isMain(b))).slice(0, 1);
  };
  const description = (id: string | number, over = id) => {
    const rows = dragRows.current;
    return `${rows.find((item) => item.id === id)?.name ?? "row"}. Position ${rows.findIndex((item) => item.id === over) + 1} of ${rows.length}.`;
  };
  const sectionPosition = (data: SectionData, over: string | number = sectionSortId(data.id)) =>
    `section ${data.name}. Position ${latestSections.current.findIndex((section) => sectionSortId(section.id) === over) + 1} of ${latestSections.current.length}.`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      announced.current = active.id;
      const data = dataOf(active);
      return data?.type === "section" ? `Picked up ${sectionPosition(data)}` : `Picked up ${description(active.id)}`;
    },
    onDragOver: ({ active, over }) => {
      if (announced.current === (over?.id ?? null)) return;
      announced.current = over?.id ?? null;
      const data = dataOf(active);
      if (data?.type === "section") return over ? `Moved ${sectionPosition(data, over.id)}` : "Outside the sections. Drop to cancel.";
      const target = moveTarget(data, over);
      if (target !== undefined && data?.type === "row") return `Over ${sectionName(target)}. Drop to move ${data.name} there.`;
      return over && dataOf(over)?.type === "row" && (dataOf(over) as RowData).list === (data as RowData | undefined)?.list ? `Moved ${description(active.id, over.id)}` : "Outside the list. Drop to cancel.";
    },
    onDragEnd: ({ active, over }) => {
      const data = dataOf(active);
      if (data?.type === "section") return outcome.current === "section" && over ? `Dropped ${sectionPosition(data, over.id)}` : `Cancelled. ${sectionPosition(data)}`;
      if (outcome.current === "move" && data?.type === "row") return `Moved ${data.name} to ${sectionName(movedTo.current)}.`;
      return over && outcome.current === "reorder" ? `Dropped ${description(active.id, over.id)}` : `Cancelled. ${description(active.id)}`;
    },
    onDragCancel: ({ active }) => { const data = dataOf(active); return data?.type === "section" ? `Cancelled. ${sectionPosition(data)}` : `Cancelled. ${description(active.id)}`; },
  };
  const movedTo = useRef<string | null>(null);
  const moveTo = (data: RowData, target: string | null, order: string[] | null) => {
    movedTo.current = target;
    void (async () => {
      await editLocalSection({ kind: "move", sessionIds: data.members, sectionId: target });
      if (order) await saveSidebarOrder({ sessions: order });
    })().catch(reportError(`Couldn't move “${data.name}” to ${sectionName(target)}`));
  };
  const dropSession = (data: RowData, activeId: string | number, over: Over) => {
    const target = moveTarget(data, over);
    const to = dataOf(over);
    if (target !== undefined) {
      outcome.current = "move";
      // Dropped on a row with custom order on: it also takes that row's place there.
      const list = to?.type === "row" ? lists.get(to.list)?.current : undefined;
      const order = list?.custom && to?.type === "row" ? (() => {
        const ids = list.items.flatMap((item) => item.members ?? [item.id]).filter((id) => !data.members.includes(id));
        const at = ids.indexOf((list.items.find((item) => item.id === over.id)?.members ?? [String(over.id)])[0]);
        ids.splice(at < 0 ? ids.length : at, 0, ...data.members);
        return ids;
      })() : null;
      moveTo(data, target, order);
      return;
    }
    const source = lists.get(data.list)?.current;
    if (!source?.custom || to?.type !== "row" || to.list !== data.list || !unchanged(data)) return;
    outcome.current = "reorder";
    const from = source.items.findIndex((item) => item.id === activeId);
    const at = source.items.findIndex((item) => item.id === over.id);
    if (from < 0 || at < 0 || from === at) return;
    void saveSidebarOrder({ [source.kind]: arrayMove(source.items, from, at).flatMap((item) => item.members ?? [item.id]) });
  };
  const dropSection = (data: SectionData, over: Over) => {
    const ids = latestSections.current.map((section) => sectionSortId(section.id));
    const from = ids.indexOf(sectionSortId(data.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    outcome.current = "section";
    if (from === to) return;
    const by = to > from ? 1 : -1;
    void (async () => { for (let i = from; i !== to; i += by) await editLocalSection({ kind: "reorder", id: data.id, by }); })()
      .catch(reportError(`Couldn't move section “${data.name}”`));
  };
  const overlay = moves && active && active.type !== "zone"
    ? <div className="flex h-[30px] w-[220px] max-w-[80vw] -rotate-2 items-center gap-2 rounded-md border border-info/60 bg-popover px-2.5 text-[13px] text-foreground shadow-lg"><GripVertical className="size-3 shrink-0 text-faint" /><span className="truncate">{active.name}</span></div>
    : null;
  return (
    <ScopeContext.Provider value={scope}>
      <DndContext sensors={sensors} collisionDetection={collisions}
        accessibility={{ container: document.body, announcements, screenReaderInstructions: { draggable: "To reorder, press Space to pick up. Use the arrow keys to move, Space to drop, or Escape to cancel." } }}
        onDragStart={({ active }) => {
          const data = dataOf(active);
          outcome.current = null;
          dragRows.current = data?.type === "row" ? rowsOf(data) : [];
          setActive(data ?? null);
        }}
        onDragMove={({ active, activatorEvent, delta }) => {
          const data = dataOf(active);
          // Pointer only: the keyboard stays in its own list.
          const start = moves && data?.type === "row" && data.kind === "sessions" ? getEventCoordinates(activatorEvent) : null;
          const target = start ? sectionAt(lists, start.x + delta.x, start.y + delta.y) : null;
          setBridged(data?.type === "row" && target !== data.section ? target : null);
        }}
        onDragCancel={() => { setActive(null); setBridged(null); }}
        onDragEnd={({ active, over }) => {
          setActive(null);
          outcome.current = null;
          const data = dataOf(active);
          const target = bridged;
          setBridged(null);
          if (data?.type === "row" && target !== null) {
            outcome.current = "move";
            return moveTo(data, target, null);
          }
          if (!over || !data) return;
          if (data.type === "row") dropSession(data, active.id, over);
          else if (data.type === "section") dropSection(data, over);
        }}>
        {main ? <MainListZone active={moves ? active : null}>{children}</MainListZone> : children}
        {!main && mainTarget && moves && <MainListTarget active={active} />}
        {moves && createPortal(<DragOverlay dropAnimation={animations ? undefined : null}>{overlay}</DragOverlay>, document.body)}
      </DndContext>
    </ScopeContext.Provider>
  );
}

/** The main list's drop zone: everything in the scope outside a section, plus a target while a sectioned session is held. */
function MainListZone({ active, children }: { active: DragData | null; children: ReactNode }) {
  const { moves } = useContext(ScopeContext)!;
  const zone = useDroppable({ id: "zone:main", data: useMemo<ZoneData>(() => ({ type: "zone", section: null, name: MAIN_LIST }), []), disabled: !moves });
  const leaving = active?.type === "row" && active.kind === "sessions" && active.section !== null;
  return <div ref={zone.setNodeRef} data-main-drop-zone="">
    {children}
    {leaving && <p data-main-drop-target="" className={cn("mx-2 mt-1 grid h-8 place-items-center rounded-md border border-dashed border-border text-[12px] text-faint", zone.isOver && "border-info/60 bg-info/10 text-foreground")}>Drop here to move to the main list</p>}
  </div>;
}

/** Beside the sections in the simple layout: where a sectioned session is dropped to leave its section. */
function MainListTarget({ active }: { active: DragData | null }) {
  const leaving = active?.type === "row" && active.kind === "sessions" && active.section !== null;
  const zone = useDroppable({ id: "zone:main", data: useMemo<ZoneData>(() => ({ type: "zone", section: null, name: MAIN_LIST }), []), disabled: !leaving });
  return leaving ? <p ref={zone.setNodeRef} data-main-drop-target="" className={cn("mx-2 mb-2 grid h-8 place-items-center rounded-md border border-dashed border-border text-[12px] text-faint", zone.isOver && "border-info/60 bg-info/10 text-foreground")}>Drop here to move to the main list</p> : null;
}

/** A sortable scope never moves a session into another project, branch or status group. */
export function SidebarSortList(props: ListProps) {
  const { custom } = useSidebarOrder();
  const scope = useContext(ScopeContext);
  const { sections } = useLocalSections();
  // Outside a shared scope (the simple layout's project tree), sessions still drag into the sections there are.
  const moves = (props.kind ?? "sessions") === "sessions" && (scope ? scope.moves : sections.length > 0);
  if (!custom && !moves) return <Items.Provider value={EMPTY_LIST}>{props.children}</Items.Provider>;
  if (!scope) return <SidebarDragScope main={false}><SortableList {...props} custom={custom} /></SidebarDragScope>;
  return <SortableList {...props} custom={custom} />;
}

function SortableList({ items, kind = "sessions", custom, children }: ListProps & { custom: boolean }) {
  const scope = useContext(ScopeContext)!;
  const section = useContext(SectionContext);
  const list = useId();
  const entry = useRef<ListEntry>({ items, kind, section: section?.id ?? null, custom });
  entry.current = { items, kind, section: section?.id ?? null, custom };
  scope.lists.set(list, entry);
  useLayoutEffect(() => { scope.lists.set(list, entry); return () => { scope.lists.delete(list); }; }, [scope, list]);
  const rowDrag = scope.moves && kind === "sessions";
  const value = useMemo<ListContext>(() => ({ byId: new Map(items.map((item) => [item.id, item])), list, kind, section: section?.id ?? null, custom, rowDrag }), [items, list, kind, section, custom, rowDrag]);
  return (
    <Items.Provider value={value}>
      <SortableContext id={list} items={items.map((item) => item.id)} strategy={custom ? verticalListSortingStrategy : noSorting}>{children}</SortableContext>
    </Items.Provider>
  );
}

/** A native pointerdown on the whole element starts the same drag its handle does (pointer only; the keyboard keeps the handle). */
function usePointerDrag(enabled: boolean, listeners: ReturnType<typeof useSortable>["listeners"], setNodeRef: (node: HTMLElement | null) => void) {
  const latest = useRef({ enabled, listeners });
  latest.current = { enabled, listeners };
  const node = useRef<HTMLElement | null>(null);
  const down = useCallback((event: PointerEvent) => {
    if (!latest.current.enabled || (event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"], [aria-haspopup="menu"]')) return;
    latest.current.listeners?.onPointerDown?.({ nativeEvent: event } as never);
  }, []);
  return useCallback((element: HTMLElement | null) => {
    node.current?.removeEventListener("pointerdown", down);
    node.current = element;
    element?.addEventListener("pointerdown", down);
    setNodeRef(element);
  }, [down, setNodeRef]);
}

export function useSidebarSortable(id: string) {
  const list = useContext(Items);
  const item = list.byId.get(id);
  const { animations } = usePrefs();
  const data = useMemo<RowData | undefined>(() => item && { type: "row", kind: list.kind, list: list.list, section: list.section, name: item.name, members: item.members ?? [item.id] }, [item, list]);
  const sortable = useSortable({ id, disabled: !item, data, transition: animations ? undefined : null });
  const ref = usePointerDrag(!!item && list.rowDrag, sortable.listeners, sortable.setNodeRef);
  const overlaid = list.rowDrag && sortable.isDragging;
  const style: CSSProperties = { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition, position: "relative", zIndex: sortable.isDragging ? 10 : undefined, opacity: overlaid ? 0.4 : undefined };
  const handle = item && list.custom ? (
    <button type="button" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners}
      aria-label={`Reorder ${item.name}`} title="Drag to reorder, or press Space"
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      className="flex size-5 shrink-0 touch-none cursor-grab items-center justify-center rounded-sm text-faint hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing">
      <GripVertical className="size-3" />
    </button>
  ) : null;
  return { ref, style, handle };
}

/** Sections reorder among themselves; wrap the rendered sections, in order. */
export function SidebarSectionOrder({ ids, children }: { ids: string[]; children: ReactNode }) {
  return <SortableContext id="local-sections" items={ids.map(sectionSortId)} strategy={verticalListSortingStrategy}>{children}</SortableContext>;
}

/**
 * A local section as a drop target and a sortable header. `ref` goes on the
 * section, `headerRef` on its header row (drag by pointer), `handle` is the
 * keyboard grip; `over` is true while a session from elsewhere is held over it.
 */
export function useSidebarSectionDrag(section: { id: string; name: string }, sortable: boolean) {
  const { animations } = usePrefs();
  const scope = useContext(ScopeContext);
  const sort = useSortable({ id: sectionSortId(section.id), disabled: !scope || !sortable, data: useMemo<SectionData>(() => ({ type: "section", id: section.id, name: section.name }), [section.id, section.name]), transition: animations ? undefined : null });
  const zone = useDroppable({ id: `zone:${section.id}`, disabled: !scope?.moves, data: useMemo<ZoneData>(() => ({ type: "zone", section: section.id, name: section.name }), [section.id, section.name]) });
  const { active, over } = useDndContext();
  const from = dataOf(active);
  const to = dataOf(over);
  const held = from?.type === "row" && from.kind === "sessions" && from.section !== section.id;
  const bridgedOver = useSyncExternalStore(subscribeBridged, () => bridged === section.id);
  const isOver = bridgedOver || (held && !!to && to.type !== "section" && to.section === section.id && !(to.type === "row" && to.list === from.list));
  const node = useRef<HTMLElement | null>(null);
  const ref = useCallback((element: HTMLElement | null) => { node.current = element; sort.setNodeRef(element); zone.setNodeRef(element); }, [sort.setNodeRef, zone.setNodeRef]);
  useLayoutEffect(() => {
    const element = node.current;
    if (!scope || !element) return;
    const entry = { node: element, scope: scope.lists };
    sectionNodes.set(section.id, entry);
    return () => { if (sectionNodes.get(section.id) === entry) sectionNodes.delete(section.id); };
  }, [scope, section.id]);
  const headerRef = usePointerDrag(!!scope && sortable, sort.listeners, () => {});
  const style: CSSProperties = { transform: CSS.Translate.toString(sort.transform), transition: sort.transition, position: "relative", zIndex: sort.isDragging ? 10 : undefined, opacity: sort.isDragging ? 0.4 : undefined };
  const handle = scope && sortable ? (
    <button type="button" ref={sort.setActivatorNodeRef} {...sort.attributes} {...sort.listeners}
      aria-label={`Reorder section ${section.name}`} title="Drag to reorder sections, or press Space"
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      className="flex size-5 shrink-0 touch-none cursor-grab items-center justify-center rounded-sm text-faint opacity-0 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing group-hover/section:opacity-100">
      <GripVertical className="size-3" />
    </button>
  ) : null;
  return { ref, headerRef, style, handle, over: isOver };
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
