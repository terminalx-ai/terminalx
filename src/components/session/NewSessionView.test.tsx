import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
// Settings → Autocorrect is read through the store's subscription, so this one is live.
const autocorrect = vi.hoisted(() => ({ on: false, listeners: new Set<() => void>() }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({ useWorktree: true, lastAgent: "claude", lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", lastProject: null }),
  getPrefs: () => ({ autocorrect: autocorrect.on }),
  setPrefs: vi.fn(),
  subscribePrefs: (listener: () => void) => {
    autocorrect.listeners.add(listener);
    return () => autocorrect.listeners.delete(listener);
  },
}));

const project = { path: "/repos/raccoon", name: "raccoon" } as Project;
const harness = { id: "claude", name: "Claude", available: true, installHint: "" } as HarnessInfo;
const store = {
  projects: [project] as Project[], selectedProject: project.path as string | null,
  harnesses: [harness], newSessionChat: false,
  newSessionSectionId: null as string | null,
  newSessionPreset: null as { projectPath: string; cwd: string | null; fromBranch?: string } | null,
};
const { createChat, createQuickChat, selectSession } = vi.hoisted(() => ({ createChat: vi.fn(), createQuickChat: vi.fn(), selectSession: vi.fn() }));
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ ...store, workspaces: {} }),
  createQuickChat,
  createChat,
  refreshHarnesses: vi.fn(async () => {}),
  refreshWorkspaces: vi.fn(async () => {}),
  addProject: vi.fn(),
  clearNewSessionPreset: vi.fn(() => { store.newSessionPreset = null; }),
  linkSessionIssue: vi.fn(async () => {}),
  selectProject: vi.fn(),
  selectProjectInSidebar: vi.fn(),
  selectSession,
  startSessionIn: vi.fn((projectPath: string, cwd: string | null, fromBranch?: string) => {
    store.newSessionPreset = { projectPath, cwd, ...(fromBranch ? { fromBranch } : {}) };
  }),
  upsertSession: vi.fn(),
}));

const { NewSessionView } = await import("./NewSessionView");

const created = { id: "session-1", tabs: [{ id: "tab-1" }] } as SessionEntry;

beforeEach(() => {
  dragDropListener.mockReset();
  dragDropListener.mockResolvedValue(vi.fn());
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "check_agent_readiness") return { state: "ready", checkedAt: null, version: null };
    if (cmd === "work_status") return { branch: "main", defaultBranch: "main" };
    if (cmd === "create_session") return created;
    if (cmd === "read_image_file") return { name: "shot.png", mediaType: "image/png", data: "AQID" };
    throw new Error(`unexpected command ${cmd}`);
  });
  openDialog.mockReset();
  createQuickChat.mockReset();
  createQuickChat.mockResolvedValue({ id: "quick-1", kind: "quick", tabs: [{ id: "quick-tab" }] });
  createChat.mockReset();
  createChat.mockResolvedValue(created);
  selectSession.mockReset();
  store.projects = [project];
  store.harnesses = [harness];
  store.newSessionChat = false;
  store.newSessionSectionId = null;
  store.newSessionPreset = null;
  store.selectedProject = project.path;
  project.kind = "git";
  delete project.issuePipeline;
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "attachment-1") });
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
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
  it("retains the draft and attachment when fresh login preflight refuses creation, then sends once after login", async () => {
    let signedIn = true;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_agent_readiness") return { state: signedIn ? "ready" : "signed_out", checkedAt: "2026-10-26T14:00:00Z", version: "1.0.0" };
      if (cmd === "work_status") return { branch: "main", defaultBranch: "main" };
      if (cmd === "create_session") return created;
      if (cmd === "read_image_file") return { name: "shot.png", mediaType: "image/png", data: "AQID" };
      throw new Error(`unexpected command ${cmd}`);
    });
    openDialog.mockResolvedValue(["/tmp/shot.png"]);
    const { onCreated } = renderView();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this task" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await screen.findByAltText("shot.png");
    const start = screen.getByRole("button", { name: "Create" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    signedIn = false;
    fireEvent.click(start);
    await screen.findByText(/Your draft is kept and no session has been created/);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this task");
    expect(screen.getByAltText("shot.png")).toBeTruthy();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "create_session")).toHaveLength(0);
    expect(onCreated).not.toHaveBeenCalled();
    signedIn = true;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "create_session")).toHaveLength(1);
  });

  it("also preserves a quick-chat draft when login is required", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_agent_readiness") return { state: "signed_out", checkedAt: null, version: null };
    });
    render(<NewSessionView quick />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this question" } });
    const ask = screen.getByRole("button", { name: "Ask" });
    await screen.findByText("Sign in to an agent to start a chat. Your draft is kept.");
    expect(ask.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    expect(createQuickChat).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this question");
  });

  it("sends an image picked from the attach button with the first prompt", async () => {
    openDialog.mockResolvedValue(["/tmp/shot.png"]);
    const { onCreated } = renderView();
    const start = screen.getByRole("button", { name: "Create" });
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
    expect(screen.getByText("No Git")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Inspect this folder" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
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
    // The new project's own new-session view, as from the start screen.
    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/tmp/empty-folder", null));
  });

  it("starts Git projects on a new branch, with the branch picker, and previews its name", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "preview_workspace_name") return "quiet-fox";
      if (cmd === "work_status") return { isRepo: true, branch: "main", defaultBranch: "main" };
    });
    render(<NewSessionView />);
    expect(screen.getByRole("button", { name: "Start from" }).textContent).toContain("New branch");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("preview_workspace_name", expect.anything()));
    expect(screen.queryByText("No Git")).toBeNull();
  });
});

