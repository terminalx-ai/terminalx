import { act, cleanup, fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRANCH_STATES, type BranchSnapshot, type BranchState } from "@/lib/branchStep";
import { runShortcut } from "@/lib/hotkeys";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
  mocks.listeners.set(name, callback);
  return () => { if (mocks.listeners.get(name) === callback) mocks.listeners.delete(name); };
}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
const { BranchGitButton } = await import("./BranchGitButton");
const render = (node: ReactNode) => renderView(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>);

const session = { id: "s1", cwd: "/repo", projectPath: "/repo", title: "Add feature", tabs: [{ id: "t1", status: "completed" }] } as SessionEntry;
function snapshot(state: BranchState = "ready", revision = 1): BranchSnapshot {
  const action = BRANCH_STATES[state].action;
  return { revision, sessionId: "s1", cwd: "/repo", branch: "feature", head: "abc", base: "main", mergeMethod: "squash", state,
    actions: action ? [action] : [], pr: { number: 7, url: "https://github.com/example/repo/pull/7", headSha: "abc", state: state === "merged" ? "MERGED" : "OPEN" }, behindUpstream: false };
}
let current: BranchSnapshot;
let approved: boolean;
let fail: string | null;
let accountFailure: string | null;
const calls = () => mocks.invoke.mock.calls.filter(([name]) => name === "branch_step_action");
const emit = (value: BranchSnapshot) => act(() => mocks.listeners.get("branch_step_changed")?.({ payload: value }));

