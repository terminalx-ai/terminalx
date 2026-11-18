import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { ArchiveNotices } = await import("./ArchiveNotices");
const { ARCHIVE_UNDO_MS, archiveWithUndo, dismissArchiveNotice, getArchiveNotices } = await import("@/lib/archiveNotices");
const sessions = await import("@/lib/sessions");

const session: SessionEntry = {
  id: "s1", projectPath: "/repos/lab", cwd: "/repos/lab/.raccoon/worktrees/slugify", title: "Make slugify handle punctuation", created: "", modified: "", pinned: false, archived: false,
  worktreeRemoved: false, activeTab: null, tabs: [],
} as unknown as SessionEntry;

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  sessions.upsertSession({ ...session });
});
afterEach(() => {
  cleanup();
  for (const notice of getArchiveNotices()) dismissArchiveNotice(notice.id);
  vi.useRealTimers();
});

it("says what was archived and puts it back with Restore (02.23)", async () => {
  render(<ArchiveNotices />);
  await act(() => archiveWithUndo("s1"));
  expect(mocks.invoke).toHaveBeenCalledWith("set_session_archived", { sessionId: "s1", archived: true });
  const notice = screen.getByTestId("archive-notice");
  expect(notice.textContent).toContain("Archived Make slugify handle punctuation");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Restore" })));
  expect(mocks.invoke).toHaveBeenCalledWith("set_session_archived", { sessionId: "s1", archived: false });
  await waitFor(() => expect(screen.queryByTestId("archive-notice")).toBeNull());
  expect(sessions.getSessions().sessions.find((entry) => entry.id === "s1")?.archived).toBe(false);
});

it("keeps the notice and says why when Restore fails", async () => {
  render(<ArchiveNotices />);
  await act(() => archiveWithUndo("s1"));
  mocks.invoke.mockRejectedValueOnce(new Error("session not found"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Restore" })));
  expect((await screen.findByRole("alert")).textContent).toContain("session not found");
});

it("goes by itself after a while, and at once when the session comes back some other way", async () => {
  vi.useFakeTimers();
  render(<ArchiveNotices />);
  await act(() => archiveWithUndo("s1"));
  expect(screen.getByTestId("archive-notice")).toBeTruthy();
  act(() => sessions.patchSession("s1", { archived: false }));
  expect(screen.queryByTestId("archive-notice")).toBeNull();
  await act(() => archiveWithUndo("s1"));
  expect(screen.getByTestId("archive-notice")).toBeTruthy();
  act(() => vi.advanceTimersByTime(ARCHIVE_UNDO_MS));
  expect(screen.queryByTestId("archive-notice")).toBeNull();
});
