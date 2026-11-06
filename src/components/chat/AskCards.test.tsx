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

it("offers the exact command's session allowance and sends its option id", () => {
  const answer = vi.fn();
  render(<PermissionCard ask={{ ...bypassAsk, reason: undefined, options: [
    { id: "allow", label: "Allow", kind: "allow_once" },
    { id: "terminalx:allow_session", label: "Allow for this session", kind: "allow_session" },
    { id: "deny", label: "Deny", kind: "deny" },
  ] }} onAnswer={answer} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
  expect(answer).toHaveBeenCalledWith("terminalx:allow_session");
});

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
