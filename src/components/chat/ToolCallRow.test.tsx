import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolCallRow } from "./ToolCallRow";
import type { ToolCall, Turn } from "@/lib/transcript";
import { TurnChanges } from "./TurnChanges";
import { turnFileChanges } from "@/lib/turnChanges";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

it("counts an apply_patch edit from its patch body, matching its file chip", () => {
  const call: ToolCall = {
    callId: "patch", name: "apply_patch", toolType: "file_edit", input: {}, seq: 2,
    edits: [{ path: "/repo/app.ts", kind: "update", unified: "@@\n-old\n" + Array.from({ length: 24 }, (_, i) => `+line ${i}`).join("\n") }],
    result: { text: "Success", isError: false },
  };
  const { container } = render(<ToolCallRow call={call} cwd="/repo" />);
  expect(container.textContent).toContain("+24 −1");
  const turn: Turn = { key: "turn", seq: 1, ts: "2026-11-05T12:00:00Z", work: [{ kind: "tool", key: "patch", call }], live: false, toolCount: 1, editedFiles: 1 };
  render(<TurnChanges changes={turnFileChanges(turn)} cwd="/repo" />);
  expect(screen.getByTestId("turn-changes").textContent).toBe("app.ts+24 −1");
});

it("adds counts across files and hunks without counting patch headers or context", () => {
  const call: ToolCall = {
    callId: "patch", name: "apply_patch", toolType: "file_edit", input: {}, seq: 2,
    edits: [
      { path: "/repo/app.ts", kind: "update", unified: "--- a/app.ts\n+++ b/app.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n@@ -20 +20,2 @@\n-other\n+one\n+two\n" },
      { path: "/repo/new.ts", kind: "create", unified: "+first\n+second\n" },
      { path: "/repo/old.ts", kind: "delete", unified: "-gone\n" },
    ],
    result: { text: "Success", isError: false },
  };
  const { container } = render(<ToolCallRow call={call} />);
  expect(container.textContent).toContain("+5 −3");
});

it("counts only changed lines in old/new text edits, matching file chips", () => {
  const call: ToolCall = {
    callId: "edit", name: "Edit", toolType: "file_edit", input: {}, seq: 2,
    edits: [{ path: "/repo/app.ts", kind: "update", oldText: "context\nold\nend\n", newText: "context\nnew\nextra\nend\n" }],
    result: { text: "Success", isError: false },
  };
  const { container } = render(<ToolCallRow call={call} />);
  expect(container.textContent).toContain("+2 −1");
});
