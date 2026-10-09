import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, TabStatus, WorkspaceDisposition } from "@/types/session";
import type { SessionBackend } from "@/lib/sessionBackend";
import type { Transcript } from "@/lib/transcript";

// #411: once the worktree's pull request has merged, the chat offers Delete workspace next to Commit, Create PR and Run it.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), changed: { files: [] as unknown[] }, views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/quickChats", () => ({ useSessionIsGit: () => true }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => mocks.changed }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => false, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), leaveTerminalView: vi.fn(),
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
// The transcript is not under test; the real composer in its footer is.
vi.mock("@/components/chat/Chat", () => ({ Chat: ({ footer }: { footer: React.ReactNode }) => <div>{footer}</div> }));
vi.mock("@/components/chat/Dictation", () => ({ DictationStatus: () => null, MicButton: () => null, useDictationInto: () => ({ dictating: false, toggle: vi.fn() }), useDictationShortcuts: vi.fn() }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: () => null }));

import { TabView, handoffsFor } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { closeWorkspaceRemove, useDialogs } from "@/lib/dialogs";
import { upsertSession } from "@/lib/sessions";
import { canDeleteMergedWorkspace, localRemovableWorkspace, offersWorkspaceDelete, type RemovableWorkspace, type WorkspaceHost } from "@/lib/workspaceRemoval";

const projectPath = "/repos/app";
const worktree = "/repos/app/.raccoon/worktrees/quiet-amber-fox";
const merged: WorkspaceDisposition = {
  exists: true,
  checked: true,
  isMain: false,
  branch: "raccoon/quiet-amber-fox",
  uncommitted: 0,
  unpushed: 0,
  aheadOfBase: 0,
  pr: { number: 62, title: "Fix login", url: "https://example.test/pull/62", state: "MERGED", isDraft: false },
  prChecked: true,
  sessions: 1,
  sessionTitles: ["Fix login"],
  sessionIds: ["s1"],
};
const pr = (state: string) => ({ ...merged, pr: { ...merged.pr!, state } });

let seq = 0;
const tab = (status: TabStatus = "idle") => ({ id: `tab${++seq}`, harness: "claude", model: "default", permissionMode: "default", status, created: "", modified: "" });
const sessionAt = (cwd: string, status: TabStatus = "idle", id = "s1"): SessionEntry => ({
  id, projectPath, cwd, title: "Fix login", created: "", modified: "", archived: false, pinned: false,
  worktreeName: cwd === projectPath ? null : "quiet-amber-fox", worktreeRemoved: false, tabs: [tab(status)],
});

/** A worktree on a host that answers `read`; `running` are the sessions with a turn in progress elsewhere in this window. */
function fakeWorkspace(read: () => Promise<WorkspaceDisposition>, running: string[] = []): RemovableWorkspace & { host: WorkspaceHost & { disposition: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } } {
  return {
    projectPath,
    path: worktree,
    name: "quiet-amber-fox",
    host: {
      key: `fake:${worktree}`,
      disposition: vi.fn(read),
      remove: vi.fn(async () => ({})),
      turnRunning: (ids) => ids.some((id) => running.includes(id)),
    },
  };
}

/** The app's dialogs, as the removal dialog reads them. */
let dialogs: ReturnType<typeof useDialogs>;
function Dialogs() {
  dialogs = useDialogs();
  return null;
}
const getDialogs = () => dialogs;

const show = (session: SessionEntry, workspace?: RemovableWorkspace, props: { active?: boolean; backend?: SessionBackend } = {}) =>
  render(<TooltipProvider><Dialogs /><TabView session={session} tab={session.tabs[0]} active={props.active ?? true} backend={props.backend} workspace={workspace} /></TooltipProvider>);
const deleteButton = () => screen.queryByRole("button", { name: "Delete workspace" });
/** Let the worktree's read land. */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  mocks.changed = { files: [] };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "workspace_disposition") return merged;
    if (["load_tab_events", "list_models", "list_workspaces", "list_slash_commands", "search_files"].includes(command)) return [];
    return null;
  });
});

afterEach(() => {
  cleanup();
  act(() => closeWorkspaceRemove());
  vi.useRealTimers();
});

