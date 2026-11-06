import { describe, expect, it } from "vitest";
import { adjacentSession } from "./sessionNavigation";

describe("next and previous session", () => {
  const sessions = [
    { id: "old", modified: "2026-11-01" },
    { id: "cloud:org:workspace:session", modified: "2026-11-05" },
    { id: "pinned", modified: "2026-10-01", pinned: true },
    { id: "archived", modified: "2026-11-06", archived: true },
  ];
  it("includes local and cloud sessions, skips archives, and wraps in sidebar order", () => {
    expect(adjacentSession(sessions, "pinned", 1)).toBe("cloud:org:workspace:session");
    expect(adjacentSession(sessions, "old", 1)).toBe("pinned");
    expect(adjacentSession(sessions, "pinned", -1)).toBe("old");
  });
  it("enters at either end when no session is selected and handles empty lists", () => {
    expect(adjacentSession(sessions, null, 1)).toBe("pinned");
    expect(adjacentSession(sessions, null, -1)).toBe("old");
    expect(adjacentSession([], null, 1)).toBeNull();
    expect(adjacentSession([sessions[3]], "archived", -1)).toBeNull();
  });
});
