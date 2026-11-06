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
    copied: [], skipped: [{ path: ".env", reason: "Tracked in the new workspace" }, { path: "config/local/app", reason: "Already exists" }], error: "Could not copy some files",
  } } };
  act(() => { mock.listener?.({ payload }); mock.listener?.({ payload }); });
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByText(".env: Tracked in the new workspace")).toBeTruthy();
  expect(screen.getByText("config/local/app: Already exists")).toBeTruthy();
  expect(screen.getByText("Could not copy some files")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss file copy notice for feature" }));
  expect(screen.queryByRole("status")).toBeNull();
  act(() => mock.listener?.({ payload: { ...payload, worktreeBase: { ...payload.worktreeBase, fileCopy: { copied: [".env"], skipped: [], error: null } } } }));
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => view.unmount());
  expect(mock.unlisten).toHaveBeenCalled();
});
