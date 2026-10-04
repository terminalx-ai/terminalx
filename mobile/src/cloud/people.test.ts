import { describe, expect, it, vi } from "vitest";
import { CloudPeople } from "./people";

describe("names for the people of a shared workspace", () => {
  it("learns names from the organization's members and from shares, and falls back to a short id", async () => {
    const members = vi.fn(async () => [{ userId: "u-alice-0123456789", email: "alice@example.com", displayName: "Alice", role: "member" }, { userId: "u-bob", email: "bob@example.com", role: "member" }]);
    const people = new CloudPeople({ members });
    const seen = vi.fn();
    people.subscribe(seen);
    expect(people.name("u-alice-0123456789")).toBe("User u-alice-");
    expect(people.name(null)).toBe("Someone");
    await people.roster("org-1");
    await people.roster("org-1");
    expect(members).toHaveBeenCalledTimes(1);
    expect(people.name("u-alice-0123456789")).toBe("Alice");
    expect(people.name("u-bob")).toBe("bob@example.com");
    expect(seen).toHaveBeenCalledTimes(1);
    people.remember([{ userId: "u-carol", name: "Carol", email: "carol@example.com" }, { userId: "u-bob", email: "bob@example.com" }]);
    expect(people.name("u-carol")).toBe("Carol");
    expect(people.getVersion()).toBe(2);
  });

  it("says so when the members cannot be read, and tries again next time", async () => {
    const members = vi.fn().mockRejectedValueOnce(new Error("forbidden")).mockResolvedValueOnce([]);
    const people = new CloudPeople({ members });
    await expect(people.roster("org-1")).rejects.toThrow("forbidden");
    expect(await people.roster("org-1")).toEqual([]);
  });
});
