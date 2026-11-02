import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setPrefs } from "@/lib/prefs";
import { keycaps } from "@/lib/shortcuts";
import { WelcomeScreen } from "./WelcomeScreen";
import { EmptyView } from "./EmptyView";

const mocks = vi.hoisted(() => ({
  openNewSession: vi.fn(), openLocalProject: vi.fn(), name: "TerminalX Dev", sessions: [] as { id: string }[],
}));
vi.mock("@tauri-apps/api/app", () => ({ getName: async () => mocks.name }));
vi.mock("@/lib/sessions", () => ({ openNewSession: mocks.openNewSession, useSessionStore: () => ({ sessions: mocks.sessions }) }));
vi.mock("@/lib/projectStart", () => ({ openLocalProject: mocks.openLocalProject }));

beforeEach(() => { mocks.sessions = []; mocks.openLocalProject.mockResolvedValue(null); setPrefs({ shortcuts: {} }); });
afterEach(cleanup);

it.each(["TerminalX", "TerminalX Dev", "TerminalX Legacy"])("uses the build name %s", async (name) => {
  mocks.name = name;
  render(<EmptyView branded guidance="Welcome" />);
  expect(await screen.findByRole("heading", { level: 1, name })).toBeTruthy();
});

it("opens the existing project and new-session flows in keyboard order", async () => {
  render(<WelcomeScreen />);
  expect(screen.getByText("Add a project to begin.")).toBeTruthy();
  const buttons = screen.getAllByRole("button");
  expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Add Project", "New session"]);
  await act(async () => fireEvent.click(buttons[0]));
  expect(mocks.openLocalProject).toHaveBeenCalled();
  fireEvent.click(buttons[1]);
  expect(mocks.openNewSession).toHaveBeenCalled();
});

it("reacts to remapped and unbound shortcuts, including floating chat", async () => {
  mocks.sessions = [{ id: "session" }];
  render(<WelcomeScreen />);
  expect(screen.getByText("Select a session from the sidebar to begin.")).toBeTruthy();
  const list = screen.getByLabelText("Keyboard shortcuts");
  expect(within(list).queryByText("Open the floating chat window")).toBeNull();
  act(() => setPrefs({ shortcuts: { "app.newSession": ["mod+shift+y"], "app.commandPalette": [], "app.quickChat": ["mod+shift+q"] } }));
  expect(within(list).queryByText("Command palette")).toBeNull();
  expect(within(list).getByText("Open the floating chat window")).toBeTruthy();
  const keys = within(list).getByText("New session").nextElementSibling!;
  expect([...keys.querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(keycaps("mod+shift+y"));
});

it("reports a failed project picker", async () => {
  mocks.openLocalProject.mockRejectedValue(new Error("Cannot open folder"));
  render(<WelcomeScreen />);
  fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Cannot open folder");
});
