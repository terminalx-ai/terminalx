import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationRoster } from "./organizationMembers";
const mocks = vi.hoisted(() => ({ list: vi.fn(), listIn: vi.fn() }));
vi.mock("@/lib/organizationMembers", () => ({ organizationMembers: mocks }));
import { cachedOrganizationRosters, forgetOrganizationRoster, invalidateOrganizationRoster, readOrganizationRoster, replaceOrganizationRoster, resetOrganizationRosters, ROSTER_MAX_AGE_MS, setRosterContext, useOrganizationRoster } from "./organizationRoster";
const roster = (id = "alice"): OrganizationRoster => ({ members: [{ userId: id, email: `${id}@example.com`, displayName: id, role: "member", photoUrl: `https://example.com/${id}.png`, createdAt: 1234 }], pendingInvites: [], viewerRole: "member", canManageMembers: false, contextRevision: "revision" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { setRosterContext("active", "revision", ["active", "org-a", "org-b"]); mocks.list.mockReset().mockResolvedValue(roster()); mocks.listIn.mockReset().mockResolvedValue(roster()); });
afterEach(() => { cleanup(); resetOrganizationRosters(); vi.useRealTimers(); });
describe("organization roster cache", () => {
  it("coalesces concurrent consumers, reuses results and separates organizations", async () => {
    const [first, second] = await Promise.all([readOrganizationRoster("org-a"), readOrganizationRoster("org-a")]);
    expect(first).toBe(second);
    expect(await readOrganizationRoster("org-a")).toBe(first);
    expect(mocks.listIn).toHaveBeenCalledTimes(1);
    expect(first.members[0]).toMatchObject({ photoUrl: "https://example.com/alice.png", createdAt: 1234 });
    await readOrganizationRoster("org-b");
    expect(mocks.listIn).toHaveBeenCalledTimes(2);
  });
  it("shares active organization reads with its explicit organization id", async () => {
    setRosterContext("org-a", "rev-a", ["org-a"]);
    await readOrganizationRoster();
    await readOrganizationRoster("org-a");
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.listIn).not.toHaveBeenCalled();
  });
  it("refreshes expired rosters and replaces removed members", async () => {
    vi.useFakeTimers();
    await readOrganizationRoster("org-a");
    mocks.listIn.mockResolvedValue(roster("bob"));
    vi.advanceTimersByTime(ROSTER_MAX_AGE_MS);
    expect((await readOrganizationRoster("org-a")).members.map((member) => member.userId)).toEqual(["bob"]);
  });
  it("refreshes subscribed consumers on membership events", async () => {
    const { result } = renderHook(() => useOrganizationRoster("org-a"));
    await act(() => readOrganizationRoster("org-a"));
    mocks.listIn.mockResolvedValue(roster("bob"));
    act(() => invalidateOrganizationRoster("org-a"));
    await waitFor(() => expect(result.current.roster?.members[0].userId).toBe("bob"));
  });
  it("does not let a late refresh overwrite a mutation", async () => {
    const pending = deferred<OrganizationRoster>();
    mocks.listIn.mockReturnValueOnce(pending.promise);
    const old = readOrganizationRoster("org-a");
    replaceOrganizationRoster("org-a", roster("bob"), "rev");
    pending.resolve(roster());
    expect((await old).members[0].userId).toBe("bob");
    expect((await readOrganizationRoster("org-a")).members[0].userId).toBe("bob");
  });
  it("discards late reads after sign-out and after leaving an organization", async () => {
    for (const clear of [() => resetOrganizationRosters(), () => forgetOrganizationRoster("org-a")]) {
      setRosterContext("active", "revision", ["org-a"]);
      const pending = deferred<OrganizationRoster>();
      mocks.listIn.mockReturnValueOnce(pending.promise);
      const old = readOrganizationRoster("org-a");
      clear();
      pending.resolve(roster());
      await expect(old).rejects.toMatchObject({ code: "account_context_changed" });
      expect(cachedOrganizationRosters()).toEqual([]);
    }
  });
  it("drops cached details on access refusal and retries failed reads", async () => {
    await readOrganizationRoster("org-a");
    mocks.listIn.mockRejectedValueOnce({ code: "forbidden" });
    await expect(readOrganizationRoster("org-a", { fresh: true })).rejects.toMatchObject({ code: "forbidden" });
    expect(cachedOrganizationRosters()).toEqual([]);
    expect((await readOrganizationRoster("org-a")).members).toHaveLength(1);
  });
  it("re-reads a read-only cache before allowing active organization mutations", async () => {
    await readOrganizationRoster("org-a");
    await readOrganizationRoster("org-a", { active: true, contextRevision: "new-context" });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});

it("does not cache or poll when the flag is missing", async () => {
  setRosterContext("org-a", "rev-a", []);
  vi.useFakeTimers();
  renderHook(() => useOrganizationRoster("org-a", false));
  await readOrganizationRoster("org-a");
  await readOrganizationRoster("org-a");
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(cachedOrganizationRosters()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("a same-revision rollout kill clears data, stops polling and retires pending responses", async () => {
  vi.useFakeTimers();
  renderHook(() => useOrganizationRoster("org-a"));
  await act(() => readOrganizationRoster("org-a"));
  const pending = deferred<OrganizationRoster>();
  mocks.listIn.mockReturnValueOnce(pending.promise);
  let old!: Promise<OrganizationRoster>;
  act(() => { old = readOrganizationRoster("org-a", { fresh: true }); });
  act(() => setRosterContext("active", "revision", []));
  expect(cachedOrganizationRosters()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  pending.resolve(roster());
  await expect(old).rejects.toMatchObject({ code: "account_context_changed" });
  expect(cachedOrganizationRosters()).toEqual([]);
});

it("does not let a mutation repopulate a killed or different account cache", async () => {
  const { mutateOrganizationRoster } = await import("./organizationRoster");
  for (const clear of [() => setRosterContext("active", "revision", []), () => resetOrganizationRosters()]) {
    setRosterContext("active", "revision", ["org-a"]);
    const pending = deferred<OrganizationRoster>();
    const saved = mutateOrganizationRoster("org-a", "revision", () => pending.promise);
    clear();
    pending.resolve(roster());
    await saved;
    expect(cachedOrganizationRosters()).toEqual([]);
  }
});
