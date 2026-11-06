import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PermissionCard, QuestionCard } from "./AskCards";
import { setPrefs } from "@/lib/prefs";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PendingAsk } from "@/lib/transcript";
import { ToolCallRow } from "./ToolCallRow";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn() }));
afterEach(cleanup);

it("opens a choice's link without selecting an answer and retains keyboard selection", () => {
  const answer = vi.fn();
  const { container } = render(<QuestionCard ask={{ kind: "questions", requestId: "q", toolUseId: "call", seq: 1, questions: [{ question: "Choose a source", multiSelect: false, freeText: false, options: [{ label: "Documentation", description: "Read https://example.com/docs" }] }] }} onAnswer={answer} />);
  fireEvent.click(screen.getByRole("link", { name: "https://example.com/docs" }));
  expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  const choice = screen.getByRole("button", { name: "Documentation" });
  expect(choice.getAttribute("aria-pressed")).toBe("false");
  expect(answer).not.toHaveBeenCalled();
  fireEvent.click(choice);
  fireEvent.click(screen.getByRole("button", { name: /Answer/ }));
  expect(answer).toHaveBeenCalledWith({ "Choose a source": "Documentation" });
  expect(container.querySelector("button a")).toBeNull();
});

it("follows Settings → Autocorrect in the free-text answer, which goes to the agent like a prompt (#525)", () => {
  act(() => setPrefs({ autocorrect: false }));
  render(<QuestionCard ask={{ kind: "questions", requestId: "q", toolUseId: "call", seq: 1, questions: [{ question: "Which flag?", multiSelect: false, freeText: true, options: [{ label: "--force" }] }] }} onAnswer={vi.fn()} />);
  const answer = screen.getByPlaceholderText("Or type your own answer");
  expect([answer.getAttribute("spellcheck"), answer.getAttribute("autocorrect"), answer.getAttribute("autocapitalize")]).toEqual(["false", "off", "off"]);

  act(() => setPrefs({ autocorrect: true }));
  expect(["spellcheck", "autocorrect", "autocapitalize"].filter((name) => answer.hasAttribute(name))).toEqual([]);
  act(() => setPrefs({ autocorrect: false }));
});

type Question = NonNullable<Parameters<typeof QuestionCard>[0]["ask"]["questions"]>[number];
const questionsAsk = (questions: Question[]) => ({ kind: "questions" as const, requestId: "q", toolUseId: "call", seq: 1, questions });
const pressed = (name: string) => screen.getAllByRole("button", { name }).map((b) => b.getAttribute("aria-pressed"));

it("marks a single choice whose label holds \", \" as selected, and answers with the whole label (#703)", () => {
  const answer = vi.fn();
  render(<QuestionCard ask={questionsAsk([{ question: "How should we ship?", multiSelect: false, freeText: true, options: [{ label: "Local first, publish later (Recommended)" }, { label: "Publish now" }] }])} onAnswer={answer} />);
  fireEvent.click(screen.getByRole("button", { name: "Local first, publish later (Recommended)" }));
  expect(pressed("Local first, publish later (Recommended)")).toEqual(["true"]);
  expect(pressed("Publish now")).toEqual(["false"]);

  fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
  fireEvent.click(screen.getByRole("button", { name: "Local first, publish later (Recommended)" }));
  expect(pressed("Local first, publish later (Recommended)")).toEqual(["true"]);
  expect(pressed("Publish now")).toEqual(["false"]);
  fireEvent.click(screen.getByRole("button", { name: /Answer/ }));
  expect(answer).toHaveBeenCalledWith({ "How should we ship?": "Local first, publish later (Recommended)" });
});

it("ticks and unticks multi-select choices whose labels hold \", \" without disturbing the others (#703)", () => {
  const answer = vi.fn();
  render(<QuestionCard ask={questionsAsk([{ question: "Which steps?", multiSelect: true, freeText: false, options: [{ label: "Lint, then format" }, { label: "Test" }, { label: "Build, sign, notarise" }, { label: "Publish" }] }])} onAnswer={answer} />);
  for (const name of ["Lint, then format", "Build, sign, notarise", "Test", "Publish"]) fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(screen.getByRole("button", { name: "Build, sign, notarise" }));
  expect(["Lint, then format", "Test", "Build, sign, notarise", "Publish"].map((name) => pressed(name)[0])).toEqual(["true", "true", "false", "true"]);

  fireEvent.click(screen.getByRole("button", { name: "Lint, then format" }));
  fireEvent.click(screen.getByRole("button", { name: "Build, sign, notarise" }));
  expect(["Lint, then format", "Test", "Build, sign, notarise", "Publish"].map((name) => pressed(name)[0])).toEqual(["false", "true", "true", "true"]);
  fireEvent.click(screen.getByRole("button", { name: /Answer/ }));
  expect(answer).toHaveBeenCalledWith({ "Which steps?": "Test, Publish, Build, sign, notarise" });
});

