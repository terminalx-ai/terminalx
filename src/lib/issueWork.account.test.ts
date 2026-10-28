import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus, WorkClaimsAnswer } from "@/lib/api";

const state = vi.hoisted(() => ({
  account: { status: {} as AccountStatus, ready: true, busy: false },
  listeners: new Set<() => void>(),
  claims: vi.fn(),
}));
vi.mock("@/lib/account", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<typeof import("@/lib/account")>()),
    useAccount: () => useSyncExternalStore(
      (listener) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
      () => state.account,
    ),
  };
});
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, workStatus: { ...actual.workStatus, claims: state.claims } };
});
import { useWorkClaims } from "@/lib/issueWork";

const urls = ["https://github.com/acme/widgets/issues/441"];
const supported: WorkClaimsAnswer = { available: true, now: 1, liveForSeconds: 300, claims: [] };
const unsupported: WorkClaimsAnswer = { ...supported, available: false, reason: "unsupported" };
const status: AccountStatus = {
  state: "signed-in", identity: null, expiresAt: null, lastError: null,
  context: { account: "user:profile", scope: "scope", revision: "revision" }, workClaims: false,
};
function announce(patch: Partial<AccountStatus>) {
  act(() => {
    state.account = { ...state.account, status: { ...state.account.status, ...patch } };
    for (const listener of state.listeners) listener();
  });
}
beforeEach(() => {
  state.account = { status, ready: true, busy: false };
  state.claims.mockReset().mockResolvedValue(unsupported);
});
afterEach(cleanup);

it("re-reads on a same-account capability announcement without waiting for polling", async () => {
  const view = renderHook(() => useWorkClaims("/repo", "github", urls));
  await waitFor(() => expect(view.result.current.answer).toEqual(unsupported));
  state.claims.mockResolvedValue(supported);
  announce({ workClaims: true });
  await waitFor(() => expect(view.result.current.answer).toEqual(supported));
  expect(state.claims).toHaveBeenCalledTimes(2);
  announce({ workClaims: true });
  expect(state.claims).toHaveBeenCalledTimes(2);
});

it("drops the old answer immediately and refuses a late read after capability withdrawal", async () => {
  state.account = { ...state.account, status: { ...status, workClaims: true } };
  let finish!: (answer: WorkClaimsAnswer) => void;
  state.claims.mockImplementationOnce(() => new Promise<WorkClaimsAnswer>((resolve) => { finish = resolve; }));
  const view = renderHook(() => useWorkClaims("/repo", "github", urls));
  await waitFor(() => expect(state.claims).toHaveBeenCalledTimes(1));
  announce({ workClaims: false });
  await waitFor(() => expect(view.result.current.answer).toEqual(unsupported));
  await act(async () => { finish(supported); });
  expect(view.result.current.answer).toEqual(unsupported);
});

it("fences account replacement and sign-out even for readers without an explicit account scope", async () => {
  state.claims.mockResolvedValue(supported);
  const view = renderHook(() => useWorkClaims("/repo", "github", urls));
  await waitFor(() => expect(view.result.current.answer).toEqual(supported));
  state.claims.mockImplementation(() => new Promise<WorkClaimsAnswer>(() => {}));
  announce({ context: { ...status.context!, account: "other:profile" } });
  expect(view.result.current.answer).toBeNull();
  await waitFor(() => expect(state.claims).toHaveBeenCalledTimes(2));
  state.claims.mockResolvedValue({ ...unsupported, reason: "signed_out" });
  announce({ state: "signed-out", context: undefined });
  await waitFor(() => expect(view.result.current.answer?.reason).toBe("signed_out"));
});
