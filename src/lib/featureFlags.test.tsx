import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";

const account = vi.hoisted(() => ({ status: {} as AccountStatus, listeners: new Set<() => void>() }));
vi.mock("@/lib/account", () => ({
  getAccount: () => ({ status: account.status }),
  subscribeAccount: (listener: () => void) => {
    account.listeners.add(listener);
    return () => account.listeners.delete(listener);
  },
}));

import { featureFlagEnabled, featureFlags, useFeatureFlag } from "@/lib/featureFlags";

const signedIn = (): AccountStatus => ({
  state: "signed-in", identity: { email: "person@example.test", name: "Person", organization: "A", organizationId: "a" },
  expiresAt: null, lastError: null,
  organizations: [
    { id: "a", name: "A", role: "member", cloud: { enabled: true, flags: { [featureFlags.teamRoster]: true } } },
    { id: "b", name: "B", role: "owner", cloud: { enabled: true, flags: { [featureFlags.teamRoster]: false } } },
  ],
});
function refresh(status: AccountStatus) {
  act(() => { account.status = status; account.listeners.forEach((listener) => listener()); });
}
beforeEach(() => { account.status = signedIn(); });
afterEach(cleanup);

describe("feature flags", () => {
  it("defaults missing flags, older server fields, unknown keys and missing memberships to off", () => {
    const status = signedIn();
    expect(featureFlagEnabled(status, featureFlags.teamEvents)).toBe(false);
    expect(featureFlagEnabled(status, featureFlags.teamRoster, "left-org")).toBe(false);
    expect(featureFlagEnabled(status, featureFlags.teamRoster, null)).toBe(false);
    expect(featureFlagEnabled({ ...status, organizations: undefined }, featureFlags.teamRoster)).toBe(false);
    expect(featureFlagEnabled({ ...status, organizations: [{ id: "a", name: "A", role: "owner" }] }, featureFlags.teamRoster)).toBe(false);
    expect(featureFlagEnabled(status, "unknown" as typeof featureFlags.teamRoster)).toBe(false);
  });

  it("uses each organization's flags independently of its role or active selection", () => {
    const { result, rerender } = renderHook(({ orgId }) => useFeatureFlag(featureFlags.teamRoster, orgId), { initialProps: { orgId: "a" } });
    expect(result.current).toBe(true);
    rerender({ orgId: "b" });
    expect(result.current).toBe(false);
    expect(featureFlagEnabled(signedIn(), featureFlags.teamRoster)).toBe(true);
  });

  it.each([featureFlags.teamEvents, featureFlags.teamRoster])("removes an already mounted %s surface in one capability refresh", (flag) => {
    const status = signedIn();
    status.organizations![0].cloud!.flags[flag] = true;
    account.status = status;
    function Surface() { return useFeatureFlag(flag, "a") ? <button>Team feature</button> : null; }
    render(<Surface />);
    expect(screen.getByRole("button")).toBeTruthy();
    const next = signedIn();
    next.organizations![0].cloud!.flags[flag] = false;
    refresh(next);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("responds to active organization changes, removal, sign-out and another account", () => {
    const { result } = renderHook(() => useFeatureFlag(featureFlags.teamRoster));
    expect(result.current).toBe(true);
    refresh({ ...signedIn(), identity: { ...signedIn().identity!, organizationId: "b" } });
    expect(result.current).toBe(false);
    refresh(signedIn());
    expect(result.current).toBe(true);
    refresh({ ...signedIn(), organizations: [] });
    expect(result.current).toBe(false);
    refresh({ ...signedIn(), state: "signed-out" });
    expect(result.current).toBe(false);
    refresh({ ...signedIn(), identity: { email: "other@example.test", name: null, organization: null }, organizations: [] });
    expect(result.current).toBe(false);
  });

  it("reacts to omission on refresh and unsubscribes on unmount", () => {
    const { result, unmount } = renderHook(() => useFeatureFlag(featureFlags.teamRoster, "a"));
    expect(result.current).toBe(true);
    const status = signedIn();
    status.organizations![0].cloud!.flags = {};
    refresh(status);
    expect(result.current).toBe(false);
    unmount();
    expect(account.listeners.size).toBe(0);
  });
});
