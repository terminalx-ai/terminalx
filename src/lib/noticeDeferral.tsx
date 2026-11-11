import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from "react";

// Window-local: only decisions visible in this window defer its in-app notices.
interface NoticeView { depth: number }
const mainView: NoticeView = { depth: 0 };
const ViewContext = createContext(mainView);
const foregroundViews = new Set<NoticeView>();
// A modal sits above every view; null marks its decisions.
const decisions = new Map<symbol, NoticeView | null>();
const listeners = new Set<() => void>();

export function noticesDeferred() {
  let foreground = mainView;
  for (const view of foregroundViews) if (view.depth >= foreground.depth) foreground = view;
  for (const view of decisions.values()) if (view === null || view === foreground) return true;
  return false;
}

function update(change: () => void) {
  const wasDeferred = noticesDeferred();
  change();
  if (wasDeferred !== noticesDeferred()) for (const listener of listeners) listener();
}

export function subscribeNoticeDeferral(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A full-window view covers the workspace without unmounting its conversation. */
export function NoticeForeground({ children }: { children: ReactNode }) {
  const parent = useContext(ViewContext);
  const view = useMemo(() => ({ depth: parent.depth + 1 }), [parent]);
  useLayoutEffect(() => {
    update(() => { foregroundViews.add(view); });
    return () => update(() => { foregroundViews.delete(view); });
  }, [view]);
  return <ViewContext.Provider value={view}>{children}</ViewContext.Provider>;
}

/** Keep notices until every foreground decision has closed, without moving focus. */
export function useNoticeDeferral(active: boolean, placement: "view" | "modal" = "view") {
  const view = useContext(ViewContext);
  const scope = placement === "modal" ? null : view;
  useLayoutEffect(() => {
    if (!active) return;
    const decision = Symbol();
    update(() => { decisions.set(decision, scope); });
    return () => update(() => { decisions.delete(decision); });
  }, [active, scope]);
}
