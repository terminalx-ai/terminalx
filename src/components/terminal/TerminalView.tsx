import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { pty } from "@/lib/api";
import { getInstance } from "@/lib/terminal";
import { useTheme } from "@/lib/theme";

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
function themeFor(mode: "dark" | "light") {
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

function createInstance(id: string, mode: "dark" | "light") {
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
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* canvas renderer stays */
  }
  term.onData((d) => void pty.write(id, d).catch(() => {}));
  term.onBinary((d) => void pty.write(id, d).catch(() => {}));
  term.onResize(({ cols, rows }) => void pty.resize(id, cols, rows).catch(() => {}));
  return { el, term, fit };
}

/**
 * A view onto one long-lived terminal instance. Mounting re-parents the
 * instance's element here; unmounting detaches it, leaving the buffer and
 * the shell untouched. Size follows the box through a ResizeObserver.
 */
export function TerminalView({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const { resolvedMode } = useTheme();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const inst = getInstance(id, () => createInstance(id, resolvedMode));
    el.appendChild(inst.el);
    const refit = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        try {
          inst.fit.fit();
        } catch {
          /* not laid out yet */
        }
      }
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    requestAnimationFrame(() => {
      refit();
      if (visible) inst.term.focus();
    });
    return () => {
      ro.disconnect();
      if (inst.el.parentNode === el) el.removeChild(inst.el);
    };
  }, [id]);

  useEffect(() => {
    const inst = getInstance(id, () => createInstance(id, resolvedMode));
    inst.term.options.theme = themeFor(resolvedMode);
  }, [id, resolvedMode]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      const inst = getInstance(id, () => createInstance(id, resolvedMode));
      try {
        inst.fit.fit();
        inst.term.focus();
      } catch {
        /* ignore */
      }
    });
  }, [id, visible]);

  return <div ref={host} className="terminal-host h-full w-full px-2 pt-1" />;
}
