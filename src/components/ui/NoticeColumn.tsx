import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { cn } from "@/lib/cn";

/**
 * What the toasts keep off: the composer, the cards waiting on the reader above it, and the held
 * follow-ups over it (PRO-380), which are its controls too.
 */
const AVOID = "[data-composer-box], [data-toast-avoid], [data-held-tray]";

/** How tall a stack in the bottom corner is taken to be when deciding where it goes. */
const BAND = 160;

/** The top column's top edge (`top-22`), and what it keeps above the composer it stops at. */
const TOP_EDGE = 88;
const CLEARANCE = 8;

const COLUMN = "pointer-events-none fixed z-(--z-notice) flex max-w-[calc(100vw-2rem)] flex-col gap-2";

type Place = { top: string; bottom: string; width: string; widthPx: number; right: number; bottomInset: number };
const PLACES: Record<"main" | "floating", Place> = {
  main: { top: "top-22 right-4 max-h-[calc(100dvh-8rem)]", bottom: "bottom-8 right-4 max-h-[calc(100dvh-3rem)]", width: "w-[380px]", widthPx: 380, right: 16, bottomInset: 32 },
  floating: { top: "top-22 right-3 max-h-[calc(100dvh-7rem)]", bottom: "bottom-3 right-3 max-h-[calc(100dvh-1.5rem)]", width: "w-[320px]", widthPx: 320, right: 12, bottomInset: 12 },
};

/** The element the toasts stack in now, top or bottom, for a notice raised from deep in a page to join. */
let stack: HTMLElement | null = null;
const listeners = new Set<() => void>();
function setStack(element: HTMLElement | null) {
  if (stack === element) return;
  stack = element;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Where a window's notices show (#1499). The notices that wait on the reader stay top right, under the
 * tabs (`waiting`). The toasts (`children`) sit in the bottom-right corner, where they cover none of a
 * page's own controls, unless a composer reaches under that corner: then an "agent finished" toast there
 * would land by the draft and Send just as a turn ended, over the last turn's footer, so the toasts join
 * the top column instead, where nothing a chat uses is under them.
 */
export function NoticeColumn({ waiting, children, window: kind = "main" }: { waiting?: ReactNode; children: ReactNode; window?: "main" | "floating" }) {
  const place = PLACES[kind];
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const floor = useComposerInCorner(place, element);
  const up = floor !== null;
  const ref = useCallback((node: HTMLDivElement | null) => {
    setStack(node);
    setElement(node);
  }, []);
  const toasts = <div ref={ref} data-notice-stack="" className="flex min-h-0 flex-col gap-2">{children}</div>;
  return (
    <>
      {/* With the toasts up here a tall stack stops above the composer and scrolls within itself, never over Send. */}
      <div data-notice-column="top" className={cn(COLUMN, place.top, place.width, up && "overflow-y-auto overscroll-contain")} style={up ? { maxHeight: Math.max(floor - TOP_EDGE - CLEARANCE, 96) } : undefined}>
        {waiting}
        {up && toasts}
      </div>
      <div data-notice-column="bottom" className={cn(COLUMN, place.bottom, place.width)}>{!up && toasts}</div>
    </>
  );
}

/**
 * The top of whatever composer (or card that answers to it) reaches under the bottom-right corner, or
 * null when nothing does. Read when
 * the window opens and resizes, every second as views and panels open and close, and whenever a toast
 * comes or goes, before it is painted: one that comes just after a chat opened goes straight up.
 */
function useComposerInCorner(place: Place, toasts: HTMLElement | null): number | null {
  const [floor, setFloor] = useState<number | null>(null);
  const { right, bottomInset, widthPx } = place;
  useLayoutEffect(() => {
    const measure = () => {
      const columnWidth = Math.min(widthPx, window.innerWidth - 2 * right);
      const corner = { left: window.innerWidth - right - columnWidth, right: window.innerWidth - right, bottom: window.innerHeight - bottomInset, top: window.innerHeight - bottomInset - BAND };
      const under = [...document.querySelectorAll<HTMLElement>(AVOID)]
        .map((box) => box.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0 && box.right > corner.left && box.left < corner.right && box.bottom > corner.top && box.top < corner.bottom);
      setFloor(under.length ? Math.round(Math.min(...under.map((box) => box.top))) : null);
    };
    measure();
    const timer = window.setInterval(measure, 1000);
    window.addEventListener("resize", measure);
    // A toast's arrival is seen right after React commits it, before the frame is painted, and flushSync moves the
    // stack in that same frame. (A ResizeObserver here moved what it observed inside its own callback: a loop error.)
    const observer = toasts && typeof MutationObserver !== "undefined" ? new MutationObserver(() => flushSync(measure)) : null;
    if (toasts) observer?.observe(toasts, { childList: true, subtree: true });
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [right, bottomInset, widthPx, toasts]);
  return floor;
}

/**
 * A notice raised from deep in a page (the settings' "can't save" alert) joins the window's toasts,
 * after them, wherever they are; with no notice column on the page it takes the bottom corner on its own.
 */
export function InNoticeColumn({ children }: { children: ReactNode }) {
  const target = useSyncExternalStore(subscribe, () => stack, () => null);
  return target ? createPortal(children, target) : <div className={cn(COLUMN, PLACES.main.bottom, "w-[26rem]")}>{children}</div>;
}
