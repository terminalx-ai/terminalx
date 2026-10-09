import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo, Project, SessionEntry } from "@/types/session";

const { dragDropListener, invoke, openDialog } = vi.hoisted(() => ({ dragDropListener: vi.fn(), invoke: vi.fn(), openDialog: vi.fn() }));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonScene: () => null }));
vi.mock("@/components/chat/Dictation", () => ({
  DictationStatus: () => null,
  MicButton: () => null,
  NEW_SESSION_TARGET: "new-session",
  useDictationInto: () => ({ dictating: false, toggle: vi.fn() }),
  useDictationShortcuts: vi.fn(),
}));
vi.mock("@/lib/dictation", () => ({ stopDictation: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn(), useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "bypassPermissions", label: "Bypass", hint: "" }],
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => [],
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({ useWorktree: true, lastAgent: "claude", lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", lastProject: null }),
  getPrefs: () => ({}),
  setPrefs: vi.fn(),
}));

const project = { path: "/repos/raccoon", name: "raccoon" } as Project;
const harness = { id: "claude", name: "Claude", available: true, installHint: "" } as HarnessInfo;
const store = { projects: [project] as Project[], selectedProject: project.path as string | null };
const { createQuickChat, selectSession } = vi.hoisted(() => ({ createQuickChat: vi.fn(), selectSession: vi.fn() }));
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ projects: store.projects, harnesses: [harness], selectedProject: store.selectedProject, workspaces: {}, newSessionPreset: null }),
  createQuickChat,
  addProject: vi.fn(),
  clearNewSessionPreset: vi.fn(),
  selectProject: vi.fn(),
  selectProjectInSidebar: vi.fn(),
  selectSession,
  upsertSession: vi.fn(),
}));

const { NewSessionView } = await import("./NewSessionView");

const created = { id: "session-1", tabs: [{ id: "tab-1" }] } as SessionEntry;

beforeEach(() => {
  dragDropListener.mockReset();
  dragDropListener.mockResolvedValue(vi.fn());
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "work_status") return { branch: "main", defaultBranch: "main" };
    if (cmd === "create_session") return created;
    if (cmd === "read_image_file") return { name: "shot.png", mediaType: "image/png", data: "AQID" };
    throw new Error(`unexpected command ${cmd}`);
  });
  openDialog.mockReset();
  createQuickChat.mockReset();
  createQuickChat.mockResolvedValue({ id: "quick-1", kind: "quick", tabs: [{ id: "quick-tab" }] });
  selectSession.mockReset();
  store.projects = [project];
  store.selectedProject = project.path;
  project.kind = "git";
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "attachment-1") });
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderView(onCreated = vi.fn()) {
  const utils = render(<NewSessionView onCreated={onCreated} useWorktree={false} onUseWorktreeChange={vi.fn()} />);
  return { ...utils, onCreated };
}

