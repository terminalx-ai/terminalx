import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), listIn: vi.fn() }));
vi.mock("@/lib/organizationMembers", () => ({ organizationMembers: { list: mocks.list, listIn: mocks.listIn } }));

import { loadRoster, resetPeople } from "./cloudPeople";

const roster = (userIds: string[]) => ({ members: userIds.map((userId) => ({ userId, email: `${userId}@example.com`, role: "member" })) });

afterEach(() => {
  resetPeople();
  mocks.list.mockReset();
});

describe("the organization roster", () => {
  it("keeps a newer roster when an older read fails after it (#501)", async () => {
    let fail!: (error: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject))).mockResolvedValueOnce(roster(["u-alice"]));
    const older = loadRoster({ fresh: true });
    const newer = await loadRoster({ fresh: true });
    expect(newer.map((member) => member.userId)).toEqual(["u-alice"]);
    fail(new Error("offline"));
    expect(await older).toEqual([]);
    // The newer roster is still the one kept: nothing is read again for it.
    expect((await loadRoster()).map((member) => member.userId)).toEqual(["u-alice"]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});
