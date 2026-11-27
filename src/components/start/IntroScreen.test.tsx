import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { resetIntroForTests, useIntroOpen } from "@/lib/intro";
import { IntroScreen } from "./IntroScreen";

const mocks = vi.hoisted(() => ({
  account: { ready: true, busy: false, status: { state: "signed-out", identity: null, lastError: null } as Record<string, unknown> },
  signIn: vi.fn(),
  openUrl: vi.fn(async () => {}),
}));
vi.mock("@/lib/account", () => ({ useAccount: () => mocks.account, signIn: mocks.signIn }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const signedIn = { state: "signed-in", identity: { name: "Ada Example", email: "ada@example.com" }, lastError: null };

beforeEach(() => {
  resetIntroForTests();
  mocks.account = { ready: true, busy: false, status: { state: "signed-out", identity: null, lastError: null } };
  mocks.signIn.mockReset();
  setPrefs({ introSlides: true, introStep: 0, introDone: false });
});
afterEach(cleanup);

const key = (name: string, target: Element = document.body) => act(() => { fireEvent.keyDown(target, { key: name }); });
const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

it("goes through the three slides and the last step with ↓, ↵ and ↑, saving each step", () => {
  render(<IntroScreen />);
  expect(heading()).toBe("Run agents side by side");
  expect(screen.getByText("· 1 of 3")).toBeTruthy();
  key("ArrowDown");
  expect(heading()).toBe("See what needs you");
  expect(getPrefs().introStep).toBe(1);
  key("Enter");
  expect(heading()).toBe("Review and ship");
  expect(screen.getByRole("button", { name: /Last step/ })).toBeTruthy();
  key("ArrowDown");
  expect(heading()).toBe("Ready when you are");
  expect(screen.getByText("· ready")).toBeTruthy();
  key("ArrowDown");
  expect(getPrefs().introStep).toBe(3);
  key("ArrowUp");
  expect(heading()).toBe("Review and ship");
});

it("resumes at the saved step after a relaunch", () => {
  setPrefs({ introStep: 2 });
  render(<IntroScreen />);
  expect(heading()).toBe("Review and ship");
  const current = screen.getByRole("list", { name: "Slides" }).querySelector("[aria-current='step']");
  expect(current?.textContent).toContain("Review and ship");
  expect(screen.getAllByLabelText("Done")).toHaveLength(2);
});

it("keeps arrow keys working after a click on Next, and leaves ↵ on a focused button to the button", () => {
  render(<IntroScreen />);
  const next = screen.getByRole("button", { name: /Next/ });
  fireEvent.click(next);
  expect(heading()).toBe("See what needs you");
  key("ArrowDown", next);
  expect(heading()).toBe("Review and ship");
  key("Enter", next);
  expect(heading()).toBe("Review and ship");
});

it("ignores keys while a dialog is over it", () => {
  render(<><IntroScreen /><div role="dialog"><input aria-label="Link" /></div></>);
  key("ArrowDown");
  key("Enter", screen.getByLabelText("Link"));
  expect(heading()).toBe("Run agents side by side");
});

it("ends for good on ↵ at the last step, and on Continue without an account", () => {
  setPrefs({ introStep: 3 });
  const { unmount } = render(<IntroScreen />);
  key("Enter");
  expect(getPrefs().introDone).toBe(true);
  unmount();
  setPrefs({ introDone: false, introStep: 1 });
  render(<IntroScreen />);
  fireEvent.click(screen.getByRole("button", { name: /Continue without an account/ }));
  expect(getPrefs()).toMatchObject({ introDone: true, introStep: 0 });
});

it("has no Skip, signs in from the panel, and ends when the sign-in finishes", () => {
  const { rerender } = render(<IntroScreen />);
  expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(mocks.signIn).toHaveBeenCalledTimes(1);
  mocks.account = { ...mocks.account, status: { state: "signing-in", identity: null, lastError: null } };
  rerender(<IntroScreen />);
  expect(screen.getByRole("button", { name: /Waiting for your browser/ })).toHaveProperty("disabled", true);
  expect(getPrefs().introDone).toBe(false);
  mocks.account = { ...mocks.account, status: signedIn };
  rerender(<IntroScreen />);
  expect(getPrefs().introDone).toBe(true);
});

it("stays up when opened again from Help while signed in, until Continue", () => {
  mocks.account = { ...mocks.account, status: signedIn };
  const open: boolean[] = [];
  function Probe() { open.push(useIntroOpen()); return null; }
  render(<><IntroScreen /><Probe /></>);
  expect(screen.getByText("Signed in as Ada Example.")).toBeTruthy();
  expect(getPrefs().introDone).toBe(false);
  expect(open.at(-1)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(getPrefs().introDone).toBe(true);
  expect(open.at(-1)).toBe(false);
});

it("shows a failed sign-in", () => {
  mocks.account = { ...mocks.account, status: { state: "signed-out", identity: null, lastError: "The browser did not answer." } };
  render(<IntroScreen />);
  expect(screen.getByRole("alert").textContent).toBe("The browser did not answer.");
});
