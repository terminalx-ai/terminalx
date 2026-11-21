import { afterEach, describe, expect, it, vi } from "vitest";

const holds = vi.hoisted(() => ({ held: [] as string[], released: 0 }));
vi.mock("@/lib/quitWarning", () => ({
  holdQuit: (warning: string) => {
    holds.held.push(warning);
    return () => {
      holds.released += 1;
    };
  },
}));

const { keepRoleDraft, resetRoleDraftsForTests } = await import("@/lib/botMemory");

afterEach(() => {
  resetRoleDraftsForTests();
  holds.held.length = 0;
  holds.released = 0;
});

describe("unsaved role drafts (PRO-491)", () => {
  it("ask before quitting while any is unsaved, and stop asking once none is", () => {
    keepRoleDraft("atlas", { text: "Half written", base: "Before", baseHash: "h1" });
    keepRoleDraft("iris", { text: "Also unsaved", base: "Before", baseHash: "h2" });
    expect(holds.held).toEqual(["A bot's standing instructions have unsaved changes. If you quit now, they are lost."]);
    keepRoleDraft("atlas", null);
    expect(holds.released).toBe(0);
    // Back to its saved text is no draft either.
    keepRoleDraft("iris", { text: "Before", base: "Before", baseHash: "h2" });
    expect(holds.released).toBe(1);
  });
});
