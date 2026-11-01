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