describe("new session attachments", () => {
  it("sends an image picked from the attach button with the first prompt", async () => {
    openDialog.mockResolvedValue(["/tmp/shot.png"]);
    const { onCreated } = renderView();
    const start = screen.getByRole("button", { name: "Start" });
    expect(start.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    expect(await screen.findByAltText("shot.png")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("read_image_file", { path: "/tmp/shot.png" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));

    fireEvent.click(start);

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("session-1", "tab-1", "", [{ mediaType: "image/png", data: "AQID", name: "shot.png" }]));
    expect(invoke).toHaveBeenCalledWith("create_session", expect.objectContaining({ req: expect.objectContaining({ projectPath: project.path, title: "" }) }));
    expect(screen.queryByAltText("shot.png")).toBeNull();
  });

  it("attaches a pasted image", async () => {
    const { container } = renderView();
    const image = new File([new Uint8Array([1, 2, 3])], "paste.png", { type: "image/png" });
    const frame = container.querySelector("textarea")!.parentElement!;

    fireEvent.paste(frame, { clipboardData: { files: [image] } });

    expect(await screen.findByAltText("paste.png")).toBeTruthy();
  });

  it("shows the drop target and attaches a file dropped on the window", async () => {
    renderView();
    await waitFor(() => expect(dragDropListener).toHaveBeenCalledOnce());
    const onDrag = dragDropListener.mock.calls[0][0] as (e: { payload: { type: string; paths?: string[] } }) => Promise<void>;

    await onDrag({ payload: { type: "enter" } });
    expect(await screen.findByText("Drop images to attach, other files to mention")).toBeTruthy();

    await onDrag({ payload: { type: "drop", paths: ["/tmp/shot.png"] } });
    expect(await screen.findByAltText("shot.png")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Drop images to attach, other files to mention")).toBeNull());
  });
});


describe("folder projects", () => {
  it("starts in the folder despite a saved worktree preference", async () => {
    project.kind = "folder";
    render(<NewSessionView />);
    expect(screen.getByText("Folder · no Git")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Inspect this folder" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_session", expect.objectContaining({ req: expect.objectContaining({
      projectPath: project.path, useWorktree: false, worktreeName: null, cwd: null,
    }) })));
    expect(invoke.mock.calls.some(([cmd]) => cmd === "preview_workspace_name" || cmd === "work_status")).toBe(false);
  });

  it("opens a folder from the new-session project picker", async () => {
    const sessions = await import("@/lib/sessions");
    vi.mocked(sessions.addProject).mockResolvedValue({ path: "/tmp/empty-folder", name: "empty-folder", kind: "folder" });
    openDialog.mockResolvedValue("/tmp/empty-folder");
    renderView();
    fireEvent.keyDown(screen.getByRole("button", { name: /raccoon/ }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Add a project/ }));
    await waitFor(() => expect(sessions.addProject).toHaveBeenCalledWith("/tmp/empty-folder"));
    expect(sessions.selectProjectInSidebar).toHaveBeenCalledWith("/tmp/empty-folder");
  });

  it("keeps the worktree switch and name preview for Git projects", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "preview_workspace_name") return "quiet-fox";
      if (cmd === "work_status") return { isRepo: true, branch: "main", defaultBranch: "main" };
    });
    render(<NewSessionView />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("preview_workspace_name", expect.anything()));
    expect(screen.queryByText("Folder · no Git")).toBeNull();
  });
});

describe("starting a quick chat", () => {
  it("needs no project: with none attached, a prompt starts a chat in a scratch folder and is sent", async () => {
    store.projects = [];
    store.selectedProject = null;
    const onCreated = vi.fn();
    render(<NewSessionView quick compact onCreated={onCreated} />);
    const prompt = screen.getByPlaceholderText("Ask a question or describe a task.");
    const start = screen.getByRole("button", { name: "Start" });
    expect(start.hasAttribute("disabled")).toBe(true);
    // Nothing about projects or worktrees is offered.
    expect(screen.queryByText("Choose project")).toBeNull();
    expect(screen.queryByText(/New worktree/)).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("button", { name: "Working directory" }).textContent).toContain("Scratch folder");

    fireEvent.change(prompt, { target: { value: "What is a monad?\nIn one paragraph." } });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("quick-1", "quick-tab", "What is a monad?\nIn one paragraph.", []));
    expect(createQuickChat).toHaveBeenCalledWith({ title: "What is a monad?", cwd: null, tab: { harness: "claude", model: "", effort: null, permissionMode: "bypassPermissions" } });
    expect(selectSession).toHaveBeenCalledWith("quick-1");
    // No project session was made, and no git was read.
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([]);
  });

  it("can be pointed at a folder first, which is passed as the working directory and not added as a project", async () => {
    openDialog.mockResolvedValue("/Users/me/notes");
    const { addProject } = await import("@/lib/sessions");
    vi.mocked(addProject).mockClear();
    render(<NewSessionView quick onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Working directory" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Choose folder…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Working directory" }).textContent).toContain("notes"));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));

    fireEvent.change(screen.getByPlaceholderText("Ask a question or describe a task."), { target: { value: "Summarise these" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(createQuickChat).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/Users/me/notes" })));
    expect(addProject).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("create_session", expect.anything());
  });

  it("says what went wrong and keeps the prompt when the chat cannot be created", async () => {
    createQuickChat.mockRejectedValue(new Error("Not a directory: /nope"));
    const onCreated = vi.fn();
    render(<NewSessionView quick onCreated={onCreated} />);
    const prompt = screen.getByPlaceholderText("Ask a question or describe a task.") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Not a directory: /nope")).toBeTruthy();
    expect(prompt.value).toBe("hello");
    expect(onCreated).not.toHaveBeenCalled();
  });
});
