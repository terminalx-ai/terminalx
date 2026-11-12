import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import type { IssuePipeline } from "@/types/issuePipeline";

const { openCloudSession } = vi.hoisted(() => ({ openCloudSession: vi.fn() }));
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => []) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("@/lib/cloudDashboard", async (original) => ({
  ...(await original<typeof import("@/lib/cloudDashboard")>()),
  openCloudSession,
}));

const { Toasts } = await import("./Toasts");
const { dismissNotice, notePipelineState, noteSessionStarted, noteStatusChange, useNotices } = await import("@/lib/notify");
const { getSessionStore, openIssues, upsertSession } = await import("@/lib/sessions");
const { NoticeForeground, useNoticeDeferral } = await import("@/lib/noticeDeferral");
const { Dialog, DialogContent, DialogTitle } = await import("./dialog");
const { dismissError, getErrorToasts, showError } = await import("@/lib/errorToasts");

const session: SessionEntry = {
  id: "started-session", projectPath: "/repo", cwd: "/repo/worktree", title: "#785 Stay on Issues",
  worktreeRemoved: false, created: "", modified: "", archived: false, pinned: false,
  tabs: [{ id: "started-tab", harness: "codex", model: "", permissionMode: "auto", status: "in_progress", created: "", modified: "" }],
};

beforeEach(() => {
  vi.useFakeTimers();
  upsertSession(session);
  openIssues();
  window.dispatchEvent(new Event("focus"));
  openCloudSession.mockClear();
});

afterEach(() => {
  cleanup(); // Release any decision before clearing its retained notices.
  const { result } = renderHook(useNotices);
  act(() => result.current.forEach((notice) => dismissNotice(notice.id)));
  act(() => getErrorToasts().forEach((toast) => dismissError(toast.id)));
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["approval-first", "notification-first"])("retains stacked and repeated attention until the dialog closes (%s)", (order) => {
  const notify = () => noteStatusChange(session, session.tabs[0], "in_progress", "waiting");
  render(<Toasts />);
  if (order === "notification-first") {
    act(notify);
    expect(screen.getByRole("status").textContent).toContain("needs attention");
    act(() => vi.advanceTimersByTime(7000));
  }
  const approval = (open: boolean) => <Dialog open={open}><DialogContent aria-describedby={undefined}>
    <DialogTitle>Approve command</DialogTitle><button>Allow command</button><button>Deny command</button>
  </DialogContent></Dialog>;
  const dialog = render(approval(true));
  const allow = screen.getByRole("button", { name: "Allow command" });
  allow.focus();
  act(() => {
    notify();
    noteStatusChange({ ...session, id: "another-session" }, session.tabs[0], "in_progress", "waiting");
    vi.advanceTimersByTime(20_000);
    notify();
  });
  expect(screen.queryByRole("status")).toBeNull();
  expect(document.activeElement).toBe(allow);
  expect(getSessionStore().view).toBe("issues");
  dialog.rerender(approval(false));
  expect(screen.getAllByRole("status")).toHaveLength(2);
  act(() => vi.advanceTimersByTime(7999));
  expect(screen.getAllByRole("status")).toHaveLength(2);
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole("status")).toBeNull();
});

it("waits for the last decision, ignores inactive decisions, and keeps retained notices actionable", () => {
  render(<Toasts />);
  const first = renderHook(({ active }) => useNoticeDeferral(active), { initialProps: { active: false } });
  act(() => noteSessionStarted(session.id, "started-tab", "codex", "Started while browsing"));
  expect(screen.getByRole("status")).toBeTruthy();
  first.rerender({ active: true });
  const second = renderHook(() => useNoticeDeferral(true));
  act(() => vi.advanceTimersByTime(30_000));
  first.unmount();
  expect(screen.queryByRole("status")).toBeNull();
  second.unmount();
  fireEvent.click(screen.getByRole("status"));
  expect(getSessionStore().selectedSessionId).toBe(session.id);
  expect(screen.queryByRole("status")).toBeNull();
});

