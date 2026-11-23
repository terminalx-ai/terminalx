// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileTreeView } from "@/components/files/FileTreeView";
import { QuickOpen } from "./QuickOpen";
import { closeAllEditors, getEditors, setPaneCollapsed } from "@/lib/editors";

const mocks = vi.hoisted(() => ({ hotkeys: new Map<string, () => void>(), name: "" }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fs: { listDir: async () => [{ path: mocks.name, name: mocks.name, isDir: false }], mtime: async () => 1 },
  files: { search: async () => [{ path: mocks.name, name: mocks.name }], count: async () => ({ files: 1, truncated: false }) },
  api: { reviewRange: async () => { throw new Error("Not a Git repository"); } },
}));
vi.mock("@/lib/changes", () => ({ useWorkingChanges: () => ({ files: [], loading: false, head: null }) }));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: vi.fn(), useShortcutKeys: () => [], useShortcut: (action: string, cb: () => void, opts?: { enabled?: boolean }) => { if (opts?.enabled !== false) mocks.hotkeys.set(action, cb); } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => {
  cleanup();
  // Unmounting the Quick Open dialog or the context menu leaves Radix's focus scope a 0 ms timer that
  // dispatches its unmount event. Let it run while jsdom is still here: when it fired after the file's
  // environment was torn down, it threw "parameter 1 is not of type 'Event'" (#1298, vitest shard 1).
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await closeAllEditors("opening");
});

it.each([["透明 image.png", "image"], ["sound.mp3", "audio"], ["clip.mp4", "video"]])("Explorer click, Open, and Quick Open reuse the same %s viewer", async (name, kind) => {
  mocks.name = name;
  render(<><FileTreeView sessionId="opening" root="/workspace" rootName="Workspace" active /><QuickOpen sessionId="opening" root="/workspace" /></>);
  fireEvent.click(await screen.findByText(name));
  const entry = getEditors().editors[0];
  expect(entry).toMatchObject({ kind, rel: name, dirty: false });
  act(() => setPaneCollapsed("opening", true));
  fireEvent.contextMenu(screen.getByText(name));
  fireEvent.click(await screen.findByRole("menuitem", { name: "View" }));
  expect(getEditors().collapsed.opening).toBe(false);
  act(() => mocks.hotkeys.get("files.quickOpen")!());
  // The row's name is the file's, then its folder and marks.
  await screen.findByRole("option", { name: (accessible) => accessible.startsWith(name) });
  fireEvent.keyDown(screen.getByPlaceholderText("Search files…"), { key: "Enter" });
  expect(getEditors().editors).toHaveLength(1);
  expect(getEditors().active.opening).toBe(entry.id);
});
