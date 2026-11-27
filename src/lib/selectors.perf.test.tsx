import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as paletteMod from "./commandPalette";
import { applyEvent, dropTabLog, useTabLogEvents } from "./agentEvents";
import { getPaletteIndex, upsertSession, useSessionSelector } from "./sessions";
import { removeResourceOptimistically, useStatusSelector } from "./status";

afterEach(() => {
  cleanup();
  dropTabLog("sel-s", "sel-t");
});

describe("narrow selectors & lazy palette index (P-12)", () => {
  it("defers buildPaletteIndex until getPaletteIndex is called", () => {
    const spy = vi.spyOn(paletteMod, "buildPaletteIndex");
    try {
      upsertSession({
        id: "lazy-palette-session",
        title: "Lazy test",
        projectPath: "/repo",
        cwd: "/repo",
        created: "2026-11-27T00:00:00Z",
        modified: "2026-11-27T00:00:00Z",
        archived: false,
        pinned: false,
        worktreeRemoved: false,
        activeTab: "t1",
        tabs: [],
      });
      // Store mutation must NOT eagerly run buildPaletteIndex while the palette is closed.
      expect(spy).not.toHaveBeenCalled();

      const first = getPaletteIndex();
      expect(spy).toHaveBeenCalledTimes(1);
      // Subsequent read with unchanged store slices hits the cache.
      const second = getPaletteIndex();
      expect(second).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("useTabLogEvents ignores 60fps streaming delta frames and only updates on committed events", () => {
    let renders = 0;
    function Probe() {
      renders++;
      const { events, version } = useTabLogEvents("sel-s", "sel-t");
      return <div data-count={events.length} data-ver={version} />;
    }
    const { container } = render(<Probe />);
    expect(renders).toBe(1);

    // Emit streaming deltas: committed events snapshot stays identical -> zero re-renders.
    act(() => {
      applyEvent({
        id: "d1",
        sessionId: "sel-s",
        tabId: "sel-t",
        harness: "claude",
        seq: 1,
        ts: "2026-11-27T10:00:00Z",
        payload: { type: "delta", delta: "text_delta", block: { messageId: "m1", index: 0 }, text: "hi" },
      });
    });
    expect(renders).toBe(1);

    // Emit a committed event: updates immediately.
    act(() => {
      applyEvent({
        id: "c1",
        sessionId: "sel-s",
        tabId: "sel-t",
        harness: "claude",
        seq: 2,
        ts: "2026-11-27T10:00:01Z",
        payload: { type: "user_message", text: "hello", queued: false },
      });
    });
    expect(renders).toBe(2);
    expect(container.firstElementChild?.getAttribute("data-count")).toBe("1");
  });

  it("useStatusSelector & useSessionSelector avoid re-renders on unrelated slice mutations", () => {
    let statusRenders = 0;
    function StatusProbe() {
      statusRenders++;
      const visible = useStatusSelector((s) => s.settings.visible);
      return <span>{String(visible)}</span>;
    }
    let sessionRenders = 0;
    function SessionProbe() {
      sessionRenders++;
      const selected = useSessionSelector((s) => s.selectedSessionId);
      return <span>{selected ?? "none"}</span>;
    }
    render(<><StatusProbe /><SessionProbe /></>);
    expect(statusRenders).toBe(1);
    expect(sessionRenders).toBe(1);

    act(() => {
      removeResourceOptimistically("nonexistent-pane");
    });
    expect(statusRenders).toBe(1);

    act(() => {
      upsertSession({
        id: "unrelated-bg-session",
        title: "Background",
        projectPath: "/repo",
        cwd: "/repo",
        created: "2026-11-27T00:00:00Z",
        modified: "2026-11-27T00:00:00Z",
        archived: false,
        pinned: false,
        worktreeRemoved: false,
        activeTab: "t1",
        tabs: [],
      });
    });
    expect(sessionRenders).toBe(1);
  });
});
