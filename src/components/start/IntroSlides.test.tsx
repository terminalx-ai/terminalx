import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntroSlides } from "./IntroSlides";
import { advanceIntro, finishIntro, replayIntro, useIntro } from "@/lib/intro";

vi.mock("@tauri-apps/api/app", () => ({ getName: async () => "TerminalX" }));
const KEY = "terminalx.intro.v1";
const restore = (value: string | null) => {
  if (value === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, value);
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
};
function Welcome() { return useIntro().visible ? <IntroSlides /> : <p>Welcome actions</p>; }
beforeEach(() => { finishIntro(); restore(null); });
afterEach(cleanup);

it("advances once per Down or Enter, saves the step, and finishes permanently", async () => {
  render(<Welcome />);
  const intro = screen.getByLabelText("Introduction");
  expect(document.activeElement).toBe(intro);
  fireEvent.keyDown(intro, { key: "ArrowDown" });
  expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(KEY)!).step).toBe(1);
  fireEvent.keyDown(intro, { key: "ArrowDown", repeat: true });
  expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  fireEvent.keyDown(intro, { key: "Enter" });
  expect(screen.getByText("Step 3 of 3")).toBeTruthy();
  fireEvent.keyDown(intro, { key: "Enter" });
  expect(screen.getByText("Welcome actions")).toBeTruthy();
  cleanup();
  render(<Welcome />);
  expect(screen.queryByLabelText("Introduction")).toBeNull();
});

it("resumes the persisted step after the welcome view is reopened", () => {
  restore(JSON.stringify({ step: 1, completed: false }));
  const view = render(<Welcome />);
  expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  view.unmount();
  render(<Welcome />);
  expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(JSON.parse(localStorage.getItem(KEY)!).step).toBe(0);
});

it("Skip completes onboarding; Help replay does not undo completion on quit", () => {
  render(<Welcome />);
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(JSON.parse(localStorage.getItem(KEY)!).completed).toBe(true);
  act(replayIntro);
  expect(screen.getByText("Step 1 of 3")).toBeTruthy();
  act(advanceIntro);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ step: 1, completed: true });
  act(() => restore(localStorage.getItem(KEY)));
  expect(screen.queryByLabelText("Introduction")).toBeNull();
});

it("does not hijack Enter on Skip or modified and repeated navigation", () => {
  render(<Welcome />);
  const skip = screen.getByRole("button", { name: "Skip" });
  fireEvent.keyDown(skip, { key: "Enter" });
  expect(screen.getByText("Step 1 of 3")).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText("Introduction"), { key: "ArrowDown", ctrlKey: true });
  expect(screen.getByText("Step 1 of 3")).toBeTruthy();
});

it.each(['{"step":99,"completed":false}', '{"step":-1,"completed":false}', 'broken'])("recovers malformed progress %s", (value) => {
  restore(value);
  render(<Welcome />);
  expect(screen.getByText("Step 1 of 3")).toBeTruthy();
});
