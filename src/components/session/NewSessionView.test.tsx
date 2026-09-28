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
}));
vi.mock("@/lib/dictation", () => ({ stopDictation: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn() }));
vi.mock("@/lib/models", () => ({
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "bypassPermissions", label: "Bypass", hint: "" }],
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => [],
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({ useWorktree: true, lastAgent: "claude", lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", lastProject: null }),
  setPrefs: vi.fn(),
}));

const project = { path: "/repos/raccoon", name: "raccoon" } as Project;
const harness = { id: "claude", name: "Claude", available: true, installHint: "" } as HarnessInfo;
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ projects: [project], harnesses: [harness], selectedProject: project.path, workspaces: {}, newSessionPreset: null }),
  addProject: vi.fn(),
  clearNewSessionPreset: vi.fn(),
  selectProject: vi.fn(),
  selectProjectInSidebar: vi.fn(),
  selectSession: vi.fn(),
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
