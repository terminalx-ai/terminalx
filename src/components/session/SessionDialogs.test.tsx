import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openDialog: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openDialog, ask: vi.fn(), message: vi.fn() }));

const scratch = "/home/.raccoon/quick/chat-1";
const chat: SessionEntry = {
  id: "chat-1",
  kind: "quick",
  projectPath: scratch,
  cwd: scratch,
  worktreeRemoved: false,
  title: "What is a monad?",
  created: "x",
  modified: "x",
  archived: false,
  pinned: false,
  tabs: [{ id: "t1", harness: "claude", model: "", permissionMode: "bypassPermissions", providerSessionId: "conversation-1", status: "idle", created: "x", modified: "x" }],
  activeTab: "t1",
};
const api: Project = { path: "/repos/api", name: "API", kind: "git" };
const notes: Project = { path: "/Users/me/notes", name: "Notes", kind: "folder" };

let projects: Project[];
let stored: SessionEntry;
let scratchFiles: number;
let refusal: string | null;

async function mount() {
  vi.resetModules();
  const sessions = await import("@/lib/sessions");
  const dialogs = await import("@/lib/dialogs");
  const { SessionDialogs } = await import("./SessionDialogs");
  await sessions.bootSessions();
  const utils = render(<SessionDialogs />);
  return { ...utils, sessions, dialogs };
}

const called = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

beforeEach(() => {
  projects = [api, notes];
  stored = structuredClone(chat);
  scratchFiles = 0;
  refusal = null;
  mocks.openDialog.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "list_projects":
        return { projects, lastSelected: null };
      case "list_sessions":
        return [stored];
      case "list_harnesses":
        return [];
      case "list_workspaces":
        return [];
      case "quick_chat_scratch":
        return { path: scratch, files: scratchFiles, more: false, inUse: true };
      case "rename_session":
        stored = { ...stored, title: args.title as string };
        return null;
      case "move_quick_chat_to_project": {
        if (refusal) throw refusal;
        const path = args.projectPath as string;
        if (!projects.some((project) => project.path === path)) projects = [...projects, { path, name: path.split("/").pop()!, kind: "folder" }];
        // The same session, tabs and conversation; only where it belongs and runs changes.
        stored = { ...stored, kind: "project", projectPath: path, cwd: path, branch: path === api.path ? "main" : null };
        return stored;
      }
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
});

describe("move a quick chat to a project", () => {
  it("turns it into a session of the chosen project, with its tabs and conversation", async () => {
    const { sessions, dialogs } = await mount();
    dialogs.openMoveToProject("chat-1");
    expect(await screen.findByText("Move to project")).toBeTruthy();
    // The first project is chosen until the reader picks another.
    fireEvent.click(screen.getByRole("radio", { name: /API/ }));
    expect(screen.getByRole("radio", { name: /API/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(called("move_quick_chat_to_project")).toEqual([{ sessionId: "chat-1", projectPath: "/repos/api" }]));
    await waitFor(() => expect(screen.queryByText("Move to project")).toBeNull());
    const moved = sessions.getSessionStore().sessions[0];
    expect(moved).toMatchObject({ id: "chat-1", kind: "project", projectPath: "/repos/api", cwd: "/repos/api", title: "What is a monad?" });
    expect(moved.tabs).toEqual(chat.tabs);
    // It is no longer a quick chat anywhere in this window.
    const { quickChatsOf } = await import("@/lib/quickChats");
    expect(quickChatsOf(sessions.getSessionStore().sessions)).toEqual([]);
  });

  it("adds a folder that is not a project yet, and lists it afterwards", async () => {
    mocks.openDialog.mockResolvedValue("/Users/me/scratchpad");
    const { sessions, dialogs } = await mount();
    dialogs.openMoveToProject("chat-1");
    fireEvent.click(await screen.findByRole("button", { name: "Add a project…" }));
    const picked = await screen.findByRole("radio", { name: /scratchpad/ });
    expect(picked.getAttribute("aria-checked")).toBe("true");
    expect(picked.textContent).toContain("added as a project");
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(called("move_quick_chat_to_project")).toEqual([{ sessionId: "chat-1", projectPath: "/Users/me/scratchpad" }]));
    await waitFor(() => expect(sessions.getSessionStore().projects.map((project) => project.path)).toContain("/Users/me/scratchpad"));
  });

  it("says what happens to a running agent and to files in the scratch folder before anything moves", async () => {
    stored = { ...stored, tabs: [{ ...chat.tabs[0], status: "in_progress" }] };
    scratchFiles = 2;
    const { dialogs } = await mount();
    dialogs.openMoveToProject("chat-1");
    expect((await screen.findByRole("status")).textContent).toContain("Moving stops it");
    expect((await screen.findByTestId("move-scratch-note")).textContent).toContain("holds 2 files");
    expect(screen.getByTestId("move-scratch-note").textContent).toContain("not copied into the project");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Move to project")).toBeNull());
    expect(called("move_quick_chat_to_project")).toEqual([]);
  });

  it("keeps the chat as it was and says why when the move is refused", async () => {
    const { sessions, dialogs } = await mount();
    refusal = "This folder is a local mirror of a cloud workspace.";
    dialogs.openMoveToProject("chat-1");
    fireEvent.click(await screen.findByRole("button", { name: "Move" }));
    expect((await screen.findByRole("alert")).textContent).toContain("local mirror");
    expect(sessions.getSessionStore().sessions[0].kind).toBe("quick");
  });
});

describe("rename a session", () => {
  it("renames through the backend and closes", async () => {
    const { sessions, dialogs } = await mount();
    dialogs.openRenameSession("chat-1");
    const input = (await screen.findByLabelText("Session title")) as HTMLInputElement;
    expect(input.value).toBe("What is a monad?");
    const rename = screen.getByRole("button", { name: "Rename" });
    fireEvent.change(input, { target: { value: "   " } });
    expect(rename.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "  Monads, explained  " } });
    fireEvent.click(rename);
    await waitFor(() => expect(called("rename_session")).toEqual([{ sessionId: "chat-1", title: "Monads, explained" }]));
    await waitFor(() => expect(screen.queryByLabelText("Session title")).toBeNull());
    expect(sessions.getSessionStore().sessions[0].title).toBe("Monads, explained");
  });
});
