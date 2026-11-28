import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { RuntimeSession } from "@terminalx/portable/workspace";

const confirmMock = vi.hoisted(() => ({ confirmInApp: vi.fn(async () => true) }));
vi.mock("@/lib/confirm", () => ({ confirmInApp: confirmMock.confirmInApp }));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(() => {
  cleanup();
  confirmMock.confirmInApp.mockReset();
  confirmMock.confirmInApp.mockResolvedValue(true);
});

describe("Wave 4 frontend package & dev-gate invariants (S-44, S-56)", () => {
  it("removes @tauri-apps/plugin-shell from package.json (S-44)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    expect(pkg.dependencies["@tauri-apps/plugin-shell"]).toBeUndefined();
  });

  it("gates terminalBench & window.__TERMINALX_PERF__ behind import.meta.env.DEV (S-56)", () => {
    const perfSrc = fs.readFileSync(path.join(rootDir, "src/lib/terminalPerf.ts"), "utf8");
    expect(perfSrc).toContain("import.meta.env.DEV");
    expect(perfSrc).toMatch(/if\s*\(\s*import\.meta\.env\.DEV\s*\)\s*\{\s*window\.__TERMINALX_PERF__/);
  });
});

describe("VncView port validation (S-45)", () => {
  it("disconnects immediately for invalid or privileged ports", async () => {
    const { VncView } = await import("@/components/computer/VncView");
    const states: string[] = [];
    render(<VncView port={80} password="pw" control={false} onState={(s) => states.push(s)} />);
    expect(states).toContain("disconnected");
  });
});

describe("P-71: no inline subscribe callbacks in useSyncExternalStore across src/", () => {
  it("has zero inline subscribe closures in production hooks", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
      }
      return out;
    };
    const offending: string[] = [];
    for (const file of walk(path.join(rootDir, "src"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/useSyncExternalStore\s*(?:<[^>]*>)?\s*\(/g)) {
        const rest = text.slice(match.index! + match[0].length, match.index! + match[0].length + 100).trimStart();
        if (rest.startsWith("(") || rest.startsWith("function") || /^[A-Za-z_$][\w$]*\s*=>/.test(rest)) {
          offending.push(path.relative(rootDir, file));
        }
      }
    }
    expect(offending).toEqual([]);
  });
});

describe("P-72: Markdown preserves settled blocks on stream completion", () => {
  it("keeps settled <Block> DOM nodes mounted when streaming flips true -> false", async () => {
    const { Markdown } = await import("@/components/chat/Markdown");
    const para1 = "First settled paragraph. ".repeat(80) + "\n\n";
    const tail = "Final streaming paragraph.";
    const { container, rerender } = render(<Markdown text={para1 + tail} streaming />);
    const blocksWhileStreaming = container.querySelectorAll(".prose-chat");
    expect(blocksWhileStreaming.length).toBe(2);
    const firstBlockEl = blocksWhileStreaming[0];

    rerender(<Markdown text={para1 + tail + " Done."} streaming={false} />);
    const blocksAfterComplete = container.querySelectorAll(".prose-chat");
    expect(blocksAfterComplete.length).toBe(2);
    // Exact same DOM node -> settled block was NOT unmounted or re-created!
    expect(blocksAfterComplete[0]).toBe(firstBlockEl);
  }, 20_000);
});

describe("P-73: agentEvents LRU eviction and usage_update coalescing", () => {
  const mkEvent = (sessionId: string, tabId: string, seq: number, payload: Payload): AgentEvent => ({
    id: `${sessionId}-${tabId}-${seq}`,
    seq,
    ts: "2026-11-28T00:00:00.000Z",
    sessionId,
    tabId,
    harness: "claude",
    payload,
  });

  it("coalesces transient usage_update events in the same turn while preserving model/contextMax", async () => {
    const { applyEvent, dropTabLog, getTabLog } = await import("@/lib/agentEvents");
    const sid = "p73-usage-sess";
    const tid = "t1";
    dropTabLog(sid, tid);
    applyEvent(mkEvent(sid, tid, 1, { type: "user_message", text: "hi", images: [], queued: false }));
    applyEvent(mkEvent(sid, tid, 2, { type: "usage_update", contextUsed: 1000, contextMax: 200_000, model: "claude-opus-4-6" } as Payload));
    applyEvent(mkEvent(sid, tid, 3, { type: "usage_update", contextUsed: 2500 } as Payload));
    applyEvent(mkEvent(sid, tid, 4, { type: "usage_update", contextUsed: 5000 } as Payload));

    const events = getTabLog(sid, tid).events;
    const usageEvents = events.filter((e) => e.payload.type === "usage_update");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].payload).toMatchObject({
      type: "usage_update",
      contextUsed: 5000,
      contextMax: 200_000,
      model: "claude-opus-4-6",
    });
    dropTabLog(sid, tid);
  });

  it("evicts oldest inactive 0-listener tab logs past MAX_INACTIVE_TAB_LOGS", async () => {
    const { applyEvent, dropTabLog, getTabLog, MAX_INACTIVE_TAB_LOGS } = await import("@/lib/agentEvents");
    const total = MAX_INACTIVE_TAB_LOGS + 6;
    for (let i = 0; i < total; i++) {
      applyEvent(mkEvent("p73-lru", `tab-${i}`, 1, { type: "assistant_text", text: `msg ${i}` }));
    }
    // Oldest tabs beyond the cap should have been evicted.
    expect(getTabLog("p73-lru", "tab-0").events).toEqual([]);
    expect(getTabLog("p73-lru", "tab-1").events).toEqual([]);
    // Most recent tabs remain cached.
    expect(getTabLog("p73-lru", `tab-${total - 1}`).events).toHaveLength(1);
    for (let i = 0; i < total; i++) dropTabLog("p73-lru", `tab-${i}`);
  });
});

