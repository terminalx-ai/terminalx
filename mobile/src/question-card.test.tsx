// @vitest-environment jsdom
import { act, useImperativeHandle, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Question } from "@terminalx/portable/events";
import { questionAnswers, type PendingAsk } from "@terminalx/portable/transcript";
import { forgetConversationState } from "./state/conversation-state";
import { QuestionCard, refusalSentence } from "./ui/transcript";

// #979: an agent's question on the phone, as the desktop's QuestionCard draws and answers it.

const mocks = vi.hoisted(() => ({ reveal: vi.fn(), keyboardVisible: true, keyboardShown: new Set<() => void>() }));

vi.mock("./ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./ui/TranscriptList", () => ({ useTranscriptReveal: () => mocks.reveal }));
vi.mock("react-native", () => {
  const Box = ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>;
  const Inline = ({ children, testID, accessibilityRole }: { children?: ReactNode; testID?: string; accessibilityRole?: string }) => <span data-testid={testID} role={accessibilityRole === "link" ? "link" : undefined}>{children}</span>;
  return {
    View: Box, Text: Inline,
    Platform: { OS: "ios", select: ({ default: fallback }: any) => fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, testID, accessibilityRole, accessibilityState, accessibilityLabel }: any) =>
      <button data-testid={testID} role={accessibilityRole} aria-checked={accessibilityState?.checked} aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{children}</button>,
    TextInput: ({ ref, value, onChangeText, onFocus, placeholder, accessibilityLabel, editable }: any) => {
      useImperativeHandle(ref, () => ({ measureInWindow: () => undefined, field: accessibilityLabel }));
      return <input aria-label={accessibilityLabel} placeholder={placeholder} value={value} disabled={editable === false} onFocus={onFocus} onInput={(event) => onChangeText(event.currentTarget.value)} />;
    },
    Keyboard: {
      isVisible: () => mocks.keyboardVisible,
      addListener: (_name: string, listener: () => void) => { mocks.keyboardShown.add(listener); return { remove: () => { mocks.keyboardShown.delete(listener); } }; },
    },
    ActionSheetIOS: {}, Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() },
  };
});
vi.mock("./ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children, testID }: any) => <div data-testid={testID}>{children}</div>,
}));

