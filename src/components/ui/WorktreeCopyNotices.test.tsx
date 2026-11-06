import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import { WorktreeCopyNotices } from "./WorktreeCopyNotices";

const mock = vi.hoisted(() => ({ listener: undefined as undefined | ((event: { payload: Partial<SessionEntry> }) => void), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name, listener) => { mock.listener = listener; return mock.unlisten; }) }));
afterEach(cleanup);
it("lists skipped files and errors, deduplicates creation events, and dismisses the notice", async () => {
  const view = render(<WorktreeCopyNotices />);
  const payload = { id: "session", worktreeName: "feature", worktreeBase: { commit: "abc", fetched: false, warning: null, fileCopy: {
    copiedCount: 0, copiedBytes: 0, skippedCount: 2, warnings: [], skipped: [{ path: ".env", reason: "Tracked in the new workspace" }, { path: "config/local/app", reason: "Already exists" }], error: "Could not copy some files",
  } } };
  act(() => { mock.listener?.({ payload }); mock.listener?.({ payload }); });
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByText(".env: Tracked in the new workspace")).toBeTruthy();
  expect(screen.getByText("config/local/app: Already exists")).toBeTruthy();
  expect(screen.getByText("Could not copy some files")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss file copy notice for feature" }));
  expect(screen.queryByRole("status")).toBeNull();
  act(() => mock.listener?.({ payload: { ...payload, worktreeBase: { ...payload.worktreeBase, fileCopy: { copiedCount: 1, copiedBytes: 10, skippedCount: 0, warnings: [], skipped: [], error: null } } } }));
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => view.unmount());
  expect(mock.unlisten).toHaveBeenCalled();
});

it("shows omitted skip counts and distinguishes cleanup warnings for copied files", () => {
  render(<WorktreeCopyNotices />);
  act(() => mock.listener?.({ payload: { id: "limited", title: "limited", worktreeBase: { commit: "abc", fetched: false, warning: null, fileCopy: {
    copiedCount: 1, copiedBytes: 10, skippedCount: 101, skipped: [{ path: ".env.extra", reason: "Copy limit" }],
    warnings: [{ path: ".env", reason: "Copied, but could not remove temporary file" }], error: null,
  } } } }));
  expect(screen.getByText("100 additional files skipped.")).toBeTruthy();
  expect(screen.getByRole("list", { name: "Copied with warnings" }).textContent).toContain(".env: Copied, but");
});

it("shows a cleanup warning even when no files were skipped", () => {
  render(<WorktreeCopyNotices />);
  act(() => mock.listener?.({ payload: { id: "warning", title: "warning", worktreeBase: { commit: "abc", fetched: false, warning: null, fileCopy: {
    copiedCount: 1, copiedBytes: 10, skippedCount: 0, skipped: [],
    warnings: [{ path: ".env", reason: "Copied, but could not remove temporary file" }], error: null,
  } } } }));
  expect(screen.getByRole("status")).toBeTruthy();
});
