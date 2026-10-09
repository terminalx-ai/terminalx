import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { pty } from "@/lib/api";
import { disposeInstance, getInstance, isAgentPane, peekInstance, subscribeTerminals, trimTerminalInstances, type TerminalInstance } from "@/lib/terminal";
import { feedLocalPane } from "@/lib/terminalFeed";
import { terminalInput } from "@/lib/terminalInput";
import { fitTerminal } from "@/lib/terminalFit";
import { hideWebgl, recoverWebgl, showWebgl } from "@/lib/terminalWebgl";
import { onAppResume } from "@/lib/appResume";
import { useTheme } from "@/lib/theme";
import { REMOTE_DROP_REFUSAL, TerminalDropHint, useTerminalDrop, type TerminalDropRefusal } from "./TerminalDrop";

const subscribeVisibility = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};
const pageVisible = () => !document.hidden;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Tokens are oklch, which xterm cannot parse and which OSC 10/11 replies
 * must not carry, so a colour is pushed through a canvas to get sRGB hex.
 */
function toHex(css: string, fallback: string): string {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d");
    if (!ctx) return fallback;
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  } catch {
    return fallback;
  }
}

/** The terminal's palette follows the app's mode; ANSI colours are tuned per mode. */
export function themeFor(mode: "dark" | "light") {
  const fg = toHex(cssVar("--foreground"), mode === "dark" ? "#e6e6e6" : "#222222");
  // The page surface, opaque: programs that query the background (OSC 11)
  // then learn the real mode instead of a transparent black.
  const bg = toHex(cssVar("--surface-page"), mode === "dark" ? "#1c1c1f" : "#f7f7f5");
  return mode === "dark"
    ? {
        background: bg,
        foreground: fg,
        cursor: fg,
        cursorAccent: "#000",
        selectionBackground: "rgba(120,160,255,0.35)",
        black: "#2b2d35",
        red: "#f07178",
        green: "#8fd694",
        yellow: "#f0c674",
        blue: "#82aaff",
        magenta: "#c792ea",
        cyan: "#89ddff",
        white: "#d6d6d6",
        brightBlack: "#6b6f7b",
        brightRed: "#ff8b92",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#9dc4ff",
        brightMagenta: "#d8b4fe",
        brightCyan: "#a5f3fc",
        brightWhite: "#ffffff",
      }
    : {
        background: bg,
        foreground: fg,
        cursor: fg,
        cursorAccent: "#fff",
        selectionBackground: "rgba(60,110,255,0.25)",
        black: "#2b2d35",
        red: "#c0392b",
        green: "#2e7d32",
        yellow: "#a06a00",
        blue: "#1d5fd6",
        magenta: "#8e44ad",
        cyan: "#0e7c86",
        white: "#c9c9c9",
        brightBlack: "#7a7d86",
        brightRed: "#d9534f",
        brightGreen: "#3c9a40",
        brightYellow: "#b8860b",
        brightBlue: "#3b7ddd",
        brightMagenta: "#a259c4",
        brightCyan: "#1a98a3",
        brightWhite: "#ffffff",
      };
}

/**
 * An xterm in its own element, styled like every TerminalX terminal, not yet
 * wired to a process. It draws with WebGL once a view shows it (`terminalWebgl.ts`).
 */
export function createTerminal(mode: "dark" | "light"): TerminalInstance {
  const el = document.createElement("div");
  el.className = "h-full w-full";
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: cssVar("--font-mono") || "ui-monospace, monospace",
    fontSize: 12.5,
    lineHeight: 1.25,
    scrollback: 10_000,
    theme: themeFor(mode),
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  return { el, term, fit };
}

/** A terminal wired to the local pane `id`. */
export function createInstance(id: string, mode: "dark" | "light"): TerminalInstance {
  const { el, term, fit } = createTerminal(mode);
  // The pane's output so far, then everything it prints, as raw bytes. Only
  // once this page has dropped what a page before it had attached
  // (`subscribeTerminals`): attached before that, the view would be dropped
  // with them, and its terminal would stay blank.
  // This attachment's own name: another terminal made for the same pane
  // (this one disposed, the next one created) has another, and neither can
  // detach or answer for the other, in whatever order their calls land.
  const token = crypto.randomUUID();
  const feed = feedLocalPane(id, token, term, {
    paced: !isAgentPane(id),
    retire: () => disposeInstance(id),
  });
  let released = false;
  void subscribeTerminals()
    .then(() => (released ? undefined : pty.attach(id, token, feed.data)))
    // Disposed while the attach was on its way: it must not be left attached to nothing.
    .then(() => (released ? pty.detach(id, token) : undefined))
    .catch(() => {});
  const input = terminalInput(id);
  term.onData(input.write);
  term.onBinary(input.write);
  term.onResize(({ cols, rows }) => void pty.resize(id, cols, rows).catch(() => {}));
  return {
    el,
    term,
    fit,
    restorable: true,
    release: () => {
      released = true;
      input.stop();
      feed.stop();
      void pty.detach(id, token).catch(() => {});
    },
  };
}

