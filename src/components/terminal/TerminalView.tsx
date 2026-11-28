import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalMoveButton } from "./TerminalMoveButton";
import { TERMINAL_KEYS, TerminalTools, useTerminalKey } from "./TerminalTools";
import { Eraser, SquareTerminal as TerminalIcon } from "@/icons";
import { shortPath } from "@/lib/paths";
import { useSessionStore } from "@/lib/sessions";
import { EnvironmentNotice } from "./EnvironmentNotice";
import { LocalTerminalLinks } from "./LocalTerminalLinks";
import { pty } from "@/lib/api";
import { disposeInstance, getInstance, isAgentPane, peekInstance, registerTerminalFactory, subscribeTerminals, trimTerminalInstances, useTerminals, type TerminalInstance } from "@/lib/terminal";
import { feedLocalPane } from "@/lib/terminalFeed";
import { terminalInput } from "@/lib/terminalInput";
import { deferredTerminalFit, fitTerminal } from "@/lib/terminalFit";
import { acknowledgeTerminalResize, coordinateTerminalResize, isOutputResize, reassertTerminalResize, requestTerminalResize, requestedTerminalSize, stopTerminalOutput } from "@/lib/terminalOutput";
import { TerminalBufferCleanup } from "@/lib/terminalBufferCleanup";
import { terminalColorHex } from "@/lib/terminalColor";
import { createTerminalLinkHandler } from "@/lib/terminalLinks";
import { confirmInApp } from "@/lib/confirm";
import { formatTerminalPastePreview, sanitizeTerminalPaste } from "@/lib/terminalDrop";
import { hideWebgl, recoverWebgl, showWebgl } from "@/lib/terminalWebgl";
import { onAppResume } from "@/lib/appResume";
import { useTheme } from "@/lib/theme";
import { getPrefs, subscribePrefs } from "@/lib/prefs";
import { REMOTE_DROP_REFUSAL, TerminalDropHint, useTerminalDrop, type TerminalDropRefusal } from "./TerminalDrop";

const subscribeVisibility = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};
const pageVisible = () => !document.hidden;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The terminal's palette follows the app's mode; ANSI colours are tuned per mode. */
export function themeFor(mode: "dark" | "light") {
  const fg = terminalColorHex(cssVar("--foreground"), mode === "dark" ? "#e6e6e6" : "#222222");
  // The terminal's own surface, opaque: programs that query the background (OSC 11)
  // then learn the real mode instead of a transparent black. The view around the
  // canvas is drawn in the same colour (`bg-terminal`), so there is no box.
  const bg = terminalColorHex(cssVar("--surface-terminal"), mode === "dark" ? "#0b0b0b" : "#f7f7f5");
  return mode === "dark"
    ? {
        background: bg,
        foreground: fg,
        cursor: fg,
        cursorAccent: "#000",
        selectionBackground: "rgba(120,160,255,0.35)",
        black: "#666b7a",
        red: "#f07178",
        green: "#8fd694",
        yellow: "#f0c674",
        blue: "#82aaff",
        magenta: "#c792ea",
        cyan: "#89ddff",
        white: "#d6d6d6",
        brightBlack: "#8b90a0",
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
        yellow: "#8a5a00",
        blue: "#1d5fd6",
        magenta: "#8e44ad",
        cyan: "#0e7c86",
        white: "#525760",
        brightBlack: "#5f636d",
        brightRed: "#c93b37",
        brightGreen: "#2e7d32",
        brightYellow: "#8a5a00",
        brightBlue: "#2563c9",
        brightMagenta: "#8440a3",
        brightCyan: "#0d7480",
        brightWhite: "#3a3e47",
      };
}

type OptionKeyed = { options: { macOptionIsMeta?: boolean }; dispose(): void };

/** Every open terminal made here, so turning the Option key setting reaches those already open. */
const optionKeyed = new Set<OptionKeyed>();
let followingOptionKey = false;

/**
 * Keep `term`'s Option key as the setting says, now and whenever it changes,
 * until it is disposed. One subscription serves every terminal.
 */
export function followOptionKey(term: OptionKeyed) {
  optionKeyed.add(term);
  const dispose = term.dispose.bind(term);
  term.dispose = () => {
    optionKeyed.delete(term);
    dispose();
  };
  if (followingOptionKey) return;
  followingOptionKey = true;
  subscribePrefs(() => {
    const meta = getPrefs().optionAsMeta;
    for (const open of optionKeyed) if (open.options.macOptionIsMeta !== meta) open.options.macOptionIsMeta = meta;
  });
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
    macOptionIsMeta: getPrefs().optionAsMeta,
    linkHandler: createTerminalLinkHandler(),
  });
  followOptionKey(term);
  const fit = new FitAddon();
  term.loadAddon(new TerminalBufferCleanup());
  term.loadAddon(fit);
  term.open(el);
  let disposed = false;
  const onPaste = (event: ClipboardEvent) => {
    const raw = event.clipboardData?.getData("text/plain");
    if (!raw) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const prepared = sanitizeTerminalPaste(raw, term.modes.bracketedPasteMode);
    if (!prepared.text) return;
    if (prepared.multiLine) {
      const note = prepared.strippedControls
        ? "Control characters were removed for safety.\n\n"
        : "";
      void confirmInApp({
        title: `Paste ${prepared.lines} lines into terminal?`,
        body: `${note}${formatTerminalPastePreview(prepared.text)}`,
        action: "Paste",
        cancel: "Cancel",
      }).then((confirmed) => {
        if (!confirmed || disposed) return;
        term.paste(prepared.text);
        term.focus();
      });
      return;
    }
    term.paste(prepared.text);
  };
  el.addEventListener("paste", onPaste, true);
  const origDispose = term.dispose.bind(term);
  term.dispose = () => {
    disposed = true;
    el.removeEventListener("paste", onPaste, true);
    origDispose();
  };
  return { el, term, fit };
}