beforeEach(() => {
  current = snapshot(); approved = false; fail = null; accountFailure = null;
  mocks.invoke.mockReset(); mocks.listeners.clear();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "pr_check_authority") return { owner: "fixture", epoch: 1 };
    if (command === "branch_step_refresh") return current;
    if (command === "branch_step_account") {
      if (accountFailure) throw new Error(accountFailure);
      return { login: "alice", destination: "git@github.com:example/repo.git", approved };
    }
    if (command === "branch_step_action") { approved = true; if (fail) throw new Error(fail); return "Completed"; }
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("header Git action", () => {
  it.each([
    ["noPr", "Create PR", "createPr"], ["agentWorking", "Agent working", null], ["uncommitted", "Commit and push", "commitPush"],
    ["behind", "Pull latest", "pull"], ["ahead", "Push", "push"], ["diverged", "Reconcile with upstream", "resolveConflicts"],
    ["conflicts", "Resolve conflicts", "resolveConflicts"], ["changesRequested", "Address review", "addressReview"], ["draft", "Mark ready", "markReady"],
    ["checksFailing", "Fix checks", "fixChecks"], ["checksPending", "Checks pending", null], ["reviewRequired", "Review required", null],
    ["ready", "Merge", "merge"],
  ] as const)("%s shows %s and runs its action", async (state, label, action) => {
    current = snapshot(state); approved = true;
    render(<BranchGitButton session={session} tabId="t1" />);
    const primary = await screen.findByRole("button", { name: label });
    expect(primary.hasAttribute("disabled")).toBe(!action);
    if (!action) { expect(calls()).toHaveLength(0); return; }
    fireEvent.click(primary);
    if (action === "commitPush" || action === "createPr") {
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByRole("textbox", { name: action === "commitPush" ? "Commit message" : "PR title" }), { target: { value: "Add feature" } });
      fireEvent.click(within(dialog).getByRole("button", { name: label }));
    }
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0][1]).toMatchObject({ sessionId: "s1", request: { action, expected: { branch: "feature", head: "abc" }, tabId: "t1" } });
  });

  it.each(["hidden", "merged"] as const)("hides %s when there is no next step", async (state) => {
    current = snapshot(state);
    render(<BranchGitButton session={session} tabId="t1" />);
    await act(async () => {});
    expect(screen.queryByTestId("branch-git-button")).toBeNull();
  });

  it("hides failed background reads without showing an alert", async () => {
    mocks.invoke.mockRejectedValue(new Error("Offline"));
    render(<BranchGitButton session={session} tabId="t1" />);
    await act(async () => {});
    expect(screen.queryByTestId("branch-git-button")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves disabled shortcuts and terminal copy unhandled", async () => {
    current = snapshot("noPr");
    render(<><BranchGitButton session={session} tabId="t1" /><textarea className="xterm" aria-label="terminal" /></>);
    await screen.findByRole("button", { name: "Create PR" });
    expect(fireEvent.keyDown(window, { key: "m", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(screen.getByLabelText("terminal"), { key: "c", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "branch_step_account")).toBe(false);
    expect(calls()).toHaveLength(0);
  });

  it("asks the agent to pull a dirty branch, tracking its progress", async () => {
    current = { ...snapshot("behind"), pullNeedsAgent: true };
    render(<BranchGitButton session={session} tabId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pull latest" }));
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Agent working" })).toBeTruthy();
  });

  it("asks before publishing, names the account, and cancel sends nothing", async () => {
    current = snapshot("ahead");
    render(<BranchGitButton session={session} tabId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Push" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("alice");
    expect(dialog.textContent).toContain("Allow publishing from this session");
    expect(calls()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Push" }));
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0][1]).toMatchObject({ request: { confirmedAccount: { login: "alice" } } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Push" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses an unidentified account and shows the error inline", async () => {
    current = snapshot("ahead"); accountFailure = "Could not verify the SSH account";
    render(<BranchGitButton session={session} tabId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Push" }));
    expect((await screen.findByRole("alert")).textContent).toContain(accountFailure);
    expect(calls()).toHaveLength(0);
  });

  it("refreshes after a failed push and preserves its inline failure", async () => {
    approved = true; current = snapshot("ahead"); fail = "Remote rejected this push";
    render(<BranchGitButton session={session} tabId="t1" />);
    await screen.findByRole("button", { name: "Push" });
    const reads = mocks.invoke.mock.calls.filter(([c]) => c === "branch_step_refresh").length;
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    expect((await screen.findByRole("alert")).textContent).toContain(fail);
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([c]) => c === "branch_step_refresh").length).toBeGreaterThan(reads));
  });

  it("displays progress and prevents duplicate requests", async () => {
    current = snapshot("behind");
    let finish!: (value: string) => void;
    mocks.invoke.mockImplementation((command: string) => command === "pr_check_authority" ? Promise.resolve({ owner: "fixture", epoch: 1 }) : command === "branch_step_refresh" ? Promise.resolve(current) : new Promise<string>((resolve) => { finish = resolve; }));
    render(<BranchGitButton session={session} tabId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pull latest" }));
    const progress = await screen.findByRole("button", { name: "Pulling latest…" });
    expect(progress.hasAttribute("disabled")).toBe(true);
    fireEvent.click(progress);
    act(() => runShortcut("git.pull"));
    expect(calls()).toHaveLength(1);
    await act(async () => finish("Pulled latest"));
    expect((await screen.findByRole("status")).textContent).toContain("Pulled latest");
  });

  it("updates within one refresh and ignores stale and other-session events", async () => {
    current = snapshot("checksPending");
    render(<BranchGitButton session={session} tabId="t1" />);
    await screen.findByRole("button", { name: "Checks pending" });
    emit(snapshot("ready", 3));
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    emit(snapshot("checksFailing", 2));
    emit({ ...snapshot("checksFailing", 4), sessionId: "another" });
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
  });

  it.each(["in_progress", "waiting"] as const)("trusts live idle status over a saved %s status", async (status) => {
    const saved = { ...session, tabs: session.tabs.map((tab) => ({ ...tab, status })) };
    render(<BranchGitButton session={saved} tabId="t1" />);
    expect((await screen.findByRole("button", { name: "Merge" })).hasAttribute("disabled")).toBe(false);
  });

  it("disables on a new working status until the next live snapshot", async () => {
    const view = render(<BranchGitButton session={session} tabId="t1" />);
    await screen.findByRole("button", { name: "Merge" });
    current = snapshot("agentWorking", 2);
    const working = { ...session, tabs: session.tabs.map((tab) => ({ ...tab, status: "in_progress" as const })) };
    view.rerender(<TooltipProvider delayDuration={0}><BranchGitButton session={working} tabId="t1" /></TooltipProvider>);
    expect(screen.getByRole("button", { name: "Agent working" }).hasAttribute("disabled")).toBe(true);
    emit(snapshot("ready", 3));
    expect(screen.getByRole("button", { name: "Merge" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows an agent failure inline and refreshes when its turn finishes", async () => {
    current = snapshot("checksFailing");
    render(<BranchGitButton session={session} tabId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Fix checks" }));
    await waitFor(() => expect(calls()).toHaveLength(1));
    act(() => mocks.listeners.get("agent_event")?.({ payload: { sessionId: "s1", tabId: "t1", payload: { type: "turn_started" } } }));
    await screen.findByRole("button", { name: "Agent working" });
    act(() => mocks.listeners.get("agent_event")?.({ payload: { sessionId: "s1", tabId: "t1", payload: { type: "turn_completed", status: "error", detail: "Agent lost its connection" } } }));
    expect((await screen.findByRole("alert")).textContent).toContain("Agent lost its connection");
  });

  it("routes keyboard actions through the same confirmation and respects modal dialogs", async () => {
    current = snapshot("ready");
    render(<BranchGitButton session={session} tabId="t1" />);
    await screen.findByRole("button", { name: "Merge" });
    act(() => runShortcut("git.merge"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("main using squash");
    act(() => runShortcut("git.merge"));
    expect(calls()).toHaveLength(0);
  });

  it("releases agent progress after a fresh idle snapshot when the completion event was lost", async () => {
    current = snapshot("checksFailing");
    render(<BranchGitButton session={session} tabId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Fix checks" }));
    await screen.findByRole("button", { name: "Agent working" });
    emit(snapshot("uncommitted", 2));
    expect((await screen.findByRole("button", { name: "Commit and push" })).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Agent is idle");
  });

  it("does not continue account preparation after leaving the session", async () => {
    current = snapshot("ahead");
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((command: string) => command === "pr_check_authority" ? Promise.resolve({ owner: "fixture", epoch: 1 }) : command === "branch_step_refresh" ? Promise.resolve(current) : new Promise((resolve) => { finish = resolve; }));
    const view = render(<BranchGitButton session={session} tabId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Push" }));
    await waitFor(() => expect(finish).toBeDefined());
    view.unmount();
    await act(async () => finish({ login: "alice", destination: "origin", approved: true }));
    expect(calls()).toHaveLength(0);
  });
});


it("keeps the click authority through a delayed account answer and does only local reconciliation", async () => {
  let answer!: (value: unknown) => void;
  let epoch = 1;
  mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === "pr_check_authority") return Promise.resolve({ owner: "fixture", epoch });
    if (command === "branch_step_refresh") return Promise.resolve(current);
    if (command === "branch_step_account") return new Promise((resolve) => { answer = resolve; });
    if (command === "branch_step_action") {
      expect(args.authority).toEqual({ owner: "fixture", epoch: 1 });
      return Promise.reject(new Error("Turned off by data privacy mode"));
    }
    throw new Error(command);
  });
  render(<BranchGitButton session={session} tabId="t1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  await waitFor(() => expect(answer).toBeDefined());
  // The native owner's acknowledged on/off cycle permanently expires epoch1.
  epoch = 2;
  const before = mocks.invoke.mock.calls.length;
  await act(async () => answer({ login: "alice", destination: "git@github.com:example/repo.git", approved: true }));
  await waitFor(() => expect(calls()).toHaveLength(1));
  expect(mocks.invoke.mock.calls.slice(before).filter(([name]) => name === "branch_step_refresh").every(([, args]) => args.mode === "local")).toBe(true);
  expect(mocks.invoke.mock.calls.filter(([name]) => name === "pr_check_authority")).toHaveLength(1);
  expect(await screen.findByText("Turned off by data privacy mode")).toBeTruthy();
});
