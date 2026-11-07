import { describe, expect, it } from "vitest";
import { groupLocalSessions } from "./localSections";
import type { SessionEntry } from "@/types/session";

const session = (id: string) => ({ id } as SessionEntry);
describe("local section membership", () => {
  it("preserves section and session order, ignores missing sessions, and puts each session in one section", () => {
    const items = [session("new"), session("old"), session("main")];
    const grouped = groupLocalSessions(items, [
      { id: "b", name: "Release", sessions: ["old", "new", "missing"] },
      { id: "a", name: "Bugs", sessions: ["new"] },
    ]);
    expect(grouped.sections.map(({ section, items }) => [section.id, items.map((item) => item.id)])).toEqual([["b", ["new", "old"]], ["a", []]]);
    expect(grouped.ungrouped.map((item) => item.id)).toEqual(["main"]);
    expect(groupLocalSessions(items, []).ungrouped).toEqual(items);
  });
});