describe("starting a quick chat", () => {
  it("needs no project: with none attached, a prompt starts a chat in a scratch folder and is sent", async () => {
    store.projects = [];
    store.selectedProject = null;
    const onCreated = vi.fn();
    render(<NewSessionView quick compact onCreated={onCreated} />);
    const prompt = screen.getByPlaceholderText("Ask anything");
    const start = screen.getByRole("button", { name: "Ask" });
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
    // Only local transcription preferences and agent readiness were read; no
    // project session was made, and no git was read.
    expect(invoke.mock.calls.map(([command]) => command).sort()).toEqual(["check_agent_readiness", "check_agent_readiness", "transcription_personalization_load"]);
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

    fireEvent.change(screen.getByPlaceholderText("Ask anything"), { target: { value: "Summarise these" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(createQuickChat).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/Users/me/notes" })));
    expect(addProject).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("create_session", expect.anything());
  });

  it("says what went wrong and keeps the prompt when the chat cannot be created", async () => {
    createQuickChat.mockRejectedValue(new Error("Not a directory: /nope"));
    const onCreated = vi.fn();
    render(<NewSessionView quick onCreated={onCreated} />);
    const prompt = screen.getByPlaceholderText("Ask anything") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "hello" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Not a directory: /nope")).toBeTruthy();
    expect(prompt.value).toBe("hello");
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("autocorrect in the new-session prompt (#525)", () => {
  afterEach(() => {
    autocorrect.on = false;
  });

  function turnAutocorrect(on: boolean) {
    act(() => {
      autocorrect.on = on;
      for (const listener of autocorrect.listeners) listener();
    });
  }

  it("leaves what is typed alone while the setting is off, and follows it at once when it changes", () => {
    renderView();
    const prompt = document.querySelector<HTMLTextAreaElement>("[data-new-session-prompt]")!;
    expect([prompt.getAttribute("spellcheck"), prompt.getAttribute("autocorrect"), prompt.getAttribute("autocapitalize")]).toEqual(["false", "off", "off"]);

    turnAutocorrect(true);
    expect(["spellcheck", "autocorrect", "autocapitalize"].filter((name) => prompt.hasAttribute(name))).toEqual([]);

    turnAutocorrect(false);
    expect(prompt.getAttribute("spellcheck")).toBe("false");
  });
});

it("launches a non-issue branch with project automation defaults and the handoff brief", async () => {
  const { DEFAULT_PIPELINE_SETTINGS } = await import("@/lib/issuePipeline");
  project.issuePipeline = { ...DEFAULT_PIPELINE_SETTINGS, autoMerge: true, resolveConflicts: true };
  invoke.mockImplementation(async (command: string) => {
    if (command === "preview_workspace_name") return "quiet-fox";
    if (command === "work_status") return { isRepo: true, branch: "main", defaultBranch: "main" };
    if (command === "create_session") return created;
    if (command === "issue_pipeline_start") return { pipeline: { id: "p1", resolveConflicts: true }, authorBrief: "HANDOFF BRIEF" };
    if (command === "issue_pipeline_set_resolve_conflicts") return { id: "p1", resolveConflicts: true };
    throw new Error(`Unexpected command ${command}`);
  });
  const onCreated = vi.fn();
  render(<NewSessionView onCreated={onCreated} />);
  fireEvent.click(screen.getByRole("button", { name: "Session options" }));
  expect(screen.getByRole("switch", { name: "Merge when green" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("switch", { name: "Resolve conflicts automatically" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(screen.getByRole("switch", { name: "Merge when green" }), { key: "Escape" });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Improve the parser" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("issue_pipeline_start", { sessionId: "session-1", tabId: "tab-1", autoMerge: true }));
  expect(invoke).toHaveBeenCalledWith("issue_pipeline_set_resolve_conflicts", { id: "p1", value: true });
  expect(onCreated).toHaveBeenCalledWith("session-1", "tab-1", "Improve the parser\n\nHANDOFF BRIEF", []);
});

it("starts a branch with both switches off, and one started from an issue picked here with both on", async () => {
  const issue = {
    provider: "github", id: "700", identifier: "#700", number: 700, title: "Merge issue sessions when green",
    url: "https://example.test/issues/700", state: "OPEN", stateType: "open", labels: [], updatedAt: "2026-11-01T00:00:00Z", body: "Turn both on.",
  };
  invoke.mockImplementation(async (command: string) => {
    if (command === "preview_workspace_name") return "700-merge-issue-sessions";
    if (command === "work_status") return { isRepo: true, branch: "main", defaultBranch: "main" };
    if (command === "issues_list") return [issue];
    if (command === "issue_comments") return { comments: [], nextCursor: null };
    if (command === "create_session") return created;
    if (command === "issue_pipeline_start") return { pipeline: { id: "p1", resolveConflicts: false }, authorBrief: "HANDOFF BRIEF" };
    if (command === "issue_pipeline_set_resolve_conflicts") return { id: "p1", resolveConflicts: true };
    throw new Error(`Unexpected command ${command}`);
  });
  render(<NewSessionView onCreated={vi.fn()} />);
  const switches = () => {
    if (!screen.queryByRole("switch", { name: "Merge when green" })) fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    return [screen.getByRole("switch", { name: "Resolve conflicts automatically" }), screen.getByRole("switch", { name: "Merge when green" })].map((toggle) => toggle.getAttribute("aria-checked"));
  };
  const closeOptions = () => fireEvent.keyDown(screen.getByRole("switch", { name: "Merge when green" }), { key: "Escape" });
  expect(switches()).toEqual(["false", "false"]);
  closeOptions();

  fireEvent.click(screen.getByRole("button", { name: "Start from" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Issues" }), { button: 0 });
  fireEvent.click(await screen.findByRole("option", { name: /Merge issue sessions when green/ }));
  await screen.findByTestId("picked-issue");
  expect(switches()).toEqual(["true", "true"]);
  closeOptions();
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("issue_pipeline_start", { sessionId: "session-1", tabId: "tab-1", autoMerge: true }));
  expect(invoke).toHaveBeenCalledWith("issue_pipeline_set_resolve_conflicts", { id: "p1", value: true });
});

it("opening the main window preserves an unsent initial prompt in the source view", async () => {
  const view = render(<NewSessionView quick compact />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "An initial prompt I have not sent" } });
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "chat_window_open_in_main" && args.closeSource !== false) view.unmount();
  });
  const { openChatWindowInMain } = await import("@/lib/chatWindowHandoff");
  await act(async () => { await openChatWindowInMain("", null); });
  expect(screen.getByRole("textbox")).toHaveProperty("value", "An initial prompt I have not sent");
  expect(invoke).toHaveBeenCalledWith("chat_window_open_in_main", { sessionId: "", tabId: null, closeSource: false });
});

describe("one new-chat composer (PRO-173)", () => {
  it("updates setup and enables the installed agent after returning from Terminal without Check again (PRO-170)", async () => {
    store.harnesses = [{ ...harness, id: "codex", name: "Codex", available: false }];
    let readiness = "missing";
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === "check_agent_readiness"
      ? Promise.resolve({ state: readiness, checkedAt: null, version: null })
      : original(command, args));
    renderView();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this draft" } });
    await screen.findByText("Not installed");

    readiness = "signed_out";
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByText("Installed · sign in required");
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);

    readiness = "ready";
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByText("Ready · local login found");
    expect(screen.getByTestId("agent-menu").getAttribute("title")).toBe("Codex · Bypass");
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
    expect(createQuickChat).not.toHaveBeenCalled();
  });

  it("submits a sidebar draft as an ordinary chat, preserving retention and Chats linking", async () => {
    store.newSessionChat = true;
    store.projects = [];
    const { onCreated } = renderView();
    expect(createChat).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this conversation" } });
    const send = screen.getByRole("button", { name: "Ask" });
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(createQuickChat).not.toHaveBeenCalled();
    expect(createChat).toHaveBeenCalledWith({ title: "Keep this conversation", cwd: null, tab: { harness: "claude", model: "", effort: null, permissionMode: "bypassPermissions" } });
  });

  it("does not substitute another project if the explicit destination disappears", async () => {
    store.newSessionPreset = { projectPath: "/repos/removed", cwd: "/repos/removed/worktrees/task" };
    renderView();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Continue the task" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: project.name })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    expect(invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
  });

  it("keeps the advertised source when New branch is selected again", async () => {
    store.newSessionPreset = { projectPath: project.path, cwd: null, fromBranch: "feature/login" };
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === "preview_workspace_name" ? Promise.resolve("login-work")
      : command === "list_branches" ? Promise.resolve([]) : original(command, args));
    const { rerender, onCreated } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Start from" }));
    fireEvent.click(await screen.findByRole("option", { name: /New branch.*from feature\/login/ }));
    rerender(<NewSessionView onCreated={onCreated} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix login" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("create_session", { req: expect.objectContaining({ projectPath: project.path, baseRef: "feature/login", useWorktree: true, cwd: null }) });
  });

  it("replaces the source preset when another existing branch is chosen", async () => {
    store.newSessionPreset = { projectPath: project.path, cwd: null, fromBranch: "feature/login" };
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === "preview_workspace_name" ? Promise.resolve("other-work")
      : command === "list_branches" ? Promise.resolve([{ name: "feature/other", remote: false }]) : original(command, args));
    const { rerender, onCreated } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Start from" }));
    fireEvent.click(await screen.findByRole("option", { name: "feature/other New worktree" }));
    rerender(<NewSessionView onCreated={onCreated} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Continue other work" } });
    const create = screen.getByRole("button", { name: "Create" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("create_session", { req: expect.objectContaining({
      projectPath: project.path, checkoutBranch: "feature/other", baseRef: null, useWorktree: true, cwd: null,
    }) });
  });

  it.each([
    [false, "signed_out", "signed_out", null], [true, "signed_out", "signed_out", null],
    [false, "ready", "signed_out", "Claude"], [true, "ready", "signed_out", "Claude"],
    [false, "signed_out", "ready", "Codex"], [true, "signed_out", "ready", "Codex"],
    [false, "ready", "ready", "Claude"], [true, "ready", "ready", "Claude"],
  ] as const)("projectless=%s, Claude=%s, Codex=%s selects %s without creating a session", async (projectless, claude, codex, chosen) => {
    store.harnesses = [harness, { ...harness, id: "codex", name: "Codex" }];
    store.newSessionChat = projectless;
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === "check_agent_readiness"
      ? Promise.resolve({ state: args.harness === "codex" ? codex : claude, checkedAt: null, version: null })
      : original(command, args));
    renderView();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this draft" } });
    if (chosen) {
      await waitFor(() => expect(screen.getByTestId("agent-menu").getAttribute("title")).toBe(`${chosen} · Bypass`));
      expect(screen.getByRole("button", { name: projectless ? "Ask" : "Create" }).hasAttribute("disabled")).toBe(false);
    } else {
      await screen.findByText("Sign in to an agent to start a chat. Your draft is kept.");
      expect(screen.getByRole("button", { name: projectless ? "Ask" : "Create" }).hasAttribute("disabled")).toBe(true);
    }
    expect(createQuickChat).not.toHaveBeenCalled();
    expect(createChat).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this draft");
  });

  it("sends a branch preset only with the first prompt, even with a saved in-place preference", async () => {
    store.newSessionPreset = { projectPath: project.path, cwd: null, fromBranch: "feature/login" };
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === "preview_workspace_name" ? Promise.resolve("login-work") : original(command, args));
    const { onCreated } = renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" }).hasAttribute("disabled")).toBe(false));
    expect(invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix login" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("create_session", { req: expect.objectContaining({ projectPath: project.path, baseRef: "feature/login", useWorktree: true, cwd: null }) });
  });
});

it.each([null, "release"])("starts a selected PR in its own worktree and keeps the prompt and section (%s)", async (sectionId) => {
  store.newSessionSectionId = sectionId;
  Element.prototype.scrollIntoView = vi.fn();
  invoke.mockImplementation(async (command: string) => {
    if (command === "check_agent_readiness") return { state: "ready", checkedAt: null, version: null };
    if (command === "preview_workspace_name") return "pr-12-parser";
    if (command === "work_status") return { isRepo: true, branch: "main", defaultBranch: "main" };
    if (command === "list_branches") return [];
    if (command === "pr_search") return [{ number: 12, title: "Fix parser", author: "alice", state: "OPEN", url: "https://github.com/acme/app/pull/12" }];
    if (command === "create_session") return created;
    throw new Error(`Unexpected command ${command}`);
  });
  const onCreated = vi.fn();
  render(<NewSessionView onCreated={onCreated} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Check the edge cases" } });
  fireEvent.click(screen.getByRole("button", { name: "Start from" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Pull requests" }), { button: 0 });
  fireEvent.click(await screen.findByRole("option", { name: /#12 Fix parser/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith("create_session", { req: expect.objectContaining({ checkoutPr: 12, checkoutBranch: null, baseRef: null, cwd: null, useWorktree: true }) });
  expect(invoke.mock.calls.find(([command]) => command === "create_session")?.[1].req.sectionId).toBe(sectionId ?? undefined);
  expect(onCreated.mock.calls[0][2]).toBe("Check the edge cases\n\nContinue work on pull request #12: Fix parser\nhttps://github.com/acme/app/pull/12");
});

it("allows Tab and starts with the literal issue number on Enter when PR search has no match", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "pr_search" ? Promise.resolve([]) : original(command, args));
  const { onCreated } = renderView();
  const field = screen.getByRole("textbox");
  fireEvent.change(field, { target: { value: "fix #45" } });
  await screen.findByText("No matching pull requests");
  expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(true);
  expect(onCreated).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false));
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  expect(onCreated.mock.calls[0][2]).toBe("fix #45");
  expect(invoke.mock.calls.some(([command]) => command === "pr_attach")).toBe(false);
});

it.each([false, true])("waits for PR context before creating a session, unless Escape cancels it (cancel=%s)", async (cancel) => {
  Element.prototype.scrollIntoView = vi.fn();
  let finish!: (path: string) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => {
    if (command === "pr_search") return Promise.resolve([{ number: 12, title: "Fix parser", author: "alice", state: "OPEN" }]);
    if (command === "pr_attach") return new Promise<string>((resolve) => { finish = resolve; });
    return original(command, args);
  });
  const { onCreated } = renderView();
  const field = screen.getByRole("textbox");
  fireEvent.change(field, { target: { value: "Review #12" } });
  fireEvent.mouseDown(await screen.findByRole("option", { name: /#12 Fix parser/ }));
  expect(invoke).toHaveBeenCalledWith("pr_attach", expect.objectContaining({ number: 12 }));
  const start = screen.getByRole("button", { name: "Create" });
  expect(start.hasAttribute("disabled")).toBe(true);
  fireEvent.click(start);
  expect(invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
  if (cancel) fireEvent.keyDown(field, { key: "Escape" });
  else await act(async () => finish("/context/pr-12.md"));
  await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(onCreated.mock.calls[0][2]).toBe(cancel ? "Review #12" : "Review @/context/pr-12.md ");
  if (cancel) await act(async () => finish("/context/pr-12.md"));
});

describe("new sessions in a personal section", () => {
  it.each([false, true])("includes the section in the creation request (projectless=%s)", async (projectless) => {
    store.newSessionSectionId = "release";
    store.newSessionChat = projectless;
    const { onCreated } = renderView();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ship the release" } });
    const send = screen.getByRole("button", { name: projectless ? "Ask" : "Create" });
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    if (projectless) expect(createChat).toHaveBeenCalledWith(expect.objectContaining({ sectionId: "release" }));
    else expect(invoke).toHaveBeenCalledWith("create_session", expect.objectContaining({ req: expect.objectContaining({ sectionId: "release" }) }));
  });
});

describe("what the new-session view says about the project and the agents (PRO-285)", () => {
  afterEach(() => { delete project.scripts; });

  it("shows the saved setup script's command, true to what runs: by itself, in a new worktree", async () => {
    project.scripts = { setup: "\n  pnpm install\npnpm build\n", archive: "" };
    renderView();
    const line = await screen.findByTestId("setup-script-line");
    expect(line.textContent).toContain("Setup script found");
    expect(line.textContent).toContain("pnpm install …");
    expect(line.textContent).toContain("runs by itself in each new worktree, without asking");
    expect(line.textContent).not.toContain("asks before");
  });

  it("shows no setup line when no setup script is saved", async () => {
    project.scripts = { setup: "  \n", archive: "echo bye" };
    const { rerender } = renderView();
    await screen.findByText(/Nothing starts until you press Create/);
    expect(screen.queryByTestId("setup-script-line")).toBeNull();
    delete project.scripts;
    rerender(<NewSessionView onCreated={vi.fn()} useWorktree={false} onUseWorktreeChange={vi.fn()} />);
    expect(screen.queryByTestId("setup-script-line")).toBeNull();
  });

  it("lists only the agents that are installed and signed in, beside the Create note", async () => {
    const codex = { id: "codex", name: "Codex", available: true, installHint: "" } as HarnessInfo;
    const gemini = { id: "gemini", name: "Gemini", available: true, installHint: "" } as HarnessInfo;
    const aider = { id: "aider", name: "Aider", available: false, installHint: "" } as HarnessInfo;
    store.harnesses = [harness, codex, gemini, aider];
    invoke.mockImplementation(async (cmd: string, args?: { harness?: string }) => {
      if (cmd === "check_agent_readiness") return { state: ({ claude: "ready", codex: "signed_out", gemini: "unknown", aider: "missing" } as Record<string, string>)[args?.harness ?? ""], checkedAt: null, version: null };
      if (cmd === "work_status") return { branch: "main", defaultBranch: "main" };
      return null;
    });
    renderView();
    await waitFor(() => expect(screen.getAllByTestId("agent-signed-in").map((node) => node.textContent)).toEqual(["Claude signed in"]));
    expect(screen.getByText("Nothing starts until you press Create.")).toBeTruthy();
  });
});
