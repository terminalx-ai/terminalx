import { describe, expect, it } from "vitest";
import { resolveSessionTab } from "./visibleTab";

describe("the tab a session shows", () => {
  const tabs = { agentIds: ["a1", "a2"], terminalIds: ["t1"] };

  it("is the requested tab while it exists", () => {
    expect(resolveSessionTab({ ...tabs, requested: { kind: "terminal", id: "t1" } })).toEqual({ kind: "terminal", id: "t1" });
    expect(resolveSessionTab({ ...tabs, requested: { kind: "agent", id: "a2" } })).toEqual({ kind: "agent", id: "a2" });
    expect(resolveSessionTab({ ...tabs, browserIds: ["b1"], requested: { kind: "browser", id: "b1" } })).toEqual({ kind: "browser", id: "b1" });
  });

  it("falls back to the active agent tab, then the first, when the requested one is gone", () => {
    expect(resolveSessionTab({ ...tabs, activeTab: "a2", requested: { kind: "terminal", id: "closed" } })).toEqual({ kind: "agent", id: "a2" });
    expect(resolveSessionTab({ ...tabs, activeTab: "gone", requested: undefined })).toEqual({ kind: "agent", id: "a1" });
    expect(resolveSessionTab({ ...tabs, requested: { kind: "browser", id: "b1" } })).toEqual({ kind: "agent", id: "a1" });
  });

  it("stays on the tab already shown when the session's active tab moves (someone else added a tab)", () => {
    const current = { kind: "agent", id: "a1" } as const;
    // Nothing was picked here: the view was on a1, and a2 was just added and made active by someone else.
    expect(resolveSessionTab({ ...tabs, current, activeTab: "a2", requested: undefined })).toEqual(current);
    // A tab picked here wins over the one shown.
    expect(resolveSessionTab({ ...tabs, current, activeTab: "a1", requested: { kind: "agent", id: "a2" } })).toEqual({ kind: "agent", id: "a2" });
    // The shown tab closed: back to the active one.
    expect(resolveSessionTab({ agentIds: ["a2"], terminalIds: [], current, activeTab: "a2", requested: undefined })).toEqual({ kind: "agent", id: "a2" });
    expect(resolveSessionTab({ ...tabs, current: { kind: "terminal", id: "t1" }, activeTab: "a2", requested: undefined })).toEqual({ kind: "terminal", id: "t1" });
    // Without a shown tab (a local session never passes one) the active tab decides, as before.
    expect(resolveSessionTab({ ...tabs, current: null, activeTab: "a2", requested: undefined })).toEqual({ kind: "agent", id: "a2" });
  });

  it("is the first terminal in a session with no agent tab, and nothing in an empty one", () => {
    expect(resolveSessionTab({ agentIds: [], terminalIds: ["t1", "t2"], requested: undefined })).toEqual({ kind: "terminal", id: "t1" });
    expect(resolveSessionTab({ agentIds: [], terminalIds: [], requested: { kind: "agent", id: "a1" } })).toBeNull();
  });
});
