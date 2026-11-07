import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Phase = "closed" | "opening" | "open" | "closing";

/** Whether this document runs CSS animations at all (a test's DOM does not, and would wait for an end that never comes). */
const animates = () => typeof document !== "undefined" && typeof document.documentElement.getAnimations === "function";

/**
 * How any panel beside the main view comes and goes: the left sidebar, the
 * right panel, and whatever panel is added next. Wrap the panel and pass
 * whether it is open and which edge it lives on; the motion itself is one
 * system in app.css (`--panel-*`, `.animate-panel-*`), tuned there for all.
 *
 * Its space opens from nothing to the panel's size and closes back, so the
 * main view beside it glides rather than jumping; the panel stays solid at
 * its own width and slides in with the space, its inner edge leading.
 * `size` is that width, a CSS length (the sidebar's and the panel's are CSS
 * variables, which follow a drag without a re-render). While closing it keeps
 * drawing what it last showed, since the caller has already stopped
 * rendering it. A panel open when the window first draws is just there.
 *
 * What a panel shows only once its data is read fades in when it arrives:
 * give that view's root `animate-panel-content`, from the same system.
 */
export function PanelPresence({ open, side, size = side === "left" ? "var(--sidebar-w)" : "var(--panel-w)", children }: { open: boolean; side: "left" | "right"; size?: string; children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  const shown = useRef(children);
  if (open) shown.current = children;
  useEffect(() => {
    const moving = animates();
    setPhase((now) => (open ? (now === "open" ? now : moving ? "opening" : "open") : now === "closed" ? now : moving ? "closing" : "closed"));
  }, [open]);
  if (phase === "closed") return null;
  return (
    <div
      className={cn(
        "flex h-full min-h-0 shrink-0",
        // Its inner edge leads: the panel slides in with the opening space, carrying its content, rather than being
        // uncovered in place (which cut its rows mid-word as it opened).
        side === "left" && "justify-end",
        // Clipped only while it moves: open, the panel's resize handle reaches past its edge.
        phase !== "open" && "overflow-hidden",
        phase === "opening" && "animate-panel-in",
        phase === "closing" && "animate-panel-out",
      )}
      style={{ "--panel-size": size } as CSSProperties}
      data-state={phase}
      data-side={side}
      data-testid="panel-presence"
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        setPhase((now) => (now === "closing" ? "closed" : now === "opening" ? "open" : now));
      }}
    >
      {shown.current}
    </div>
  );
}
