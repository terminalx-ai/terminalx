import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, Minus, Square, X } from "@/icons";
import { floatingWindow } from "@/lib/api";
import { inAppWindow, isFloatingWindow } from "@/lib/appWindow";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/cn";

/**
 * The window's own Minimize, Maximize and Close on Windows and Linux, where the window has no system title bar
 * (`decorations: false`): the app's top strips are the title bar there, as on a Mac. macOS keeps its traffic lights.
 *
 * Every top strip ends with one of these, and only the strip at the window's top right shows its buttons, so they sit
 * in the corner whichever views are open: the session's header, or the right panel's tabs when that panel is open.
 * The floating panel has Close only, which hides it as its shortcut does.
 */
export function WindowControls({ mac = isMac }: { mac?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = !mac && inAppWindow();
  const corner = useAtTopRight(ref, shown);
  const maximized = useMaximized(shown && corner);
  if (mac || !inAppWindow()) return null;
  const floating = isFloatingWindow();
  const failed = (error: unknown) => console.error("Window action failed", error);
  const window = () => getCurrentWindow();
  return (
    // Out of the layout (no box, no gap) unless this strip has the corner. There it goes to the end, unless a group
    // before it is already pushed right with ml-auto: two would split the free space between them.
    <div ref={ref} className={cn("h-full shrink-0 self-stretch", corner ? "ml-auto flex [.ml-auto~&]:ml-0" : "hidden")} data-testid="window-controls" data-corner={corner || undefined}>
      {corner && (
        <>
          {!floating && (
            <>
              <ControlButton label="Minimize" onClick={() => void window().minimize().catch(failed)}>
                <Minus />
              </ControlButton>
              <ControlButton label={maximized ? "Restore" : "Maximize"} onClick={() => void window().toggleMaximize().catch(failed)}>
                {maximized ? <Copy className="scale-x-[-1]" /> : <Square />}
              </ControlButton>
            </>
          )}
          <ControlButton label="Close" close onClick={() => void (floating ? floatingWindow.hide() : window().close()).catch(failed)}>
            <X />
          </ControlButton>
        </>
      )}
    </div>
  );
}

function ControlButton({ label, close, onClick, children }: { label: string; close?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      // Not a drag handle: a press here is the button's, and a double press does not maximize.
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        "flex h-full w-11 items-center justify-center text-muted-foreground transition-colors [&_svg]:size-3.5",
        close ? "hover:bg-[#c42b1c] hover:text-white" : "hover:bg-foreground/10 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Whether the strip holding `ref` reaches the window's top right corner. Its right edge is the strip's (its padding
 * pulled back, so the buttons meet the corner), measured again when the strip or the window changes size.
 */
export function useAtTopRight(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [corner, setCorner] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    const strip = element?.parentElement;
    if (!enabled || !element || !strip) return;
    const measure = () => {
      const box = strip.getBoundingClientRect();
      const at = box.top <= 1 && box.width > 0 && box.right >= document.documentElement.clientWidth - 1;
      element.style.marginRight = at ? `-${getComputedStyle(strip).paddingRight}` : "";
      setCorner(at);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(strip);
    globalThis.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      globalThis.removeEventListener("resize", measure);
    };
  }, [ref, enabled]);
  return corner;
}

/** Whether the window is maximized now, for the middle button's mark and name. */
function useMaximized(enabled: boolean): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!enabled || !inAppWindow()) return;
    const window = getCurrentWindow();
    let stopped = false;
    const read = () => void window.isMaximized().then((value) => { if (!stopped) setMaximized(value); }).catch(() => undefined);
    read();
    const unlisten = window.onResized(read);
    return () => {
      stopped = true;
      void unlisten.then((stop) => stop());
    };
  }, [enabled]);
  return maximized;
}