/**
 * A view onto a cached terminal instance. The instance's element is
 * here only while the view is `visible`; hiding or unmounting the view takes
 * it out of the document again. The idle cache may then release the local
 * buffer; the shell continues, and the next view restores its output tail.
 * Out of the document xterm draws nothing, whatever the program prints, and a
 * view that is merely covered (an agent's terminal under its chat, a shell
 * tab behind another) would otherwise redraw on every frame of output.
 *
 * Size follows the view's box through a ResizeObserver, shown or not, so the
 * program already has the right size when the terminal is first looked at.
 *
 * `create` makes the instance when there is none yet (a cloud terminal
 * wires its own input); `fit: false` keeps the size someone else set, for
 * a view that watches a terminal another device controls.
 *
 * A file dropped on a local terminal types its path (`TerminalDrop.tsx`).
 * A terminal with its own `create` is not on this computer and takes no
 * drop at all unless `dropRefusal` says what it does take.
 */
export function TerminalView({
  id,
  visible,
  create,
  fit = true,
  dropRefusal,
}: {
  id: string;
  visible: boolean;
  create?: (mode: "dark" | "light") => TerminalInstance;
  fit?: boolean;
  dropRefusal?: TerminalDropRefusal;
}) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drop = useTerminalDrop({ id, frame, enabled: visible, refusal: dropRefusal ?? (create ? REMOTE_DROP_REFUSAL : undefined) });
  const { resolvedMode } = useTheme();
  // Hidden-window overflow may retire a local parser. Showing the page must
  // reacquire its instance even when the selected tab has not changed.
  const pageShown = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
  const shown = visible && pageShown;
  const make = () => (create ? create(resolvedMode) : createInstance(id, resolvedMode));
  const fitting = useRef(fit);
  fitting.current = fit;

  const recover = () => {
    const el = host.current;
    const inst = peekInstance(id);
    if (!visible || !el || !inst || inst.el.parentNode !== el) return;
    try {
      if (fitting.current) fitTerminal(inst.term, el);
    } catch {
      // A stale renderer may not be measurable until it has been replaced.
    }
    recoverWebgl(inst.term);
  };

  useEffect(() => {
    if (visible) return onAppResume(recover);
  }, [id, visible]);

  // A pane has one size and can be on screen in two windows (the main one and
  // the floating one), each with a grid of its own. xterm reports a size only
  // when its own grid changes, so a window that comes back to a pane the other
  // one resized would draw a program laid out for the wrong width. The window
  // being looked at says its size again: when the view is shown, and when the
  // window takes the focus.
  useEffect(() => {
    if (!shown || create) return;
    const assert = () => {
      const inst = peekInstance(id);
      if (inst && inst.el.isConnected) void pty.resize(id, inst.term.cols, inst.term.rows).catch(() => {});
    };
    assert();
    window.addEventListener("focus", assert);
    return () => window.removeEventListener("focus", assert);
  }, [id, shown, create]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    getInstance(id, make);
    const refit = () => {
      if (!fitting.current) return;
      // A hidden instance may have left the idle cache since this view mounted.
      const inst = peekInstance(id);
      if (!inst) return;
      try {
        fitTerminal(inst.term, el);
      } catch {
        /* not laid out yet */
      }
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    const frame = requestAnimationFrame(refit);
    trimTerminalInstances();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      trimTerminalInstances();
    };
  }, [id]);

  useEffect(() => {
    const inst = peekInstance(id);
    if (inst) inst.term.options.theme = themeFor(resolvedMode);
  }, [id, resolvedMode]);

  // Before paint, so a terminal that is shown is never a blank frame first.
  useLayoutEffect(() => {
    const el = host.current;
    if (!shown || !el) return;
    const inst = getInstance(id, make, el);
    showWebgl(inst.term);
    return () => {
      hideWebgl(inst.term);
      if (inst.el.parentNode === el) el.removeChild(inst.el);
      trimTerminalInstances();
    };
  }, [id, shown]);

  useEffect(() => {
    const el = host.current;
    if (!shown || !el) return;
    const frame = requestAnimationFrame(() => {
      // Closed in the meantime (its tab was): nothing to focus, and nothing to make anew.
      const inst = peekInstance(id);
      if (!inst) return;
      try {
        if (fitting.current) fitTerminal(inst.term, el);
        inst.term.refresh(0, inst.term.rows - 1);
        inst.term.focus();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [id, shown, fit]);

  return (
    <div ref={frame} className="relative flex h-full w-full flex-col" data-testid="terminal-drop-target" {...drop.zoneProps}>
      <div className="flex h-6 shrink-0 justify-end px-3">
        <button
          type="button"
          className="rounded px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={recover}
          title="Redraw the terminal without restarting its process"
          tabIndex={visible ? 0 : -1}
        >
          Redraw terminal
        </button>
      </div>
      <div ref={host} className="terminal-host min-h-0 w-full flex-1 px-2 pt-1" />
      <TerminalDropHint drop={drop} />
    </div>
  );
}