const checks: Question = { question: "Which checks should run?", header: "Checks", multiSelect: true, freeText: false, options: [{ label: "Lint, format", description: "Both, see https://example.com/lint" }, { label: "Tests", description: "Unit tests only" }, { label: "Build" }] };
const branch: Question = { question: "Which branch?", multiSelect: false, freeText: true, options: [{ label: "main", description: "The default" }, { label: "next" }] };
const notes: Question = { question: "Anything else?", multiSelect: false, freeText: true, options: [] };
const asked = (questions: Question[], requestId = "q1"): PendingAsk => ({ requestId, toolUseId: "", seq: 2, kind: "questions", questions });

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  forgetConversationState("");
  mocks.reveal.mockClear();
  mocks.keyboardVisible = true;
  mocks.keyboardShown.clear();
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => { run(); return 0; });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const draw = (node: ReactNode) => act(() => root.render(node));
const option = (question: number, index: number) => container.querySelector<HTMLButtonElement>(`[data-testid="question-${question}-option-${index}"]`)!;
const pick = (question: number, index: number) => act(() => option(question, index).click());
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
const press = (label: string) => act(() => button(label).click());
const field = (question: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Your own answer to: ${question}"]`)!;
const type = (question: string, value: string) => act(() => {
  const input = field(question);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const checked = (question: number) => [...container.querySelectorAll<HTMLButtonElement>(`[data-testid^="question-${question}-option-"]`)].map((item) => item.getAttribute("aria-checked") === "true");
const card = (ask: PendingAsk, props: Partial<Parameters<typeof QuestionCard>[0]> = {}) => <QuestionCard ask={ask} stateKey="mac:session:tab" connected answering={false} onAnswer={vi.fn()} {...props} />;

describe("what the card shows", () => {
  it("shows every question with its options and descriptions, radio rows for one choice and checkbox rows for several", () => {
    draw(card(asked([checks, branch, notes])));
    const text = container.textContent!;
    expect(text).toContain("3 questions");
    for (const shown of ["Which checks should run?", "Lint, format", "Both, see https://example.com/lint", "Tests", "Unit tests only", "Build", "Which branch?", "main", "The default", "next", "Anything else?"]) expect(text).toContain(shown);
    // A question is not a permission request, and is never labelled as one.
    expect(text.toLowerCase()).not.toContain("permission");
    expect([0, 1, 2].map((index) => option(0, index).getAttribute("role"))).toEqual(["checkbox", "checkbox", "checkbox"]);
    expect([0, 1].map((index) => option(1, index).getAttribute("role"))).toEqual(["radio", "radio"]);
    // Only the question that takes several says so.
    expect(text.split("Choose any that apply")).toHaveLength(2);
    // A typed answer where the agent takes one, and nowhere else.
    expect(field("Which checks should run?")).toBeNull();
    expect(field("Which branch?").placeholder).toBe("Or type your own answer");
    // The link in a description is a link of its own, inside the row.
    expect(option(0, 0).querySelector('[role="link"]')?.textContent).toBe("https://example.com/lint");
    expect(option(0, 0).getAttribute("aria-label")).toBe("Lint, format. Both, see https://example.com/lint");
  });

  it("says Question for one, and shows only the text field for a question with no options", () => {
    draw(card(asked([{ ...notes, freeText: false }])));
    expect(container.textContent).toContain("Question");
    expect(container.textContent).not.toContain("questions");
    expect(container.querySelector('[data-testid^="question-0-option-"]')).toBeNull();
    expect(field("Anything else?").placeholder).toBe("Type your answer");
    expect(container.textContent).not.toContain("Choose any that apply");
  });
});

describe("what the card sends", () => {
  it("sends, for single-select, multi-select and typed answers, exactly what the desktop's card sends", () => {
    const answer = vi.fn();
    const questions = [checks, branch, notes];
    draw(card(asked(questions), { onAnswer: answer }));
    // Several, in the order picked; one taken back.
    pick(0, 1); pick(0, 0); pick(0, 2); pick(0, 2);
    expect(checked(0)).toEqual([true, true, false]);
    // One: choosing another clears the first.
    pick(1, 0); pick(1, 1);
    expect(checked(1)).toEqual([false, true]);
    type("Anything else?", "  Ship it on Friday ");
    press("Answer");
    const sent = { "Which checks should run?": "Tests, Lint, format", "Which branch?": "next", "Anything else?": "Ship it on Friday" };
    expect(answer).toHaveBeenLastCalledWith(sent);
    // The desktop's card builds its answer with this same function from the same choices.
    expect(sent).toEqual(questionAnswers(questions, { 0: [1, 0], 1: [1] }, { 2: "  Ship it on Friday " }));

    // A typed answer wins over the chosen option.
    type("Which branch?", "release/1.0");
    press("Answer");
    expect(answer).toHaveBeenLastCalledWith({ ...sent, "Which branch?": "release/1.0" });
  });

  it("selects and deselects a label that holds a comma and a space (#703)", () => {
    const answer = vi.fn();
    draw(card(asked([checks]), { onAnswer: answer }));
    pick(0, 0); pick(0, 1);
    press("Answer");
    expect(answer).toHaveBeenLastCalledWith({ "Which checks should run?": "Lint, format, Tests" });
    pick(0, 0);
    expect(checked(0)).toEqual([false, true, false]);
    press("Answer");
    expect(answer).toHaveBeenLastCalledWith({ "Which checks should run?": "Tests" });
  });

  it("sends an empty answer set on Skip, whatever was chosen", () => {
    const answer = vi.fn();
    draw(card(asked([checks, branch]), { onAnswer: answer }));
    pick(0, 0); pick(1, 0);
    press("Skip");
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith({});
  });
});

describe("who may answer, and when", () => {
  it("keeps the options selectable while disconnected, with Answer and Skip off and the reason", () => {
    const answer = vi.fn();
    draw(card(asked([checks]), { connected: false, onAnswer: answer }));
    expect([button("Answer").disabled, button("Skip").disabled]).toEqual([true, true]);
    expect(container.textContent).toContain("Reconnect before answering.");
    pick(0, 1);
    expect(checked(0)).toEqual([false, true, false]);
    // Connected again, what was chosen is what goes.
    draw(card(asked([checks]), { onAnswer: answer }));
    expect(container.textContent).not.toContain("Reconnect before answering.");
    press("Answer");
    expect(answer).toHaveBeenCalledWith({ "Which checks should run?": "Tests" });
  });

  it("turns Answer and Skip off while an answer is on its way", () => {
    draw(card(asked([branch]), { answering: true }));
    expect([button("Answer").disabled, button("Skip").disabled]).toEqual([true, true]);
    expect(field("Which branch?").disabled).toBe(true);
    expect(container.textContent).not.toContain("Reconnect before answering.");
  });

  it("shows a reader who may not answer the question and its options, with why and nothing to press", () => {
    for (const why of ["This paired device is read-only.", "Answer this question from your computer."]) {
      draw(card(asked([checks, branch, notes]), { readOnly: why }));
      expect(container.querySelector('[data-testid="question-read-only"]')?.textContent).toBe(why);
      for (const shown of ["Which checks should run?", "Lint, format", "Unit tests only", "Which branch?", "next", "Anything else?"]) expect(container.textContent).toContain(shown);
      // No button that would fail, no field, and no row that takes a tap.
      expect(button("Answer")).toBeUndefined();
      expect(button("Skip")).toBeUndefined();
      expect(container.querySelector("input")).toBeNull();
      expect(option(0, 0).disabled).toBe(true);
      expect(container.textContent).not.toContain("Reconnect before answering.");
    }
  });

  it("says the computer's own message when the answer came too late", () => {
    draw(card(asked([branch]), { error: "internal: that question is no longer open" }));
    expect(container.querySelector('[data-testid="question-error"]')?.textContent).toBe("That question is no longer open.");
    expect(refusalSentence("This paired device is read-only.")).toBe("This paired device is read-only.");
    expect(refusalSentence("unavailable: TerminalX on your computer needs updating or restarting to do this.")).toBe("TerminalX on your computer needs updating or restarting to do this.");
    expect(refusalSentence("  ")).toBe("The answer was not sent.");
  });
});

describe("what the card keeps", () => {
  it("keeps what was chosen and typed per ask while the reader is in another tab", () => {
    const answer = vi.fn();
    draw(card(asked([checks, branch]), { onAnswer: answer }));
    pick(0, 2); pick(0, 0); type("Which branch?", "hotfix");
    // Another tab, then back: the pane was unmounted in between.
    act(() => root.unmount());
    root = createRoot(container);
    draw(card(asked([checks, branch]), { onAnswer: answer }));
    expect(checked(0)).toEqual([true, false, true]);
    expect(field("Which branch?").value).toBe("hotfix");
    press("Answer");
    expect(answer).toHaveBeenCalledWith({ "Which checks should run?": "Build, Lint, format", "Which branch?": "hotfix" });

    // Another question, or the same one in another conversation, starts clean.
    draw(card(asked([checks, branch], "q2"), { onAnswer: answer }));
    expect(checked(0)).toEqual([false, false, false]);
    draw(card(asked([checks, branch]), { stateKey: "mac:session:other-tab", onAnswer: answer }));
    expect(checked(0)).toEqual([false, false, false]);
  });

  it("brings the text field into view once the keyboard is up", () => {
    draw(card(asked([branch, notes])));
    // The keyboard is already showing: at once.
    act(() => { field("Anything else?").focus(); });
    expect(mocks.reveal).toHaveBeenCalledTimes(1);
    expect(mocks.reveal.mock.calls[0][0].field).toBe("Your own answer to: Anything else?");

    // Not yet showing: when it has taken its room, and once.
    mocks.keyboardVisible = false;
    act(() => { field("Which branch?").focus(); });
    expect(mocks.reveal).toHaveBeenCalledTimes(1);
    act(() => { for (const shown of [...mocks.keyboardShown]) shown(); });
    expect(mocks.reveal).toHaveBeenCalledTimes(2);
    expect(mocks.reveal.mock.calls[1][0].field).toBe("Your own answer to: Which branch?");
    expect(mocks.keyboardShown.size).toBe(0);
  });
});
