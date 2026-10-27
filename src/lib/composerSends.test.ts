import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { beginComposerSend, clearComposerSendError, composerSendScope, finishComposerSend, useComposerSend } from "./composerSends";
import { setDraft } from "./drafts";

afterEach(cleanup);

it("retains request ownership without subscribers, isolates scopes and ignores stale settlement", () => {
  const key = "store-owner";
  setDraft("store-tab", "P");
  const first = beginComposerSend(key, "store-tab")!;
  expect(beginComposerSend(key, "store-tab")).toBeNull();
  const other = beginComposerSend("other-owner", "other-tab")!;
  setDraft("store-tab", "P");
  expect(first.ownsDraft()).toBe(false);
  expect(other.ownsDraft()).toBe(true);
  const failure = new Error("disconnected");
  finishComposerSend(key, first, failure);
  const view = renderHook(() => useComposerSend(key));
  expect(view.result.current.error).toBe(failure);
  let second!: NonNullable<ReturnType<typeof beginComposerSend>>;
  act(() => { second = beginComposerSend(key, "store-tab")!; });
  expect(view.result.current.error).toBeNull();
  act(() => finishComposerSend(key, first, failure));
  expect(view.result.current.pending).toBe(second);
  act(() => finishComposerSend(key, second));
  finishComposerSend("other-owner", other);
  expect(view.result.current.pending).toBeNull();
});

it("keeps failure for remount and clears it on explicit recovery", () => {
  const request = beginComposerSend("recovery-owner", "recovery-tab")!;
  finishComposerSend("recovery-owner", request, new Error("disconnected"));
  const first = renderHook(() => useComposerSend("recovery-owner"));
  expect(first.result.current.error).toBeInstanceOf(Error);
  first.unmount();
  const second = renderHook(() => useComposerSend("recovery-owner"));
  expect(second.result.current.error).toBeInstanceOf(Error);
  act(() => clearComposerSendError("recovery-owner"));
  expect(second.result.current.error).toBeNull();
});

it("keeps the same mailbox owner through generations while fencing distinct destinations", () => {
  const backend = { kind: "cloud", key: "cloud:scope-org:scope-ws:scope-session", logSessionId: "scope-session", generation: "g1" };
  const key = composerSendScope(backend, "scope-tab");
  const operation = beginComposerSend(key, "scope-tab")!;
  const reconnected = { ...backend, generation: "g2" };
  expect(composerSendScope(reconnected, "scope-tab")).toBe(key);
  expect(beginComposerSend(composerSendScope(reconnected, "scope-tab"), "scope-tab")).toBeNull();
  const destinations = [
    { backend: { ...backend, kind: "local" }, tab: "scope-tab" },
    { backend: { ...backend, key: "cloud:other-org:scope-ws:scope-session" }, tab: "scope-tab" },
    { backend: { ...backend, key: "cloud:scope-org:other-ws:scope-session" }, tab: "scope-tab" },
    { backend: { ...backend, key: "cloud:scope-org:scope-ws:other-session" }, tab: "scope-tab" },
    { backend: { ...backend, logSessionId: "other-runtime-session" }, tab: "scope-tab" },
    { backend, tab: "other-tab" },
  ];
  for (const destination of destinations) {
    const distinct = composerSendScope(destination.backend, destination.tab);
    expect(distinct).not.toBe(key);
    const other = beginComposerSend(distinct, destination.tab)!;
    expect(other).not.toBeNull();
    finishComposerSend(distinct, other);
  }
  const failure = new Error("g1 refused");
  finishComposerSend(key, operation, failure);
  const view = renderHook(() => useComposerSend(composerSendScope(reconnected, "scope-tab")));
  expect(view.result.current.error).toBe(failure);
  act(() => clearComposerSendError(key));
});
