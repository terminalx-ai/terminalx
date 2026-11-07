import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import type { IssuePipeline } from "@/types/issuePipeline";

const { openCloudSession } = vi.hoisted(() => ({ openCloudSession: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
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
const { useNoticeDeferral } = await import("@/lib/noticeDeferral");
const { Dialog, DialogContent, DialogTitle } = await import("./dialog");

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
