import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@/lib/api";
import type { Project, SessionEntry, TabEntry } from "@/types/session";
import type { ContinuationContext } from "@/lib/continuation";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), providers: vi.fn(), launch: vi.fn(), move: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), agent: { prepareContinuation: mocks.prepare }, api: { listHarnesses: mocks.providers }, errorMessage: String }));
vi.mock("@/lib/continuation", async (original) => ({ ...await original<typeof import("@/lib/continuation")>(), launchContinuation: mocks.launch, moveChatToProject: mocks.move }));
const model = (harness: string, id: string, label: string, efforts: string[], isDefault = false): ModelInfo =>
  ({ id, label, harness, efforts, defaultEffort: efforts[1] ?? null, acceptsImages: true, isDefault, upgrade: null, description: null });
const catalog = [
  model("claude", "opus", "Opus", ["low", "medium", "high", "max"], true),
  model("claude", "sonnet", "Sonnet", ["low", "medium", "high"]),
  model("codex", "gpt-6", "GPT-6", ["low", "medium", "high"], true),
  model("codex", "gpt-6-mini", "GPT-6 Mini", ["low", "medium"]),
];
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  loadModels: vi.fn(async () => {}),
  refreshModels: vi.fn(),
  useModels: (harness?: string) => catalog.filter((m) => !harness || m.harness === harness),
}));
import { getPrefs, setPrefs } from "@/lib/prefs";
import { continuationPrompt } from "@/lib/continuation";
import { ContinuationDialog } from "./ContinuationDialog";
const source = { id: "source", harness: "claude", title: "Fix issue", status: "waiting", model: "sonnet", effort: "low", permissionMode: "plan" } as TabEntry;
const session = { id: "workspace", cwd: "/same/cwd", title: "Workspace" } as SessionEntry;
const context: ContinuationContext = { sessionId: session.id, tabId: source.id, title: "Fix issue", cwd: session.cwd, provider: "claude", providerSessionId: "original", sourceActive: true, transcriptPath: "/history.jsonl", fullUnavailableReason: null, lastPrompt: "Fix issue", lastUpdate: "Halfway", partialCapture: null };
const providers = [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }];
const sourceSettings = { harness: "claude", model: "sonnet", effort: "low", permissionMode: "plan", pipeline: { autoMerge: false, resolveConflicts: false } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.prepare.mockResolvedValue(context);
  mocks.providers.mockResolvedValue(providers);
  setPrefs({ lastAgent: "codex", lastModel: { claude: "opus", codex: "gpt-6-mini" }, lastEffort: { claude: "high", codex: "medium" }, lastMode: "auto", bypassConfirmed: false });
});
afterEach(cleanup);
function open(onClose = vi.fn(), into?: { project: Project; worktree: boolean }) { return { ...render(<ContinuationDialog session={session} source={source} into={into} onClose={onClose} />), onClose }; }
async function loaded(start = "Start New Session") { await waitFor(() => expect(screen.getByRole("button", { name: start }).hasAttribute("disabled")).toBe(false)); }
const shown = () => ["Agent", "Model", "Effort", "Permissions"].map((title) => screen.getByTitle(title).textContent);
async function pickAgent(name: string) {
  fireEvent.click(screen.getByTitle("Agent"));
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
it("shows accessible source details, the source's launch settings, focused default and active-turn notice", async () => {
  open(); await loaded();
  expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBeTruthy();
  expect(shown()).toEqual(["Claude Code", "Sonnet", "Low", "Plan"]);
  expect((screen.getByRole("radio", { name: /Focused handoff/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("/same/cwd")).toBeTruthy();
  expect(screen.getByText(/Source work may still be progressing/)).toBeTruthy();
});
it("starts the new tab with exactly the source conversation's settings", async () => {
  mocks.launch.mockResolvedValue({ stage: "delivered", launched: { sessionId: session.id, tab: { id: "new" } } });
  open(); await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledWith(context, sourceSettings, continuationPrompt(context, "focused"), expect.any(Function), undefined));
});
it("switches provider to that provider's saved settings, keeps the mode, and launches exactly that", async () => {
  mocks.launch.mockResolvedValue({ stage: "delivered", launched: { sessionId: session.id, tab: { id: "new" } } });
  open(); await loaded();
  await pickAgent("Codex");
  expect(shown()).toEqual(["Codex", "GPT-6 Mini", "Medium", "Plan"]);
  fireEvent.click(screen.getByRole("radio", { name: /Full session transcript/ }));
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledWith(context, { harness: "codex", model: "gpt-6-mini", effort: "medium", permissionMode: "plan", pipeline: { autoMerge: false, resolveConflicts: false } }, continuationPrompt(context, "full"), expect.any(Function), undefined));
});
it("keeps the dialog's choices to this launch, leaving the saved preferences as they were", async () => {
  mocks.launch.mockResolvedValue({ stage: "delivered", launched: { sessionId: session.id, tab: { id: "new" } } });
  const saved = { lastAgent: getPrefs().lastAgent, lastModel: getPrefs().lastModel, lastEffort: getPrefs().lastEffort, lastMode: getPrefs().lastMode };
  open(); await loaded();
  await pickAgent("Codex");
  fireEvent.click(screen.getByTitle("Model"));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "GPT-6" }));
  expect(shown()).toEqual(["Codex", "GPT-6", "Medium", "Plan"]);
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledWith(context, { harness: "codex", model: "gpt-6", effort: "medium", permissionMode: "plan", pipeline: { autoMerge: false, resolveConflicts: false } }, expect.any(String), expect.any(Function), undefined));
  expect(getPrefs()).toMatchObject(saved);
});
it("falls back to the configured provider and disables full mode with an explanation", async () => {
  mocks.providers.mockResolvedValue([{ ...providers[0], available: false }, providers[1]]);
  mocks.prepare.mockResolvedValue({ ...context, transcriptPath: null, fullUnavailableReason: "Saved history is unreadable.", partialCapture: "Partial recent history" });
  open(); await loaded();
  expect(shown()).toEqual(["Codex", "GPT-6 Mini", "Medium", "Plan"]);
  expect(screen.getByRole("radio", { name: /Full session transcript/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Saved history is unreadable.")).toBeTruthy();
});
it.each(["detection", "none", "context"])("shows %s failure without allowing a launch", async (failure) => {
  if (failure === "detection") mocks.providers.mockRejectedValue(new Error("probe failed"));
  if (failure === "none") mocks.providers.mockResolvedValue([]);
  if (failure === "context") mocks.prepare.mockRejectedValue(new Error("No usable context"));
  open(); await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Start New Session" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("allows cancellation while loading and ignores the late result", async () => {
  let resolve!: (value: ContinuationContext) => void;
  mocks.prepare.mockReturnValue(new Promise((done) => { resolve = done; }));
  const view = open();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(view.onClose).toHaveBeenCalledTimes(1);
  view.unmount(); resolve(context);
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("prevents duplicate starts and closes only on delivered success", async () => {
  let resolve!: (value: unknown) => void;
  mocks.launch.mockReturnValue(new Promise((done) => { resolve = done; }));
  const view = open(); await loaded();
  const button = screen.getByRole("button", { name: "Start New Session" });
  fireEvent.click(button); fireEvent.click(button);
  expect(mocks.launch).toHaveBeenCalledTimes(1);
  expect(view.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByTitle("Agent").hasAttribute("disabled")).toBe(true);
  resolve({ stage: "delivered", launched: { sessionId: session.id, tab: { id: "new" } } });
  await waitFor(() => expect(view.onClose).toHaveBeenCalledTimes(1));
});
it("retains the dialog on launch failure and resets errors and selection on reopening", async () => {
  mocks.launch.mockResolvedValue({ stage: "launch", error: "Could not launch" });
  const view = open(); await loaded();
  await pickAgent("Codex");
  fireEvent.click(screen.getByRole("radio", { name: /Full session transcript/ }));
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(view.onClose).not.toHaveBeenCalled();
  view.unmount(); open(); await loaded();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(shown()).toEqual(["Claude Code", "Sonnet", "Low", "Plan"]);
  expect((screen.getByRole("radio", { name: /Focused handoff/ }) as HTMLInputElement).checked).toBe(true);
});
it.each(["button", "escape"])("allows opening the destination with %s while delivery is pending", async (dismiss) => {
  let resolve!: (value: unknown) => void;
  mocks.launch.mockImplementation((_context, _settings, _prompt, onCreated) => {
    onCreated({ sessionId: session.id, tab: { id: "new" } });
    return new Promise((done) => { resolve = done; });
  });
  const view = open(); await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  expect(screen.getByRole("button", { name: "Starting…" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Open New Session" }).hasAttribute("disabled")).toBe(false);
  if (dismiss === "button") fireEvent.click(screen.getByRole("button", { name: "Open New Session" }));
  else fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(view.onClose).toHaveBeenCalledTimes(1);
  view.unmount();
  const reopened = open(); await loaded();
  await act(async () => { resolve({ stage: "delivered", launched: { sessionId: session.id, tab: { id: "new" } } }); });
  expect(view.onClose).toHaveBeenCalledTimes(1);
  expect(reopened.onClose).not.toHaveBeenCalled();
  expect(mocks.launch).toHaveBeenCalledTimes(1);
});
it("makes the destination reachable after delivery failure without offering a duplicate launch", async () => {
  mocks.launch.mockImplementation(async (_context, _settings, _prompt, onCreated) => {
    onCreated({ sessionId: session.id, tab: { id: "new" } });
    return { stage: "delivery", launched: { sessionId: session.id, tab: { id: "new" } }, error: "Context delivery failed; prompt retained" };
  });
  const view = open(); await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start New Session" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open New Session" }));
  expect(view.onClose).toHaveBeenCalledTimes(1);
});

describe("linking a chat to a project", () => {
  const repo = { path: "/repos/web", name: "web", kind: "git" } as Project;
  const chat = { id: "chat-1", cwd: "/store/Chats", title: "Plan the login page" } as SessionEntry;
  const chatTab = { ...source, title: "Login page plan" } as TabEntry;
  const chatContext = { ...context, sessionId: chat.id, cwd: chat.cwd };
  const link = (project: Project, worktree: boolean, onClose = vi.fn()) => ({ ...render(<ContinuationDialog session={chat} source={chatTab} into={{ project, worktree }} onClose={onClose} />), onClose });
  beforeEach(() => { mocks.prepare.mockResolvedValue(chatContext); });

  it("shows the destination and the source chat's launch settings, and starts there with exactly what was selected", async () => {
    mocks.move.mockResolvedValue({ stage: "delivered", launched: { sessionId: "work-1", tab: { id: "work-tab" } } });
    const view = link(repo, true); await loaded("Link and Start");
    expect(screen.getByRole("heading", { name: "Link to a Project" })).toBeTruthy();
    expect(screen.getByText("/repos/web")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Start on a new branch in a worktree" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect(shown()).toEqual(["Claude Code", "Sonnet", "Low", "Plan"]);
    await pickAgent("Codex");
    fireEvent.click(screen.getByRole("button", { name: "Link and Start" }));
    await waitFor(() => expect(view.onClose).toHaveBeenCalled());
    expect(mocks.move).toHaveBeenCalledExactlyOnceWith(
      { id: "chat-1", title: "Login page plan" },
      { projectPath: "/repos/web", worktree: true },
      { harness: "codex", model: "gpt-6-mini", effort: "medium", permissionMode: "plan" },
      continuationPrompt(chatContext, "focused", "/repos/web"),
      expect.any(Function),
      undefined,
    );
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("can start in the project's main checkout instead, with the full transcript", async () => {
    mocks.move.mockResolvedValue({ stage: "delivered", launched: { sessionId: "work-1", tab: { id: "work-tab" } } });
    link(repo, true); await loaded("Link and Start");
    fireEvent.click(screen.getByRole("switch", { name: "Start on a new branch in a worktree" }));
    expect(screen.getByText("In its main checkout, shared with its other conversations")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Full session transcript/ }));
    fireEvent.click(screen.getByRole("button", { name: "Link and Start" }));
    await waitFor(() => expect(mocks.move).toHaveBeenCalled());
    expect(mocks.move.mock.calls[0][1]).toEqual({ projectPath: "/repos/web", worktree: false });
    expect(mocks.move.mock.calls[0][3]).toBe(continuationPrompt(chatContext, "full", "/repos/web"));
  });

  it("offers no worktree in a folder that is not a Git repository", async () => {
    link({ path: "/notes", name: "notes", kind: "folder" } as Project, false); await loaded("Link and Start");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("In the folder · no Git")).toBeTruthy();
  });

  it("offers no retry once the context has arrived, when only the archive failed", async () => {
    const launched = { sessionId: "work-1", tab: { id: "work-tab" } };
    mocks.move.mockImplementation(async (_chat, _to, _settings, _prompt, onCreated) => {
      onCreated(launched);
      return { stage: "archive", launched, error: "The new session started and has the chat's context. The chat could not be archived, so it is still in the list: read-only" };
    });
    const view = link(repo, true); await loaded("Link and Start");
    fireEvent.click(screen.getByRole("button", { name: "Link and Start" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/still in the list/);
    expect(screen.queryByRole("button", { name: /Start/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open New Session" }));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.move).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a failed start", async () => ({ stage: "launch", launched: { sessionId: "work-1", tab: { id: "work-tab" } }, error: "Could not start the new session: spawn failed The chat has not been archived." }), "Could not start the new session: spawn failed The chat has not been archived."],
    ["a thrown error", async () => { throw new Error("bridge gone"); }, "Error: bridge gone"],
  ])("still reports %s that arrives after the reader opened the new session", async (_case, outcome, reported) => {
    let finish!: () => void;
    mocks.move.mockImplementation(async (_chat, _to, _settings, _prompt, onCreated) => {
      onCreated({ sessionId: "work-1", tab: { id: "work-tab" } });
      await new Promise<void>((done) => { finish = done; });
      return outcome();
    });
    const onLateError = vi.fn();
    const onClose = vi.fn();
    render(<ContinuationDialog session={chat} source={chatTab} into={{ project: repo, worktree: true }} onClose={onClose} onLateError={onLateError} />);
    await loaded("Link and Start");
    fireEvent.click(screen.getByRole("button", { name: "Link and Start" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open New Session" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(onLateError).toHaveBeenCalledExactlyOnceWith(reported);
  });

  it("says when the new session could not start, and retries that session rather than creating another", async () => {
    const launched = { sessionId: "work-1", tab: { id: "work-tab" } };
    mocks.move.mockImplementationOnce(async (_chat, _to, _settings, _prompt, onCreated) => {
      onCreated(launched);
      return { stage: "launch", launched, error: "Could not start the new session: spawn failed The chat has not been archived." };
    });
    const view = link(repo, true); await loaded("Link and Start");
    fireEvent.click(screen.getByRole("button", { name: "Link and Start" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/The chat has not been archived/);
    expect(screen.getByTitle("Agent").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("switch", { name: "Start on a new branch in a worktree" }).hasAttribute("disabled")).toBe(true);
    mocks.move.mockResolvedValueOnce({ stage: "delivered", launched });
    fireEvent.click(screen.getByRole("button", { name: "Retry Start" }));
    await waitFor(() => expect(view.onClose).toHaveBeenCalled());
    expect(mocks.move).toHaveBeenCalledTimes(2);
    expect(mocks.move.mock.calls[1][5]).toEqual(launched);
    expect(mocks.move.mock.calls[1][3]).toBe(mocks.move.mock.calls[0][3]);
  });
});
