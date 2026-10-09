import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), ask: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask, message: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set() }));

function chat(id: string, title: string, patch: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    kind: "quick",
    projectPath: `/home/.raccoon/quick/${id}`,
    cwd: `/home/.raccoon/quick/${id}`,
    worktreeRemoved: false,
    title,
    created: "2026-10-01T00:00:00.000Z",
    modified: "2026-10-01T00:00:00.000Z",
    archived: false,
    pinned: false,
    tabs: [{ id: `${id}-tab`, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "2026-10-01T00:00:00.000Z", modified: "x" }],
    activeTab: `${id}-tab`,
    ...patch,
  };
}
const ordinary: SessionEntry = { ...chat("project-1", "Fix login"), kind: undefined, projectPath: "/repos/api", cwd: "/repos/api" };

let stored: SessionEntry[];

async function mount() {
  vi.resetModules();
  const sessions = await import("@/lib/sessions");
  const { QuickChatsSection } = await import("./QuickChatsSection");
  await sessions.bootSessions();
  const utils = render(
    <TooltipProvider>
      <div role="tree">
        <QuickChatsSection />
      </div>
    </TooltipProvider>,
  );
  return { ...utils, sessions };
}

const called = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
const rows = () => within(screen.getByTestId("quick-chats-section")).getAllByRole("treeitem").map((row) => row.getAttribute("aria-label"));

beforeEach(() => {
  localStorage.clear();
  mocks.listeners.clear();
  mocks.ask.mockReset();
  stored = [chat("chat-1", "What is a monad?"), chat("chat-2", "Regex help", { modified: "2026-10-04T00:00:00.000Z" }), ordinary];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "list_projects":
        return { projects: [{ path: "/repos/api", name: "API" }], lastSelected: null };
      case "list_sessions":
        return stored;
      case "list_harnesses":
        return [{ id: "claude", name: "Claude", available: true }];
      case "list_workspaces":
        return [];
      case "browser_pages":
        return [];
      case "quick_chat_scratch":
        return { path: `/home/.raccoon/quick/${args.sessionId}`, files: 0, more: false, inUse: true };
      case "delete_session":
        stored = stored.filter((session) => session.id !== args.sessionId);
        return null;
      case "floating_show":
      case "set_active_tab":
      case "frontend_log":
        return null;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
});

describe("Quick chats in the sidebar", () => {
  it("lists the sessions that have no project, newest first, and never a project's session", async () => {
    await mount();
    expect(screen.getByRole("treeitem", { name: "Quick chats section" }).getAttribute("aria-expanded")).toBe("true");
    expect(rows()).toEqual(["Regex help", "What is a monad?"]);
    expect(screen.queryByText("Fix login")).toBeNull();
  });

  it("is not drawn at all while there are no quick chats", async () => {
    stored = [ordinary];
    const { container, sessions } = await mount();
    expect(screen.queryByTestId("quick-chats-section")).toBeNull();
    expect(container.querySelector('[role="tree"]')!.children).toHaveLength(0);
    // One started in the floating window appears here at once.
    act(() => mocks.listeners.get("session_created")?.({ payload: chat("chat-9", "From the floating window") }));
    expect(await screen.findByText("From the floating window")).toBeTruthy();
    expect(sessions.getSessionStore().sessions).toHaveLength(2);
  });

  it("opens a quick chat in the main window on a click, and reveals the one that is open", async () => {
    const { sessions } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "What is a monad?" }));
    expect(sessions.getSessionStore().selectedSessionId).toBe("chat-1");
    // Opening it does not focus a project: it has none.
    expect(sessions.getSessionStore().selectedProject).toBeNull();
    // Its tabs are shown under it.
    await waitFor(() => expect(within(screen.getByRole("treeitem", { name: "What is a monad?" })).getByText("Claude")).toBeTruthy());
  });

  it("offers rename, the floating window, a working directory, move to project and delete from its menu", async () => {
    const { sessions } = await mount();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Session menu for Regex help" }), { button: 0, ctrlKey: false });
    const labels = (await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim());
    expect(labels).toEqual(["Rename…", "Open in floating window", "Set working directory…", "Move to project…", "Pin", "Archive", "Fork session", "Delete quick chat…"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Open in floating window" }));
    await waitFor(() => expect(called("floating_show")).toEqual([{ sessionId: "chat-2", tabId: "chat-2-tab" }]));

    // Rename opens the one rename dialog, for this session.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Session menu for Regex help" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const { SessionDialogs } = await import("@/components/session/SessionDialogs");
    render(<SessionDialogs />);
    expect(((await screen.findByLabelText("Session title")) as HTMLInputElement).value).toBe("Regex help");
    expect(sessions.getSessionStore().sessions).toHaveLength(3);
  });

  it("deletes a quick chat after the confirmation and drops its row", async () => {
    mocks.ask.mockResolvedValue(true);
    const { sessions } = await mount();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Session menu for What is a monad?" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete quick chat…" }));
    await waitFor(() => expect(called("delete_session")).toEqual([{ sessionId: "chat-1" }]));
    await waitFor(() => expect(rows()).toEqual(["Regex help"]));
    expect(sessions.getSessionStore().sessions.map((session) => session.id)).toEqual(["chat-2", "project-1"]);
  });

  it("starts a new quick chat in the floating window from its header", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "New quick chat" }));
    // An empty id asks the floating window for its start screen.
    await waitFor(() => expect(called("floating_show")).toEqual([{ sessionId: "", tabId: null }]));
  });

  it("shows archived quick chats only when archived sessions are shown, and collapses with its header", async () => {
    stored = [chat("chat-1", "What is a monad?"), chat("chat-old", "Old question", { archived: true })];
    const { sessions } = await mount();
    expect(rows()).toEqual(["What is a monad?"]);
    act(() => sessions.setShowArchived(true));
    expect(rows()).toEqual(["Old question"]);
    act(() => sessions.setShowArchived(false));

    fireEvent.click(screen.getByRole("button", { name: "Collapse Quick chats" }));
    expect(screen.getByRole("treeitem", { name: "Quick chats section" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("What is a monad?")).toBeNull();
    // The choice is remembered with the other sidebar sections.
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).sidebarSections.quick).toBe("collapsed");
  });
});