function PendingDecision({ active = true }: { active?: boolean }) {
  useNoticeDeferral(active);
  return null;
}

it("only defers for the foreground view and restores protection when a covering view leaves", () => {
  const layout = (guest: boolean, pending = false) => <>
    <Toasts /><PendingDecision />
    {guest && <NoticeForeground><PendingDecision active={pending} /></NoticeForeground>}
  </>;
  const view = render(layout(false));
  act(() => noteStatusChange(session, session.tabs[0], "in_progress", "waiting"));
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(layout(true));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  act(() => noteSessionStarted("second-session", "second-tab", "codex", "Started behind the guest"));
  expect(screen.getAllByRole("status")).toHaveLength(2);
  view.rerender(layout(true, true));
  act(() => vi.advanceTimersByTime(20_000));
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(layout(true));
  expect(screen.getAllByRole("status")).toHaveLength(2);
  view.rerender(layout(false));
  expect(screen.queryByRole("status")).toBeNull();
});

it("keeps a modal protected above a covering view, including a portal from the covered workspace", () => {
  const layout = (guest: boolean, dialog: boolean) => <>
    <Toasts /><PendingDecision />
    <Dialog open={dialog}><DialogContent aria-describedby={undefined}><DialogTitle>Approval</DialogTitle></DialogContent></Dialog>
    {guest && <NoticeForeground>{null}</NoticeForeground>}
  </>;
  const view = render(layout(false, true));
  act(() => noteStatusChange(session, session.tabs[0], "in_progress", "waiting"));
  view.rerender(layout(true, true));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(layout(true, false));
  expect(screen.getByRole("status")).toBeTruthy();
});

it("stacks starts, opens a session on click, and dismisses another without navigating", () => {
  render(<Toasts />);
  act(() => {
    noteSessionStarted(session.id, "started-tab", "codex", "#785 Stay on Issues");
    noteSessionStarted("second-session", "second-tab", "claude", "DEMO-42 Fix the next issue");
  });
  const notices = screen.getAllByRole("status");
  expect(notices).toHaveLength(2);
  expect(notices[0].textContent).toBe("Session started#785 Stay on Issues");
  expect(within(notices[0]).getByLabelText("Codex")).toBeTruthy();
  expect(within(notices[1]).getByLabelText("Claude")).toBeTruthy();
  expect(getSessionStore().view).toBe("issues");

  fireEvent.click(within(notices[1]).getByRole("button", { name: "Dismiss" }));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(getSessionStore().view).toBe("issues");
  fireEvent.click(notices[0]);
  expect(getSessionStore().selectedSessionId).toBe(session.id);
  expect(getSessionStore().view).toBe("welcome");
  expect(screen.queryByRole("status")).toBeNull();
});

it("opens a cloud session on its started tab and removes the notice", () => {
  render(<Toasts />);
  act(() => noteSessionStarted("cloud:org:workspace:session", "cloud-tab", "claude", "ENG-42 Fix cloud work"));
  expect(within(screen.getByRole("status")).getByLabelText("Claude")).toBeTruthy();
  fireEvent.click(screen.getByRole("status"));
  expect(openCloudSession).toHaveBeenCalledWith("cloud:org:workspace:session", "cloud-tab");
  expect(screen.queryByRole("status")).toBeNull();
});

it("expires a started notice after eight seconds", () => {
  render(<Toasts />);
  act(() => noteSessionStarted(session.id, "started-tab", "codex", "#785 Stay on Issues"));
  act(() => vi.advanceTimersByTime(7999));
  expect(screen.getByText("Session started")).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole("status")).toBeNull();
});

it("replaces a start with completion and gives the completion its own eight seconds", () => {
  render(<Toasts />);
  act(() => noteSessionStarted(session.id, "started-tab", "codex", "#785 Stay on Issues"));
  act(() => vi.advanceTimersByTime(1000));
  act(() => noteStatusChange(session, session.tabs[0], "in_progress", "completed"));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.queryByText("Session started")).toBeNull();
  act(() => vi.advanceTimersByTime(7000));
  expect(screen.getByRole("status").textContent).toContain("finished");
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("status")).toBeNull();
});

