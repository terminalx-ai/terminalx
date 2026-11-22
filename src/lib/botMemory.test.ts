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

const { hasRoleDraft, keepRoleDraft, keepRoleDraftsOf, resetRoleDraftsForTests, roleDraft, roleDraftsReachable } = await import("@/lib/botMemory");

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

describe("the quit question and its draft (PRO-512)", () => {
  const draft = { text: "Half written", base: "Before", baseHash: "h1" };

  it("drops the draft of a bot that is no longer one of the bots, and stops asking with the last of them", () => {
    keepRoleDraft("atlas", draft);
    keepRoleDraft("iris", draft);
    keepRoleDraftsOf(["atlas", "iris", "nova"]);
    expect([hasRoleDraft("atlas"), hasRoleDraft("iris"), holds.released]).toEqual([true, true, 0]);
    // Iris was deleted: her draft goes, and Atlas's still asks.
    keepRoleDraftsOf(["atlas", "nova"]);
    expect([hasRoleDraft("atlas"), hasRoleDraft("iris"), holds.released]).toEqual([true, false, 0]);
    keepRoleDraftsOf([]);
    expect([hasRoleDraft("atlas"), holds.released]).toEqual([false, 1]);
    expect(holds.held).toHaveLength(1);
  });

  it("does not ask while Bots is off, keeps the draft, and asks again once Bots is back on", () => {
    keepRoleDraft("atlas", draft);
    roleDraftsReachable(false);
    expect(holds.released).toBe(1);
    expect(roleDraft("atlas")).toEqual(draft);
    // An edit kept while off (none is made from a page, but nothing asks for it either).
    keepRoleDraft("iris", draft);
    expect(holds.held).toHaveLength(1);
    roleDraftsReachable(true);
    expect(holds.held).toHaveLength(2);
    keepRoleDraft("atlas", null);
    keepRoleDraft("iris", null);
    expect(holds.released).toBe(2);
    // Off with no draft, and on again: nothing to ask about.
    roleDraftsReachable(false);
    roleDraftsReachable(true);
    expect([holds.held.length, holds.released]).toEqual([2, 2]);
  });
});