it("chooses equal option labels, and questions with equal text, independently (#703)", () => {
  const answer = vi.fn();
  render(
    <QuestionCard
      ask={questionsAsk([
        { question: "Keep the cache?", multiSelect: true, freeText: false, options: [{ label: "Yes", description: "On this machine" }, { label: "Yes", description: "Everywhere" }, { label: "No" }] },
        { question: "Keep the cache?", multiSelect: false, freeText: false, options: [{ label: "Maybe" }, { label: "Later" }] },
        { question: "Keep the cache?", multiSelect: false, freeText: false, options: [{ label: "Maybe" }, { label: "Later" }] },
      ])}
      onAnswer={answer}
    />,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Yes" })[1]);
  expect(pressed("Yes")).toEqual(["false", "true"]);
  fireEvent.click(screen.getAllByRole("button", { name: "Yes" })[0]);
  expect(pressed("Yes")).toEqual(["true", "true"]);
  fireEvent.click(screen.getAllByRole("button", { name: "Yes" })[1]);
  expect(pressed("Yes")).toEqual(["true", "false"]);

  fireEvent.click(screen.getAllByRole("button", { name: "Later" })[0]);
  expect([pressed("Maybe"), pressed("Later")]).toEqual([["false", "false"], ["true", "false"]]);
  fireEvent.click(screen.getAllByRole("button", { name: "Maybe" })[1]);
  expect([pressed("Maybe"), pressed("Later")]).toEqual([["false", "true"], ["true", "false"]]);
});

// #775: in bypass mode a Claude card is Claude Code's own safety check asking. The card says so, and says the agent's description of the command is the agent's.
const safetyReason = "Claude Code's safety check wants approval for this command. Bypass permissions doesn't cover commands it can't verify.";
const bypassAsk: PendingAsk = {
  requestId: "r", toolUseId: "", seq: 1, kind: "permission", toolName: "Bash",
  input: { command: 'a=("${(@f)$(printf "x\\ny")}"); echo ${#a}', description: "Clear the composer and type the prompt" },
  description: "Clear the composer and type the prompt", reason: safetyReason,
  options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "deny" }],
};

it("says Claude's safety check asked in bypass mode, and labels the agent's description as the agent's (#775)", () => {
  const answer = vi.fn();
  render(<PermissionCard ask={bypassAsk} onAnswer={answer} />);
  expect(screen.getByTestId("permission-reason").textContent).toBe(safetyReason);
  expect(screen.getByTestId("permission-agent-note").textContent).toBe("Agent: Clear the composer and type the prompt");
  expect(screen.getByTestId("permission-reason").textContent).not.toContain("Clear the composer");
  // Still the reader's to answer: Allow is offered and goes to the agent.
  fireEvent.click(screen.getByRole("button", { name: /^Allow/ }));
  expect(answer).toHaveBeenCalledWith("allow");
});

it("gives a card in a mode that asks no safety-check explanation (#775)", () => {
  render(<PermissionCard ask={{ ...bypassAsk, reason: undefined }} onAnswer={vi.fn()} />);
  expect(screen.queryByTestId("permission-reason")).toBeNull();
  expect(screen.queryByText(/safety check/)).toBeNull();
  expect(screen.getByTestId("permission-agent-note").textContent).toBe("Agent: Clear the composer and type the prompt");
});

it("still says why a card is up when its details are not shown, and keeps a description the input does not hold unlabelled (#775)", () => {
  const { rerender } = render(<PermissionCard ask={bypassAsk} onAnswer={vi.fn()} showDetail={false} />);
  expect(screen.getByTestId("permission-reason").textContent).toBe(safetyReason);
  expect(screen.queryByTestId("permission-agent-note")).toBeNull();
  rerender(<PermissionCard ask={{ ...bypassAsk, input: { command: "ls" }, description: "Pattern: src/**", reason: undefined }} onAnswer={vi.fn()} />);
  expect(screen.getByText("Pattern: src/**")).toBeTruthy();
  expect(screen.queryByText(/^Agent:/)).toBeNull();
});

it("says on a tool row which of Claude's checks held the call (#775)", () => {
  const call = { callId: "c", name: "Bash", toolType: "shell", input: { command: "ls" }, seq: 1 };
  const { rerender } = render(<ToolCallRow call={{ ...call, result: { text: "2", isError: false, safetyCheck: "Approved past Claude's dangerous-removal check" } }} />);
  expect(screen.getByTestId("tool-safety-check").textContent).toBe("Approved past Claude's dangerous-removal check");
  rerender(<ToolCallRow call={{ ...call, result: { text: "2", isError: false } }} />);
  expect(screen.queryByTestId("tool-safety-check")).toBeNull();
});