describe("P-74: cloudSessions structural comparison and debounced localStorage writes", () => {
  it("compares RuntimeSession lists structurally without JSON.stringify", async () => {
    const { sameRuntimeSessionList } = await import("@/lib/cloudSessions");
    const mk = (modified: string, status: "idle" | "in_progress" = "idle"): RuntimeSession => ({
      id: "s1",
      title: "Work",
      projectPath: "/repo",
      cwd: "/repo",
      created: "2026-11-28T00:00:00Z",
      modified,
      pinned: false,
      archived: false,
      tabs: [{ id: "t1", harness: "claude", title: null, status, model: "claude-opus-4-6", permissionMode: "default", created: "2026-11-28T00:00:00Z", modified }],
    });
    expect(sameRuntimeSessionList([mk("2026-11-28T00:00:01Z")], [mk("2026-11-28T00:00:01Z")])).toBe(true);
    expect(sameRuntimeSessionList([mk("2026-11-28T00:00:01Z")], [mk("2026-11-28T00:00:02Z")])).toBe(false);
    expect(sameRuntimeSessionList([mk("2026-11-28T00:00:01Z", "idle")], [mk("2026-11-28T00:00:01Z", "in_progress")])).toBe(false);
    expect(sameRuntimeSessionList([mk("2026-11-28T00:00:01Z")], undefined)).toBe(false);
  });

  it("debounces rapid session tab selection writes to localStorage", async () => {
    vi.useFakeTimers();
    try {
      const { flushTerminalSelectionPersistence, selectSessionTab } = await import("@/lib/terminal");
      const spy = vi.spyOn(Storage.prototype, "setItem");
      selectSessionTab("p74-sess", { kind: "agent", id: "t1" });
      selectSessionTab("p74-sess", { kind: "agent", id: "t2" });
      selectSessionTab("p74-sess", { kind: "agent", id: "t3" });
      // Rapid flips do not hit localStorage synchronously.
      expect(spy).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(200); });
      expect(spy).toHaveBeenCalledTimes(1);
      // Flushing again with unchanged state does not perform a redundant write.
      flushTerminalSelectionPersistence();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("S-42: TerminalView capture-phase paste handler", () => {
  beforeEach(() => {
    confirmMock.confirmInApp.mockReset();
  });

  it("intercepts paste in capture phase, strips ESC [201~, and confirms multi-line pastes", async () => {
    const pasteSpy = vi.fn();
    const focusSpy = vi.fn();
    const disposeSpy = vi.fn();
    // Mock xterm so createTerminal runs cleanly in jsdom
    vi.doMock("@xterm/xterm", () => ({
      Terminal: class {
        options: Record<string, unknown> = {};
        modes = { bracketedPasteMode: true };
        loadAddon() {}
        open(el: HTMLElement) {
          const ta = document.createElement("textarea");
          ta.className = "xterm-helper-textarea";
          el.appendChild(ta);
        }
        paste = pasteSpy;
        focus = focusSpy;
        dispose = disposeSpy;
      },
    }));
    vi.doMock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
    vi.resetModules();
    const { createTerminal } = await import("@/components/terminal/TerminalView");
    const inst = createTerminal("dark");
    const textarea = inst.el.querySelector("textarea")!;

    const dispatchPaste = (text: string) => {
      const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
      textarea.dispatchEvent(event);
      return event;
    };

    // Single-line paste with ESC control stripped immediately without dialog
    const e1 = dispatchPaste("echo ok\x1b[31m\n");
    expect(e1.defaultPrevented).toBe(true);
    expect(confirmMock.confirmInApp).not.toHaveBeenCalled();
    expect(pasteSpy).toHaveBeenCalledWith("echo ok[31m");

    // Multi-line bracketed-paste breakout: stripped + requires confirmation; cancel blocks paste
    pasteSpy.mockClear();
    confirmMock.confirmInApp.mockResolvedValueOnce(false);
    const e2 = dispatchPaste("ls\x1b[201~\rrm -rf /\n");
    expect(e2.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(confirmMock.confirmInApp).toHaveBeenCalledOnce();
    expect(pasteSpy).not.toHaveBeenCalled();

    // Multi-line paste confirmed -> pastes sanitized text (no ESC)
    confirmMock.confirmInApp.mockResolvedValueOnce(true);
    dispatchPaste("ls\x1b[201~\recho safe");
    await Promise.resolve();
    expect(pasteSpy).toHaveBeenCalledWith("ls[201~\necho safe");

    inst.term.dispose();
    expect(disposeSpy).toHaveBeenCalledOnce();
    vi.doUnmock("@xterm/xterm");
    vi.doUnmock("@xterm/addon-fit");
  });
});
