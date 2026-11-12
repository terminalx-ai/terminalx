import { afterEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ handler: null as null | ((event: { payload: unknown }) => void), answer: false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string) => (command === "reduce_transparency" ? events.answer : undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { if (name === "reduce_transparency_changed") events.handler = handler; return () => {}; }) }));

import { applyReduceTransparency, followReduceTransparency } from "./glass";

const state = (root: HTMLElement) => ({ glass: root.hasAttribute("data-glass"), reduce: root.hasAttribute("data-reduce-transparency") });

describe("glass mode and Reduce transparency", () => {
  afterEach(() => { events.handler = null; events.answer = false; });

  it("is glass on a Mac only while Reduce transparency is off", () => {
    const root = document.createElement("html");
    applyReduceTransparency(root, false, true);
    expect(state(root)).toEqual({ glass: true, reduce: false });
    applyReduceTransparency(root, true, true);
    expect(state(root)).toEqual({ glass: false, reduce: true });
    applyReduceTransparency(root, false, false);
    expect(state(root)).toEqual({ glass: false, reduce: false });
  });

  it("asks the native side on load and follows each change it sends", async () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    const root = document.createElement("html");
    root.setAttribute("data-glass", "");
    events.answer = true;
    followReduceTransparency(root);
    await vi.waitFor(() => expect(state(root)).toEqual({ glass: false, reduce: true }));
    events.handler!({ payload: false });
    expect(state(root)).toEqual({ glass: true, reduce: false });
    events.handler!({ payload: true });
    expect(state(root)).toEqual({ glass: false, reduce: true });
  });
});