describe("the chat's Delete workspace action", () => {
  it("shows for a local worktree whose pull request has merged, without a turn, and only opens the removal dialog", async () => {
    const session = sessionAt(worktree);
    show(session, localRemovableWorkspace(session));

    fireEvent.click(await screen.findByRole("button", { name: "Delete workspace" }));

    // The quick read, on this computer: no fetch, as the PR panel's.
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_disposition", { projectPath, path: worktree, fetch: false });
    expect(getDialogs().workspaceRemove).toMatchObject({ projectPath, path: worktree, name: "quiet-amber-fox", mode: "delete" });
    // Nothing is removed from the chat, and nothing is asked of the agent.
    expect(mocks.invoke.mock.calls.some(([command]) => command === "remove_workspace" || command === "send_message")).toBe(false);
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("sits alongside Commit, Create PR and Run it after a turn that changed files", () => {
    const done = { turns: [{ completed: { status: "ok" } }] } as unknown as Transcript;
    const run = vi.fn();
    expect(handoffsFor(done, true)?.map((step) => step.label)).toEqual(["Commit", "Create PR", "Run it"]);
    expect(handoffsFor(done, true, run)?.map((step) => step.label)).toEqual(["Commit", "Create PR", "Run it", "Delete workspace"]);
    // The others are prompts for the composer; this one is the app's action.
    expect(handoffsFor(done, true, run)?.at(-1)).toEqual({ label: "Delete workspace", run });
    // It needs neither a finished turn nor changes.
    expect(handoffsFor({ turns: [] } as unknown as Transcript, false, run)).toEqual([{ label: "Delete workspace", run }]);
    expect(handoffsFor(done, false)).toBeUndefined();
  });

  it("is absent for a session in the project's main directory, which is never read as a worktree", async () => {
    const session = sessionAt(projectPath);
    expect(localRemovableWorkspace(session)).toBeUndefined();
    show(session, localRemovableWorkspace(session));
    await settle();

    expect(deleteButton()).toBeNull();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "workspace_disposition")).toBe(false);
    // A worktree that is already removed is none either.
    expect(localRemovableWorkspace({ ...sessionAt(worktree), worktreeRemoved: true })).toBeUndefined();
  });

  it.each<[string, WorkspaceDisposition]>([
    ["the pull request is still open", pr("OPEN")],
    ["the pull request was closed without merging", pr("CLOSED")],
    ["there is no pull request", { ...merged, pr: null }],
    ["the pull request's state could not be checked", { ...merged, pr: null, prChecked: false }],
    ["the workspace has uncommitted changes", { ...merged, uncommitted: 2 }],
    ["the workspace has commits that are not on the remote", { ...merged, unpushed: 1 }],
    ["the workspace is the main directory after all", { ...merged, isMain: true }],
    ["the workspace is already removed", { ...merged, exists: false }],
  ])("is absent when %s", async (_case, disposition) => {
    const workspace = fakeWorkspace(async () => disposition);
    show(sessionAt(worktree), workspace);
    await settle();

    expect(workspace.host.disposition).toHaveBeenCalled();
    expect(deleteButton()).toBeNull();
    expect(canDeleteMergedWorkspace(disposition)).toBe(false);
  });

  it("is absent when the workspace could not be read", async () => {
    const workspace = fakeWorkspace(async () => { throw new Error("Unable to verify workspace"); });
    show(sessionAt(worktree), workspace);
    await settle();

    expect(workspace.host.disposition).toHaveBeenCalled();
    expect(deleteButton()).toBeNull();
  });

  it.each<TabStatus>(["in_progress", "waiting"])("is absent while a turn is %s in the session, and the worktree is not read meanwhile", async (status) => {
    const workspace = fakeWorkspace(async () => merged);
    show(sessionAt(worktree, status), workspace);
    await settle();

    expect(deleteButton()).toBeNull();
    expect(workspace.host.disposition).not.toHaveBeenCalled();
    expect(offersWorkspaceDelete(merged, true)).toBe(false);
  });

  it("is absent while another session in the same worktree has a turn running", async () => {
    // The real local host: it looks the worktree's other sessions up in the session list.
    const session = sessionAt(worktree);
    act(() => upsertSession(sessionAt(worktree, "in_progress", "s9")));
    mocks.invoke.mockImplementation(async (command: string) => (command === "workspace_disposition" ? { ...merged, sessions: 2, sessionIds: ["s1", "s9"] } : []));
    show(session, localRemovableWorkspace(session));
    await settle();
    expect(deleteButton()).toBeNull();

    cleanup();
    act(() => upsertSession(sessionAt(worktree, "idle", "s9")));
    show(session, localRemovableWorkspace(session));
    expect(await screen.findByRole("button", { name: "Delete workspace" })).toBeTruthy();
  });

  it("appears when a merge made elsewhere is picked up, without a new turn", async () => {
    vi.useFakeTimers();
    let now: WorkspaceDisposition = pr("OPEN");
    const workspace = fakeWorkspace(async () => now);
    show(sessionAt(worktree), workspace);
    await settle();
    expect(deleteButton()).toBeNull();

    now = merged;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(deleteButton()).not.toBeNull();

    // And goes again if the worktree stops being clean.
    now = { ...merged, uncommitted: 1 };
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(deleteButton()).toBeNull();
  });

  it("is not read or shown for a tab that is not in front", async () => {
    const workspace = fakeWorkspace(async () => merged);
    show(sessionAt(worktree), workspace, { active: false });
    await settle();

    expect(workspace.host.disposition).not.toHaveBeenCalled();
    expect(deleteButton()).toBeNull();
  });

  it("works for a cloud session: the worktree is read and removed on the host that owns it", async () => {
    const workspace = fakeWorkspace(async () => merged);
    const backend = {
      kind: "cloud", key: "cloud:org-1:ws-1:s1", generation: "g1", logSessionId: "s1", readOnlyReason: null,
      caps: { local: false, write: true, steer: true, images: false, recovery: false },
      openTab: () => undefined, markRead: async () => undefined, patchTab: () => undefined, setTabStatus: () => undefined,
    } as unknown as SessionBackend;
    // A cloud session's entry never names its worktree; its runtime does, through the host.
    show({ ...sessionAt("cloud:org-1:ws-1"), worktreeName: null }, workspace, { backend });

    fireEvent.click(await screen.findByRole("button", { name: "Delete workspace" }));

    expect(getDialogs().workspaceRemove).toMatchObject({ mode: "delete", name: "quiet-amber-fox", host: workspace.host });
    expect(workspace.host.remove).not.toHaveBeenCalled();
    // Never a local command against a path that only exists on the VM.
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "workspace_disposition" || command === "remove_workspace")).toBe(false));
  });
});
