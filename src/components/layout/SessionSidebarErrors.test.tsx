import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project, SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), ask: vi.fn(), reveal: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask, open: vi.fn(), message: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: mocks.reveal }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));

const { confirmRemoveProject, ConversationMenuItems, UnarchiveButton } = await import("./SessionSidebar");
const { Toasts } = await import("@/components/ui/Toasts");
const { dismissError, getErrorToasts } = await import("@/lib/errorToasts");
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import("@/components/ui/menu");

const project: Project = { path: "/repos/web", name: "web", kind: "git" };
const session: SessionEntry = {
  id: "s1", projectPath: "/repos/web", cwd: "/repos/web", title: "Notarize release builds", created: "", modified: "", pinned: false, archived: false,
  worktreeRemoved: false, activeTab: "t1", tabs: [{ id: "t1", harness: "claude", model: "", permissionMode: "auto", status: "idle", created: "", modified: "" }],
};
const fail = (command: string, error: string) => mocks.invoke.mockImplementation(async (name: string) => {
  if (name === command) throw error;
  return undefined;
});

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.ask.mockReset();
  mocks.reveal.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  for (const toast of getErrorToasts()) dismissError(toast.id);
  vi.restoreAllMocks();
});

it("says a project could not be removed, with what the backend reported", async () => {
  mocks.ask.mockResolvedValue(true);
  fail("remove_project", "database is locked (SQLITE_BUSY)");
  render(<Toasts />);
  await act(() => confirmRemoveProject({ path: project.path, name: "web", project, sessions: [], archived: [], branches: {} }));
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Something went wrong");
  expect(alert.textContent).toContain("Couldn't remove “web” from TerminalX: database is locked (SQLITE_BUSY)");
  expect(console.error).not.toHaveBeenCalled();
});

it("raises nothing when the removal is declined or succeeds", async () => {
  mocks.ask.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  mocks.invoke.mockResolvedValue(undefined);
  const group = { path: project.path, name: "web", project, sessions: [], archived: [], branches: {} };
  await act(() => confirmRemoveProject(group));
  await act(() => confirmRemoveProject(group));
  expect(getErrorToasts()).toEqual([]);
});

it("says an unarchive failed", async () => {
  fail("set_session_archived", "session not found");
  render(<TooltipProvider><Toasts /><UnarchiveButton session={{ ...session, archived: true }} title="Notarize release builds" /></TooltipProvider>);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unarchive Notarize release builds" })));
  expect(screen.getByRole("alert").textContent).toContain("Couldn't unarchive “Notarize release builds”: session not found");
});

it("says when a row's menu action fails: archive, pin, reveal", async () => {
  mocks.invoke.mockImplementation(async (name: string) => {
    if (name === "set_session_archived" || name === "set_session_pinned") throw new Error(`${name} failed`);
    return undefined;
  });
  mocks.reveal.mockRejectedValue(new Error("no such folder"));
  const menu = () => render(<TooltipProvider><Toasts /><DropdownMenu open><DropdownMenuTrigger>Menu</DropdownMenuTrigger><DropdownMenuContent>
    <ConversationMenuItems session={session} branch="main" rename={null} />
  </DropdownMenuContent></DropdownMenu></TooltipProvider>);
  for (const name of [/^Archive/, /^Pin/, /^Reveal in Finder/]) {
    const view = menu();
    await act(async () => fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name })));
    view.unmount();
  }
  render(<Toasts />);
  const texts = screen.getAllByRole("alert").map((alert) => alert.textContent);
  expect(texts).toHaveLength(3);
  expect(texts[0]).toContain("Couldn't archive “Notarize release builds”: set_session_archived failed");
  expect(texts[1]).toContain("Couldn't pin “Notarize release builds”: set_session_pinned failed");
  expect(texts[2]).toContain("Couldn't reveal “Notarize release builds” in Finder: no such folder");
});
