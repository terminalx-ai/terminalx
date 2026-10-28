import { describe, expect, it } from "vitest";
import type { Turn } from "@/lib/transcript";
import { editLineCounts, turnFileChanges } from "./turnChanges";

const call = (edits: object[], isError = false) => ({ callId: "c", name: "Edit", toolType: "file_edit", input: {}, edits, result: { text: "", isError } });

describe("turnFileChanges", () => {
  it("adds up each file's edits in the order the turn touched them", () => {
    const turn = {
      work: [
        { kind: "tool", key: "a", call: call([{ path: "/r/a.css", kind: "update", oldText: "x\ny", newText: "x\nz\nw" }]) },
        { kind: "text", key: "t", text: "ok", seq: 1 },
        { kind: "tool_group", key: "g", name: "Edit", calls: [call([{ path: "/r/b.html", kind: "create", newText: "1\n2" }]), call([{ path: "/r/a.css", kind: "update", oldText: "q", newText: "" }])] },
        { kind: "tool", key: "f", call: call([{ path: "/r/c.ts", kind: "update", oldText: "a", newText: "b" }], true) },
      ],
    } as unknown as Turn;
    expect(turnFileChanges(turn)).toEqual([
      { path: "/r/a.css", kind: "update", added: 2, removed: 2 },
      { path: "/r/b.html", kind: "create", added: 2, removed: 0 },
    ]);
  });

  it("counts a patch's own lines", () => {
    expect(editLineCounts({ unified: "--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n d" })).toEqual({ added: 2, removed: 1 });
  });
});
