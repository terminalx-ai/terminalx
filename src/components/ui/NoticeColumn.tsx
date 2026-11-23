import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

/**
 * Where a window's notices show: top right, under the title bar and tabs (#1499). In the bottom corner an
 * "agent finished" toast landed by the composer just as a turn ended, over the draft, Send and the last
 * turn's footer. Up here nothing a chat uses is under it.
 */
const PLACE = "pointer-events-none fixed top-22 right-4 z-(--z-toast) flex max-h-[calc(100dvh-8rem)] max-w-[calc(100vw-2rem)] flex-col gap-2";

/** The one column a window stacks its notices in, so no two of them land on each other. */
export function NoticeColumn({ className, children }: { className?: string; children: ReactNode }) {
  return <div data-notice-column="" className={cn(PLACE, "w-[380px]", className)}>{children}</div>;
}

/**
 * A notice raised from deep in a page (the settings' "can't save" alert) joins the window's column,
 * after what it holds; with no column on the page it takes the same place on its own.
 */
export function InNoticeColumn({ children }: { children: ReactNode }) {
  const [column, setColumn] = useState<Element | null>(null);
  useLayoutEffect(() => setColumn(document.querySelector("[data-notice-column]")), []);
  return column ? createPortal(children, column) : <div className={cn(PLACE, "w-[26rem]")}>{children}</div>;
}
