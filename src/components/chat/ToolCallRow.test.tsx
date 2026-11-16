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

it("counts and displays increment/decrement statements and Markdown separators as patch content", () => {
  const call: ToolCall = {
    callId: "patch", name: "apply_patch", toolType: "file_edit", input: {}, seq: 2,
    edits: [{ path: "/repo/app.ts", kind: "update", unified: "--- a/app.ts\n+++ b/app.ts\n@@ -1,2 +1 @@\n---counter;\n----\n+++counter;\n" }],
    result: { text: "Success", isError: false },
  };
  const { container } = render(<ToolCallRow call={call} defaultOpen />);
  expect(container.textContent).toContain("+1 −2");
  expect(screen.getByText("--counter;")).toBeDefined();
  expect(screen.getByText("++counter;")).toBeDefined();
  expect(screen.getByText("---")).toBeDefined();
  const turn: Turn = { key: "turn", seq: 1, ts: "2026-11-05T12:00:00Z", work: [{ kind: "tool", key: "patch", call }], live: false, toolCount: 1, editedFiles: 1 };
  render(<TurnChanges changes={turnFileChanges(turn)} cwd="/repo" />);
  expect(screen.getByTestId("turn-changes").textContent).toBe("app.ts+1 −2");
});

// PRO-378: what each kind of row says after its target.
import { commitLine, exitCodeOf, gitStep, readLineCount, searchCounts, stepDuration } from "./ToolCallRow";
import { removedFirst, snippetStart, unifiedRows } from "./DiffBlock";
import { fireEvent } from "@testing-library/react";

it("names git steps and reads a commit's hash and message", () => {
  expect(gitStep("git commit -am 'x'")?.done).toBe("Committed");
  expect(gitStep("git push -u origin main")?.running).toBe("Pushing");
  expect(gitStep("git status && git commit")).toBeNull();
  expect(commitLine("[raccoon/make-slugify ede0b4d] Make slugify collapse\n 2 files changed")).toBe("ede0b4d Make slugify collapse");
  expect(commitLine("[main (root-commit) 1a2b3c4] First")).toBe("1a2b3c4 First");
});

it("counts what a search found and the lines a read returned", () => {
  expect(searchCounts("a.rs:88: x\na.rs:90: x\nb.rs:4: x")).toBe("3 matches in 2 files");
  expect(searchCounts("Found 3 files\na\nb\nc")).toBe("3 files");
  expect(searchCounts("No files found")).toBe("no matches");
  expect(searchCounts("a\nb")).toBeNull();
  expect(readLineCount("     1→a\n     2→b\n     3→")).toBe(3);
  expect(readLineCount("plain\ntext\n")).toBe(2);
});

it("says a command's exit status and run time", () => {
  const call = (result: ToolCall["result"]): ToolCall => ({ callId: "c", name: "Bash", toolType: "shell", input: { command: "make" }, seq: 1, result, startedTs: "2026-11-16T10:00:00.000Z", endedTs: "2026-11-16T10:00:01.400Z" });
  expect(exitCodeOf(call({ text: "ok", isError: false }))).toBe(0);
  expect(exitCodeOf(call({ text: "Exit code 2\nboom", isError: true }))).toBe(2);
  expect(exitCodeOf(call({ text: "", isError: false, exitCode: 3 }))).toBe(3);
  expect(stepDuration(1400)).toBe("1.4s");
  expect(stepDuration(18_000)).toBe("18s");
  render(<ToolCallRow call={call({ text: "ok", isError: false })} />);
  expect(screen.getByTestId("tool-exit").textContent).toBe("exit 0 · 1.4s");
});

it("leaves a zero side out of an edit's counts, and shows no result box under its diff", () => {
  const call: ToolCall = { callId: "w", name: "Write", toolType: "file_write", input: { file_path: "/repo/a.ts" }, seq: 1, edits: [{ path: "/repo/a.ts", kind: "create", oldText: "", newText: "a\nb" }], result: { text: "ok", isError: false } };
  render(<ToolCallRow call={call} cwd="/repo" />);
  expect(screen.getByTestId("edit-counts").textContent).toBe("+2");
  fireEvent.click(screen.getByRole("button", { name: /^Expand Wrote/ }));
  expect(screen.getByTestId("diff-block").textContent).not.toContain("a.ts");
  expect(screen.queryByText("ok")).toBeNull();
});

it("orders a diff's removed lines before the added ones and numbers it where the file says", () => {
  expect(removedFirst([{ kind: "ctx", text: "a" }, { kind: "add", text: "b" }, { kind: "del", text: "c" }]).map((l) => l.kind)).toEqual(["ctx", "del", "add"]);
  expect(snippetStart("Here's the result:\n    41→one\n    42→two", "one\ntwo")).toBe(41);
  expect(snippetStart("    41→one", "missing")).toBeNull();
  expect(unifiedRows("@@ -10,2 +10,2 @@\n ctx\n+new\n-old").map((l) => `${l.kind}${l.oldNo ?? ""}/${l.newNo ?? ""}`)).toEqual(["ctx10/10", "del11/", "add/11"]);
});

it("leaves an edit's diff unnumbered when its result quotes no snippet, rather than guess from the file", () => {
  const call: ToolCall = { callId: "e", name: "Edit", toolType: "file_edit", input: { file_path: "/repo/a.ts" }, seq: 1, edits: [{ path: "/repo/a.ts", kind: "update", oldText: "a", newText: "b" }], result: { text: "The file /repo/a.ts has been updated successfully.", isError: false } };
  render(<ToolCallRow call={call} cwd="/repo" />);
  fireEvent.click(screen.getByRole("button", { name: /^Expand Edited/ }));
  expect([...screen.getByTestId("diff-block").querySelectorAll("[data-diff-line]")].map((row) => row.textContent)).toEqual(["−a", "+b"]);
});
