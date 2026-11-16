import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { liftClearOf } from "@/components/cleanup/CleanupIndicator";

/**
 * What the stack keeps off: the composer, the cards waiting on the reader
 * above it, and the held follow-ups over it (PRO-380), which are its controls too.
 */
const AVOID = "[data-composer-box], [data-toast-avoid], [data-held-tray]";

/** Kept from the window's top edge however tall the composer is. */
const TOP_MARGIN = 8;

/**
 * The bottom-right corner the toasts stack in. Whatever it holds rises clear
 * of a composer (`data-composer-box`) under it (PRO-386): with the right
 * panel closed the composer reaches the corner, and a toast there covered
 * the draft and Send. With the panel open the corner is over the panel and
 * nothing moves. A card waiting on the reader just above the composer
 * (`data-toast-avoid`: a permission request, a question) is risen past too,
 * so the lift never lands on its Allow and Deny. It never rises past the top
 * of the window.
 */
export function ToastCorner({ className, children }: { className?: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const filled = useHasHeight(root);
  const lift = useLiftOffComposer(root, filled);
  return (
    <div ref={root} data-toast-corner="" className={className} style={lift ? { transform: `translateY(-${lift}px)` } : undefined}>
      {children}
    </div>
  );
}

/** Whether the element shows anything: an empty corner is measured against nothing. */
function useHasHeight(element: RefObject<HTMLElement | null>): boolean {
  const [filled, setFilled] = useState(false);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFilled(node.offsetHeight > 0));
    observer.observe(node);
    setFilled(node.offsetHeight > 0);
    return () => observer.disconnect();
  }, [element]);
  return filled;
}

/**
 * While the corner shows anything, the stack rises clear of the composer, as
 * the clean-up indicator does. Composers grow as files are read in (followed
 * as they resize) and move with the panels (read again twice a second while
 * something shows).
 */
function useLiftOffComposer(element: RefObject<HTMLElement | null>, active: boolean): number {
  const [lift, setLift] = useState(0);
  const applied = useRef(0);
  applied.current = lift;
  useLayoutEffect(() => {
    if (!active) {
      setLift(0);
      return;
    }
    const measure = () => {
      const node = element.current;
      if (!node) return;
      const now = node.getBoundingClientRect();
      if (now.height === 0) return;
      // Where it rests: what is measured already includes the lift in force.
      const rest = { left: now.left, right: now.right, top: now.top + applied.current, bottom: now.bottom + applied.current };
      const composers = [...document.querySelectorAll<HTMLElement>(AVOID)].map((box) => box.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight);
      setLift(Math.max(0, Math.round(Math.min(liftClearOf(rest, composers), rest.top - TOP_MARGIN))));
    };
    measure();
    // A composer grows as the files offered to it are read in, and the stack as toasts come: follow either at once.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const box of document.querySelectorAll(AVOID)) observer?.observe(box);
    if (element.current) observer?.observe(element.current);
    const timer = window.setInterval(measure, 500);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [element, active]);
  return lift;
}
