import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

/**
 * What the toasts keep off: the composer, the cards waiting on the reader above it, and the held
 * follow-ups over it (PRO-380), which are its controls too.
 */
const AVOID = "[data-composer-box], [data-toast-avoid], [data-held-tray]";

/** How tall a stack in the bottom corner is taken to be when deciding where it goes. */
const BAND = 160;

/** What the toasts keep above the composer they stop at, and the least of them that stays on show. */
const CLEARANCE = 8;
const MIN_STACK = 72;

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
  useFitAbove(element, floor);
  const toasts = <div ref={ref} data-notice-stack="" className={cn("flex min-h-0 flex-col gap-2", up && "overflow-y-auto overscroll-contain")}>{children}</div>;
  return (
    <>
      <div data-notice-column="top" className={cn(COLUMN, place.top, place.width)}>
        {waiting}
        {up && toasts}
      </div>
      <div data-notice-column="bottom" className={cn(COLUMN, place.bottom, place.width)}>{!up && toasts}</div>
    </>
  );
}

function nodeAffectsAvoid(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.matches(AVOID) || node.querySelector(AVOID) !== null;
}

/**
 * Up top, the toasts stop above the composer (and the cards over it) and scroll within themselves, never
 * over Send (#1499 review). Only they do: the notices that wait above them are never cut short, however
 * high an approval card reaches in a short window. Driven by ResizeObserver/MutationObserver rather than
 * permanent polling.
 */
function useFitAbove(toasts: HTMLElement | null, floor: number | null) {
  useLayoutEffect(() => {
    if (!toasts) return;
    if (floor === null) {
      toasts.style.maxHeight = "";
      return;
    }
    const fit = () => {
      toasts.style.maxHeight = `${Math.max(Math.round(floor - toasts.getBoundingClientRect().top - CLEARANCE), MIN_STACK)}px`;
    };
    fit();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        fit();
      });
    };
    const column = toasts.parentElement;
    const ro = column && typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (column && ro) {
      ro.observe(column);
      for (const child of column.children) {
        if (child !== toasts) ro.observe(child);
      }
    }
    const mo = column && typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          if (ro && column) {
            ro.disconnect();
            ro.observe(column);
            for (const child of column.children) {
              if (child !== toasts) ro.observe(child);
            }
          }
          schedule();
        })
      : null;
    if (column) mo?.observe(column, { childList: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [toasts, floor]);
}

/**
 * The top of whatever composer (or card that answers to it) reaches under the bottom-right corner, or
 * null when nothing does. Observers stay inactive while no notices are mounted so idle windows do zero
 * layout reads.
 */
function useComposerInCorner(place: Place, toasts: HTMLElement | null): number | null {
  const [floor, setFloor] = useState<number | null>(null);
  const [hasNotices, setHasNotices] = useState(false);
  const { right, bottomInset, widthPx } = place;

  // Watch only direct notice presence on the toast stack; do nothing until at least one notice mounts.
  useLayoutEffect(() => {
    if (!toasts) {
      setHasNotices(false);
      return;
    }
    const update = () => setHasNotices(toasts.childElementCount > 0);
    update();
    if (typeof MutationObserver === "undefined") return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    });
    observer.observe(toasts, { childList: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [toasts]);

  useLayoutEffect(() => {
    if (!hasNotices) {
      setFloor(null);
      return;
    }
    const measure = () => {
      const columnWidth = Math.min(widthPx, window.innerWidth - 2 * right);
      const corner = { left: window.innerWidth - right - columnWidth, right: window.innerWidth - right, bottom: window.innerHeight - bottomInset, top: window.innerHeight - bottomInset - BAND };
      const under = [...document.querySelectorAll<HTMLElement>(AVOID)]
        .map((box) => box.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0 && box.right > corner.left && box.left < corner.right && box.bottom > corner.top && box.top < corner.bottom);
      const next = under.length ? Math.round(Math.min(...under.map((box) => box.top))) : null;
      setFloor((prev) => (prev === next ? prev : next));
    };
    measure();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    const syncAvoidObservers = () => {
      if (!ro) return;
      ro.disconnect();
      for (const box of document.querySelectorAll<HTMLElement>(AVOID)) ro.observe(box);
    };
    syncAvoidObservers();
    const bodyObserver = typeof MutationObserver !== "undefined"
      ? new MutationObserver((records) => {
          let relevant = false;
          for (const record of records) {
            for (const node of record.addedNodes) if (nodeAffectsAvoid(node)) { relevant = true; break; }
            if (relevant) break;
            for (const node of record.removedNodes) if (nodeAffectsAvoid(node)) { relevant = true; break; }
            if (relevant) break;
          }
          if (!relevant) return;
          syncAvoidObservers();
          schedule();
        })
      : null;
    if (document.body) bodyObserver?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
      bodyObserver?.disconnect();
    };
  }, [right, bottomInset, widthPx, hasNotices]);
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