/** A terminal wired to the local pane `id`. */
export function createInstance(id: string, mode: "dark" | "light"): TerminalInstance {
  const { el, term, fit } = createTerminal(mode);
  // The pane's output so far, then everything it prints, as raw bytes. Only
  // once this page has dropped what a page before it had attached
  // (`subscribeTerminals`): attached before that, the view would be dropped
  // with them, and its terminal would stay blank.
  // Each attachment has its own name: another terminal made for the same pane
  // (this one disposed, the next one created), or this one attached again
  // over a new connection, has another, and neither can detach or answer for
  // the other, in whatever order their calls land.
  const attach = (reset = false) => {
    const token = crypto.randomUUID();
    const view = { token, retired: false, failed: false, ready: Promise.resolve(), feed: feedLocalPane(id, token, term, { paced: !isAgentPane(id), retire: () => disposeInstance(id) }) };
    // Finish already queued parser writes before replaying a new attachment.
    const drained = reset ? new Promise<void>((resolve) => term.write("", () => {
      if (!view.retired) term.reset();
      resolve();
    })) : Promise.resolve();
    view.ready = drained.then(() => subscribeTerminals())
      .then(() => {
        if (view.retired) throw new Error("The terminal attachment was cancelled. Try opening Terminal view again.");
        return pty.attachSized(id, token, view.feed.data);
      })
      // Retired while the attach was on its way: it must not be left attached to nothing.
      .then(async () => {
        if (view.retired) {
          await pty.detach(id, token);
          throw new Error("The terminal attachment was replaced. Try opening Terminal view again.");
        }
        reassertTerminalResize(term);
      })
      .catch((error: unknown) => { view.failed = true; throw error; });
    // Hidden views attach in the background. Explicit switches observe this
    // same promise through ensureAttached and retain Chat on rejection.
    void view.ready.catch(() => {});
    return view;
  };
  const retire = (view: ReturnType<typeof attach>) => {
    view.retired = true;
    view.feed.stop();
    void pty.detach(id, view.token).catch(() => {});
  };
  let view = attach();
  let released = false;
  const input = terminalInput(id);
  term.onData(input.write);
  term.onBinary(input.write);
  coordinateTerminalResize(term, (size) => pty.resize(id, size.cols, size.rows).then(() => acknowledgeTerminalResize(term, size)));
  term.onResize((size) => { if (!isOutputResize(term)) requestTerminalResize(term, size); });
  return {
    el,
    term,
    fit,
    restorable: true,
    attachedAs: (token) => !released && view.token === token,
    ensureAttached: async () => {
      if (released) throw new Error("The terminal view was closed. Try opening it again.");
      if (view.failed) { retire(view); view = attach(true); }
      const requested = view;
      await requested.ready;
      if (released || view !== requested) throw new Error("The terminal connection changed while opening. Try again.");
    },
    reattach: () => {
      if (released) return;
      retire(view);
      view = attach(true);
    },
    release: () => {
      released = true;
      stopTerminalOutput(term);
      input.stop();
      retire(view);
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
  focused = visible,
  create,
  fit = true,
  dropRefusal,
  redraw = true,
  moveToDock = false,
  moveToTab = false,
  shell = moveToDock || moveToTab,
  actions,
}: {
  id: string;
  visible: boolean;
  focused?: boolean;
  create?: (mode: "dark" | "light") => TerminalInstance;
  fit?: boolean;
  dropRefusal?: TerminalDropRefusal;
  /** The "Redraw terminal" control in its header; a compact view leaves it out. */
  redraw?: boolean;
  /** A standalone local shell can move into the session dock. */
  moveToDock?: boolean;
  /** A shell in the dock can move back to a tab: its header offers "Move to tab". */
  moveToTab?: boolean;
  /**
   * A plain local shell: its header offers Clear and the terminal takes ⌘K for it. An agent's
   * TUI, a cloud terminal, a setup or archive log are not: clearing them would drop a live
   * screen, and ⌘K stays the command palette there. Defaults to the views that can move.
   */
  shell?: boolean;
  /** More controls for the header row, beside Move and Redraw. */
  actions?: ReactNode;
  /** @deprecated The header row is always on screen now; kept so existing callers compile. */
  pinned?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drop = useTerminalDrop({ id, frame, enabled: visible, refusal: dropRefusal ?? (create ? REMOTE_DROP_REFUSAL : undefined) });
  const { theme, resolvedMode } = useTheme();
  // Hidden-window overflow may retire a local parser. Showing the page must
  // reacquire its instance even when the selected tab has not changed.
  const pageShown = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
  const shown = visible && pageShown;
  const make = () => (create ? create(resolvedMode) : createInstance(id, resolvedMode));
  const factory = useRef(make);
  factory.current = make;
  useEffect(() => registerTerminalFactory(id, () => factory.current()), [id]);
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
      if (inst && inst.el.isConnected) requestTerminalResize(inst.term, requestedTerminalSize(inst.term), true);
    };
    assert();
    window.addEventListener("focus", assert);
    return () => window.removeEventListener("focus", assert);
  }, [id, shown, create]);

  useEffect(() => {
    const el = host.current;
    if (!shown || !el) return;
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
    const deferred = deferredTerminalFit(() => fitting.current ? peekInstance(id)?.term : undefined, el);
    const ro = new ResizeObserver(deferred.schedule);
    ro.observe(el);
    const frame = requestAnimationFrame(refit);
    trimTerminalInstances();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      deferred.cancel();
      trimTerminalInstances();
    };
  }, [id, shown]);

  useEffect(() => {
    const inst = peekInstance(id);
    if (inst) inst.term.options.theme = themeFor(resolvedMode);
  }, [id, theme, resolvedMode]);

  // Before paint, so a terminal that is shown is never a blank frame first.
  useLayoutEffect(() => {
    const el = host.current;
    if (!shown || !el) return;
    const inst = getInstance(id, make, el);
    showWebgl(inst.term);
    return () => {
      if (inst.el.parentNode === el) {
        hideWebgl(inst.term);
        el.removeChild(inst.el);
      }
      // A dock/tab move mounts its new host in this same commit. Trim only
      // afterward, so an archived or full idle cache cannot evict it mid-move.
      queueMicrotask(() => trimTerminalInstances());
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
        if (focused) inst.term.focus();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [id, shown, fit, focused]);

  const clear = useCallback(() => {
    const term = peekInstance(id)?.term;
    if (!term) return;
    term.clear();
    term.focus();
  }, [id]);
  useTerminalKey(TERMINAL_KEYS.clear.chord, frame, clear, shown && shell);
  const header = redraw || !!actions || moveToDock || moveToTab;

  return (
    <div ref={frame} className="group/terminal relative flex h-full w-full flex-col overflow-hidden bg-terminal" data-testid="terminal-drop-target" {...drop.zoneProps}>
      {/* A row of its own above the output, so no control is ever drawn over a line of it. */}
      {header && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline pr-2 pl-4 text-xs" data-testid="terminal-header">
          <TerminalTitle id={id} />
          <div className="ml-auto flex shrink-0 items-center gap-1.5" data-testid="terminal-toolbar">
            {actions}
            {(moveToDock || moveToTab) && <TerminalMoveButton id={id} docked={moveToTab} />}
            {redraw && (
              <button
                type="button"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-xs whitespace-nowrap text-muted-foreground hover:bg-veil-raised hover:text-foreground"
                onClick={recover}
                title="Redraw the terminal without restarting its process"
                tabIndex={visible ? 0 : -1}
              >
                Redraw terminal
              </button>
            )}
            {shell && <button
              type="button"
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-xs whitespace-nowrap text-muted-foreground hover:bg-veil-raised hover:text-foreground"
              onClick={clear}
              aria-keyshortcuts={TERMINAL_KEYS.clear.aria}
              title="Clear the terminal's output and scrollback"
              tabIndex={visible ? 0 : -1}
            >
              <Eraser className="size-3.5" aria-hidden />Clear <kbd aria-hidden className="rounded-sm bg-veil-strong px-1 font-sans text-[10.5px] font-medium text-foreground/80">{TERMINAL_KEYS.clear.label}</kbd>
            </button>}
          </div>
        </div>
      )}
      <TerminalTools id={id} shown={shown} frame={frame} />
      <EnvironmentNotice id={id} active={visible && !create} />
      {!create && <LocalTerminalLinks id={id} active={shown} />}
      {/* Clipped: until it is fitted again, a grid taller than its new box must not scroll the view and hide the rows above it. */}
      <div ref={host} className="terminal-host min-h-0 w-full flex-1 overflow-hidden px-2 pt-1" />
      <TerminalDropHint drop={drop} />
    </div>
  );
}

/** The shell's icon, its name and the folder it was opened in. */
function TerminalTitle({ id }: { id: string }) {
  const pane = useTerminals().panes.find((entry) => entry.id === id);
  const cwd = useSessionStore().sessions.find((session) => session.id === pane?.sessionId)?.cwd;
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="terminal-title">
      <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 font-medium text-foreground">{pane?.title ?? "Terminal"}</span>
      {cwd && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={cwd}>{shortPath(cwd)}</span>}
    </div>
  );
}
