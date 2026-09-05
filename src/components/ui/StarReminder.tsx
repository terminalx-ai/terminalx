import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, Loader2, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasEscapeOverlay, useHotkey } from "@/lib/hotkeys";

export interface StarReminderView {
  revision: number;
  visible: boolean;
  mode: "direct" | "browser" | null;
  busy: boolean;
  error: string | null;
}
const EMPTY: StarReminderView = { revision: 0, visible: false, mode: null, busy: false, error: null };

/** Presentation also serves the development preview; no timers or side effects. */
export function StarNagCard({ view, onAction, onDismiss }: {
  view: StarReminderView;
  onAction: () => void;
  onDismiss: () => void;
}) {
  useHotkey("escape", () => {
    // Editors, menus, pickers and dialogs keep their Escape behavior. Otherwise capture
    // the key before a tab's stop shortcut or xterm can interrupt an agent.
    if (hasEscapeOverlay() || document.activeElement?.closest(".editor-pane")) return false;
    if (!view.busy) onDismiss();
    return true;
  }, { enabled: view.visible, global: true, priority: 10 });

  if (!view.visible) return null;
  return (
    <aside
      data-star-reminder
      aria-labelledby="star-reminder-title"
      aria-describedby="star-reminder-description"
      aria-busy={view.busy}
      className="pointer-events-auto min-h-0 overflow-y-auto rounded-xl bg-popover glass p-4 text-popover-foreground shadow-surface hairline animate-fade-in"
    >
      <div className="flex items-center gap-2">
        <Star aria-hidden className="size-4 shrink-0 text-warning" />
        <h2 id="star-reminder-title" className="min-w-0 flex-1 text-sm font-medium">Enjoying TerminalX?</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" disabled={view.busy} onClick={onDismiss}><X /></Button>
      </div>
      <p id="star-reminder-description" className="mt-2 text-xs leading-relaxed text-muted-foreground">
        TerminalX is open source. If it helped today, a GitHub star helps other developers find it.
      </p>
      {view.error ? <p role="status" className="mt-2 text-xs text-warning">{view.error}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onAction} disabled={view.busy}>
          {view.busy ? <Loader2 aria-hidden className="animate-spin" /> : view.mode === "direct" ? <Star aria-hidden /> : <ExternalLink aria-hidden />}
          {view.busy ? (view.mode === "direct" ? "Starring…" : "Opening…") : view.mode === "direct" ? "Star on GitHub" : "Open GitHub"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={view.busy}>Later</Button>
      </div>
    </aside>
  );
}

/** Mounted once by AppShell. The backend owns eligibility, persistence and actions. */
export function StarReminder() {
  const [preview] = useState(() => import.meta.env.DEV && new URLSearchParams(location.search).get("preview") === "star-reminder");
  const [view, setView] = useState<StarReminderView>(() => preview ? {
    ...EMPTY, visible: true, mode: new URLSearchParams(location.search).get("starMode") === "direct" ? "direct" : "browser",
  } : EMPTY);
  const revision = useRef(0);
  const submitting = useRef(false);

  function accept(next: StarReminderView) {
    if (next.revision < revision.current) return;
    revision.current = next.revision;
    setView(next);
  }

  useEffect(() => {
    if (preview) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const update = (next: StarReminderView) => { if (!disposed) accept(next); };
    // Subscribe before requesting a snapshot, and reject out-of-order replies.
    void listen<StarReminderView>("star_nag_changed", (event) => update(event.payload)).then((stop) => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      void invoke<StarReminderView>("star_nag_ready").then(update).catch(() => {});
    }).catch(() => {});
    const typing = (event: Event) => {
      if (event instanceof KeyboardEvent && ["Alt", "Control", "Meta", "Shift"].includes(event.key)) return;
      void invoke("star_nag_input").catch(() => {});
    };
    window.addEventListener("keydown", typing, true);
    window.addEventListener("input", typing, true);
    window.addEventListener("compositionstart", typing, true);
    window.addEventListener("compositionend", typing, true);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("keydown", typing, true);
      window.removeEventListener("input", typing, true);
      window.removeEventListener("compositionstart", typing, true);
      window.removeEventListener("compositionend", typing, true);
    };
  }, [preview]);

  async function act(command: "star_nag_act" | "star_nag_dismiss") {
    if (submitting.current || view.busy) return;
    if (preview) { setView((current) => ({ ...current, visible: false })); return; }
    submitting.current = true;
    setView((current) => ({ ...current, busy: true, error: null }));
    try {
      accept(await invoke<StarReminderView>(command));
    } catch {
      setView((current) => ({ ...current, busy: false, error: "Couldn’t update the reminder. Please try again." }));
    } finally {
      submitting.current = false;
    }
  }

  return <StarNagCard view={view} onAction={() => void act("star_nag_act")} onDismiss={() => void act("star_nag_dismiss")} />;
}