const allowDeny = [{ id: "allow", label: "Allow", kind: "allow_once" as const }, { id: "deny", label: "Deny", kind: "deny" as const }];
const editAsk = (toolName: string, input: unknown): PendingAsk => ({ kind: "permission", requestId: "edit", toolUseId: "", seq: 1, toolName, title: `${toolName} *** Begin Patch`, cwd: "/w/demo", input, options: allowDeny });
const patchOf = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
const fileSections = () => screen.getAllByTestId("permission-diff-file");
const rowsOf = (section: HTMLElement, kind?: string) => [...section.querySelectorAll<HTMLElement>(kind ? `[data-kind="${kind}"]` : "[data-kind]")];

it("shows an apply_patch approval as each file's name, its counts and the changed lines (PRO-156)", () => {
  const command = patchOf(
    "*** Update File: /w/demo/src/slug.js",
    "@@ export function slugify(input) {",
    "-  return input.toLowerCase().replace(/ /g, \"-\");",
    "+  return input",
    "+    .toLowerCase()",
    "+    .replace(/[^a-z0-9]+/g, \"-\");",
    " }",
    "*** Add File: test/slug.test.js",
    "+import { slugify } from \"../src/slug.js\";",
    "+test(\"dashes\", () => {});",
    "*** Delete File: src/legacy.js",
    "*** Update File: src/a.js",
    "*** Move to: src/b.js",
    "@@",
    "-old",
    "+new",
  );
  render(<PermissionCard ask={editAsk("apply_patch", { command })} onAnswer={vi.fn()} />);
  expect(screen.getByText("Waiting for permission to edit 4 files")).toBeTruthy();
  // The whole patch's counts by the heading, each file's on its own line.
  expect(screen.getAllByTestId("permission-diff-counts").map((c) => c.textContent)).toEqual(["+6 −2", "+3 −1", "+2", "+1 −1"]);
  expect(screen.getAllByTestId("permission-diff-path").map((p) => p.textContent)).toEqual(["src/slug.js", "test/slug.test.js", "src/legacy.js", "src/a.js → src/b.js"]);
  expect(fileSections().map((s) => s.textContent?.match(/new file|deleted|renamed/)?.[0] ?? null)).toEqual([null, "new file", "deleted", "renamed"]);

  const [update, added, deleted, renamed] = fileSections();
  expect(rowsOf(update).map((r) => [r.dataset.kind, r.textContent])).toEqual([
    ["hunk", "@@ export function slugify(input) {"],
    ["del", "−  return input.toLowerCase().replace(/ /g, \"-\");"],
    ["add", "+  return input"],
    ["add", "+    .toLowerCase()"],
    ["add", "+    .replace(/[^a-z0-9]+/g, \"-\");"],
    ["ctx", " }"],
  ]);
  expect(rowsOf(added, "add").map((r) => r.textContent)).toEqual(["+import { slugify } from \"../src/slug.js\";", "+test(\"dashes\", () => {});"]);
  expect(rowsOf(deleted)).toEqual([]);
  expect(rowsOf(renamed).map((r) => r.textContent)).toEqual(["−old", "+new"]);
  // The diff replaces the patch's useless first line.
  expect(screen.queryByTestId("permission-detail")).toBeNull();
  expect(screen.queryByText(/\*\*\* Begin Patch/)).toBeNull();
});

it("names a single-file patch, with no total beside the heading (PRO-156)", () => {
  render(<PermissionCard ask={editAsk("apply_patch", { command: ["apply_patch", patchOf("*** Update File: README.md", "-hello", "+hello raccoon")] })} onAnswer={vi.fn()} />);
  expect(screen.getByText("Waiting for permission to edit a file")).toBeTruthy();
  expect(screen.getAllByTestId("permission-diff-counts").map((c) => c.textContent)).toEqual(["+1 −1"]);
  expect(rowsOf(fileSections()[0]).map((r) => r.textContent)).toEqual(["−hello", "+hello raccoon"]);
});

