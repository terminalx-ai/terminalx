import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import type { RecoveryKind } from "@/types/events";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { actionReports, inputOf, reporterFor, useExposure, useInView, type Reporter, type UiReport } from "./recoveryReports";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function recorder(active = true): { reporter: Reporter; said: UiReport[] } {
  const said: UiReport[] = [];
  return { said, reporter: reporterFor("session", "tab", active, async (_session, _tab, report) => { said.push(report); }) };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

describe("useExposure", () => {
  it("tells a window gone to the background, and the warning back on screen as resurfaced", () => {
    const { reporter, said } = recorder();
    const view = renderHook(({ present, reason }: { present: boolean; reason: RecoveryKind | null }) => useExposure({ reporter, surface: "banner", present, reason }), { initialProps: { present: true, reason: "timeout" } });
    setVisibility("hidden");
    setVisibility("visible");
    // A new warning while it is up is a new showing, the old one cleared.
    view.rerender({ present: true, reason: "failed" });
    view.rerender({ present: false, reason: null });
    expect(said.map((r) => [r.phase, r.reason, r.hideReason])).toEqual([
      ["shown", "timeout", undefined], ["hidden", "timeout", "background"], ["resurfaced", "timeout", undefined],
      ["hidden", "timeout", "cleared"], ["shown", "failed", undefined], ["hidden", "failed", "cleared"],
    ]);
    expect(new Set(said.slice(0, 2).map((r) => r.clientId)).size).toBe(1);
    // Labels and numbers only, with the window's own clock.
    for (const report of said) expect(Object.values(report).every((value) => value == null || ["string", "number", "boolean"].includes(typeof value))).toBe(true);
    expect(said[0].at).toEqual(expect.any(Number));
  });

  it("never takes a warning cleared while out of sight to have resurfaced when another of its kind comes", () => {
    const { reporter, said } = recorder();
    const view = renderHook(({ present, inView }: { present: boolean; inView: boolean }) => useExposure({ reporter, surface: "error_row", present, reason: "failed", eventSeq: 9, inView }), { initialProps: { present: true, inView: true } });
    view.rerender({ present: true, inView: false });
    view.rerender({ present: false, inView: false });
    view.rerender({ present: true, inView: true });
    expect(said.map((r) => [r.phase, r.hideReason, r.eventSeq])).toEqual([["shown", undefined, 9], ["hidden", "scrolled", 9], ["shown", undefined, 9]]);
  });

  it("says nothing without a reporter or for a tab behind another", () => {
    const behind = recorder(false);
    renderHook(() => useExposure({ reporter: behind.reporter, surface: "banner", present: true, reason: "timeout" }));
    renderHook(() => useExposure({ reporter: null, surface: "banner", present: true, reason: "timeout" }));
    expect(behind.said).toEqual([]);
  });

  it("is ended by the caller with a dialog's own reason", () => {
    const { reporter, said } = recorder();
    const view = renderHook(({ present }) => useExposure({ reporter, surface: "dialog", present, reason: "failed" }), { initialProps: { present: true } });
    act(() => view.result.current.end("submitted"));
    view.rerender({ present: false });
    view.unmount();
    expect(said.map((r) => [r.phase, r.hideReason])).toEqual([["shown", undefined], ["hidden", "submitted"]]);
  });
});

describe("useInView", () => {
  it("is never in view where the window cannot say", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    let seen: boolean | undefined;
    function Row() {
      const ref = useRef<HTMLDivElement>(null);
      seen = useInView(ref, true);
      return <div ref={ref} />;
    }
    render(<Row />);
    expect(seen).toBe(false);
  });

  it("follows the observer: half in view or more", () => {
    let report: ((entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void) | undefined;
    vi.stubGlobal("IntersectionObserver", class { constructor(callback: typeof report) { report = callback; } observe() {} disconnect() {} });
    let seen: boolean | undefined;
    function Row() {
      const ref = useRef<HTMLDivElement>(null);
      seen = useInView(ref, true);
      return <div ref={ref} />;
    }
    render(<Row />);
    act(() => report!([{ isIntersecting: true, intersectionRatio: 0.6 }]));
    expect(seen).toBe(true);
    act(() => report!([{ isIntersecting: true, intersectionRatio: 0.2 }]));
    expect(seen).toBe(false);
  });
});

describe("actionReports", () => {
  it("tells a start once, its result once, and how it was pressed only when it was told", () => {
    const { reporter, said } = recorder();
    const actions = actionReports(reporter, () => ({ reason: "failed", tabStatus: "waiting", sinceExposureMs: 1200 }));
    actions.pressedWith(inputOf({ detail: 0 }));
    const done = actions.start("continue_new");
    done("ok", { targetSession: "s2", targetTab: "t2" });
    done("failed");
    actions.start("choose_model", "banner");
    expect(said.map((r) => [r.action, r.phase, r.result, r.input, r.targetTab])).toEqual([
      ["continue_new", "start", "accepted", "keyboard", undefined], ["continue_new", "result", "ok", undefined, "t2"], ["choose_model", "start", "accepted", undefined, undefined],
    ]);
    expect(said[0]).toMatchObject({ actor: "human", reason: "failed", tabStatus: "waiting", sinceExposureMs: 1200 });
    expect(said[0].clientId).toBe(said[1].clientId);
    expect(inputOf({ detail: 1 })).toBe("pointer");
  });
});
