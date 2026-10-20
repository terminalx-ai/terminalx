import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionCard } from "./AskCards";
import { setPrefs } from "@/lib/prefs";
import { openUrl } from "@tauri-apps/plugin-opener";

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