it("folds a long file behind \"Show all N lines\" and keeps Allow first for Return (PRO-156)", () => {
  const long = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`);
  const answer = vi.fn();
  render(<PermissionCard ask={editAsk("apply_patch", { command: patchOf("*** Add File: big.txt", ...long, "*** Update File: small.txt", "-a", "+b") })} onAnswer={answer} />);
  const [big, small] = fileSections();
  expect(rowsOf(big)).toHaveLength(12);
  expect(rowsOf(small)).toHaveLength(2);
  const more = screen.getByRole("button", { name: "Show all 40 lines" });
  expect(more.getAttribute("aria-expanded")).toBe("false");

  // The card's first answer has focus, not the control in the diff above it.
  const allow = screen.getByRole("button", { name: /^Allow/ });
  expect(document.activeElement).toBe(allow);
  // The diff scrolls on its own, and can be reached by keyboard on the way back from the buttons.
  const region = screen.getByRole("region", { name: "Proposed changes" });
  expect(region.className).toMatch(/max-h-/);
  expect(region.tabIndex).toBe(0);
  for (const control of [region, more]) expect(control.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(more);
  expect(rowsOf(big)).toHaveLength(40);
  expect(rowsOf(big).at(-1)?.textContent).toBe("+line 40");
  expect(screen.getByRole("button", { name: "Show fewer lines" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Show fewer lines" }));
  expect(rowsOf(big)).toHaveLength(12);
  // Expanding answered nothing; the buttons still do.
  expect(answer).not.toHaveBeenCalled();
  fireEvent.click(allow);
  expect(answer).toHaveBeenCalledWith("allow");
});

it("shows a file a few lines past the preview whole, with no fold (PRO-156)", () => {
  render(<PermissionCard ask={editAsk("apply_patch", { command: patchOf("*** Add File: x.txt", ...Array.from({ length: 15 }, (_, i) => `+${i}`)) })} onAnswer={vi.fn()} />);
  expect(rowsOf(fileSections()[0])).toHaveLength(15);
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
});

it("quotes a patch it cannot read whole instead of drawing part of it (PRO-156)", () => {
  const command = patchOf("*** Update File: a.ts", "-x", "not a patch line", "+y");
  render(<PermissionCard ask={editAsk("apply_patch", { command })} onAnswer={vi.fn()} />);
  expect(screen.queryByTestId("permission-diff")).toBeNull();
  expect(screen.getByTestId("permission-detail").textContent).toBe(command);
  expect(screen.getByText("Waiting for permission to edit files")).toBeTruthy();
});

it("shows Claude Code's Edit, MultiEdit and Write requests the same way (PRO-156)", () => {
  const { rerender } = render(<PermissionCard ask={editAsk("Edit", { file_path: "/w/demo/src/a.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;" })} onAnswer={vi.fn()} />);
  expect(screen.getByText("Waiting for permission to edit a file")).toBeTruthy();
  expect(screen.getByTestId("permission-diff-path").textContent).toBe("src/a.ts");
  expect(screen.getByTestId("permission-diff-counts").textContent).toBe("+1 −1");
  expect(rowsOf(fileSections()[0]).map((r) => r.textContent)).toEqual([" const a = 1;", "−const b = 2;", "+const b = 3;"]);
  // The path is in the diff's header; it is not quoted twice.
  expect(screen.queryByTestId("permission-detail")).toBeNull();

  rerender(<PermissionCard ask={{ ...editAsk("MultiEdit", { file_path: "/w/demo/src/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d", replace_all: true }] }), requestId: "multi" }} onAnswer={vi.fn()} />);
  expect(screen.getByTestId("permission-diff-counts").textContent).toBe("+2 −2");
  expect(rowsOf(fileSections()[0]).map((r) => r.textContent)).toEqual(["Edit 1 of 2", "−a", "+b", "Edit 2 of 2 · every match", "−c", "+d"]);

  rerender(<PermissionCard ask={{ ...editAsk("Write", { file_path: "/w/demo/notes.md", content: "# Notes\n\nDone.\n" }), requestId: "write" }} onAnswer={vi.fn()} />);
  expect(screen.getByText("Waiting for permission to write a file")).toBeTruthy();
  expect(fileSections()[0].textContent).toContain("whole file");
  expect(screen.getByTestId("permission-diff-counts").textContent).toBe("+3");
  expect(rowsOf(fileSections()[0], "add").map((r) => r.textContent)).toEqual(["+# Notes", "+ ", "+Done."]);
});

it("says an Edit applies at every match (PRO-156)", () => {
  render(<PermissionCard ask={editAsk("Edit", { file_path: "/w/demo/a.ts", old_string: "foo", new_string: "bar", replace_all: true })} onAnswer={vi.fn()} />);
  expect(screen.getByText("Replaces every match in the file")).toBeTruthy();
});

it("shows no diff to a reader the card's details are hidden from (PRO-156)", () => {
  render(<PermissionCard ask={editAsk("apply_patch", { command: patchOf("*** Update File: secret.env", "-A=1", "+A=2") })} onAnswer={vi.fn()} showDetail={false} />);
  expect(screen.queryByTestId("permission-diff")).toBeNull();
  expect(screen.queryByTestId("permission-detail")).toBeNull();
  expect(screen.queryByText(/A=2/)).toBeNull();
  expect(screen.getByText("Waiting for permission to edit files")).toBeTruthy();
});