it("replaces a start when its issue pipeline needs the reader", () => {
  render(<Toasts />);
  act(() => noteSessionStarted(session.id, "started-tab", "codex", "#785 Stay on Issues"));
  act(() => notePipelineState({
    id: "pipeline", state: "needsYou", issue: { identifier: "#785", title: "Stay on Issues" },
    author: { sessionId: session.id, tabId: "started-tab" }, note: "Review the findings.",
  } as IssuePipeline));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("status").textContent).toContain("#785 needs you");
  expect(screen.queryByText("Session started")).toBeNull();
});

it("keeps an error until it is closed, stacked under the notices, and copies its whole text", async () => {
  render(<Toasts />);
  act(() => {
    noteSessionStarted(session.id, "started-tab", "codex", "#785 Stay on Issues");
    showError("Couldn't move “Notarize release builds” to Release", new Error("database is locked (SQLITE_BUSY)"));
    showError("Couldn't pin “web”", "locked");
  });
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.queryByRole("status")).toBeNull();
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(2);
  expect(alerts[0].textContent).toContain("Something went wrong");
  expect(alerts[0].textContent).toContain("Couldn't move “Notarize release builds” to Release: database is locked (SQLITE_BUSY)");
  expect(within(alerts[0]).getByText("database is locked (SQLITE_BUSY)").className).toContain("font-mono");

  invoke.mockClear();
  await act(async () => fireEvent.click(within(alerts[0]).getByRole("button", { name: "Copy error" })));
  expect(invoke).toHaveBeenCalledWith("copy_text", { text: "Couldn't move “Notarize release builds” to Release: database is locked (SQLITE_BUSY)" });
  expect(within(alerts[0]).getByRole("button", { name: "Copied" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(2000));
  expect(within(alerts[0]).getByRole("button", { name: "Copy error" })).toBeTruthy();
  expect(screen.getAllByRole("alert")).toHaveLength(2);
});

it("says when the copy failed", async () => {
  render(<Toasts />);
  act(() => { showError("Couldn't pin “web”", "locked"); });
  invoke.mockRejectedValueOnce(new Error("no clipboard"));
  const writeText = vi.fn(async () => { throw new Error("denied"); });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy error" })));
  expect(screen.getByRole("button", { name: "Couldn't copy" })).toBeTruthy();
});

it("closes an error by its button or by Escape, and counts a repeat instead of stacking it", () => {
  render(<Toasts />);
  act(() => {
    showError("Couldn't pin “web”", "locked");
    showError("Couldn't archive “web”", "locked");
    showError("Couldn't pin “web”", "locked");
  });
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(2);
  expect(within(alerts[1]).getByLabelText("2 times")).toBeTruthy();
  const close = within(alerts[1]).getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "Escape" });
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows a failure's own heading, its body apart, and its actions beside Copy error (PRO-291)", async () => {
  vi.useRealTimers();
  const retry = vi.fn(async () => true);
  const open = vi.fn(async () => undefined);
  render(<Toasts />);
  act(() => {
    showError("", "~/.claude/settings.json line 14: Unexpected token }", {
      title: "Couldn't open a new Claude Code tab: claude exited while starting",
      actions: [{ label: "Try again", icon: "retry", run: retry }, { label: "Open settings.json", keepOpen: true, run: open }],
    });
  });
  const alert = screen.getByRole("alert");
  expect(within(alert).getByText("Couldn't open a new Claude Code tab: claude exited while starting")).toBeTruthy();
  expect(alert.textContent).not.toContain("Something went wrong");
  expect(within(alert).getByText("~/.claude/settings.json line 14: Unexpected token }").className).toContain("font-mono");
  expect(within(alert).getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again", "Open settings.json", "Copy error", ""]);

  await act(async () => fireEvent.click(within(alert).getByRole("button", { name: "Open settings.json" })));
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toBeTruthy();
  await act(async () => fireEvent.click(within(alert).getByRole("button", { name: "Try again" })));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});
