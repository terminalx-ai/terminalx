// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileTreeView } from "@/components/files/FileTreeView";
import { QuickOpen } from "./QuickOpen";
import { closeAllEditors, getEditors, setPaneCollapsed } from "@/lib/editors";

const mocks = vi.hoisted(() => ({ hotkeys: new Map<string, () => void>(), name: "" }));
vi.mock("@/lib/api", () => ({
  fs: { listDir: async () => [{ path: mocks.name, name: mocks.name, isDir: false }] },
  files: { search: async () => [{ path: mocks.name, name: mocks.name }] },
}));
vi.mock("@/lib/changes", () => ({ useWorkingChanges: () => ({ files: [], loading: false, head: null }) }));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: (key: string, cb: () => void) => { mocks.hotkeys.set(key, cb); } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => { cleanup(); await closeAllEditors("opening"); });

it.each([["透明 image.png", "image"], ["sound.mp3", "audio"], ["clip.mp4", "video"]])("Explorer click, Open, and Quick Open reuse the same %s viewer", async (name, kind) => {
  mocks.name = name;
  render(<><FileTreeView sessionId="opening" root="/workspace" rootName="Workspace" active /><QuickOpen sessionId="opening" root="/workspace" /></>);
  fireEvent.click(await screen.findByText(name));
  const entry = getEditors().editors[0];
  expect(entry).toMatchObject({ kind, rel: name, dirty: false });
  act(() => setPaneCollapsed("opening", true));
  fireEvent.contextMenu(screen.getByText(name));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
  expect(getEditors().collapsed.opening).toBe(false);
  act(() => mocks.hotkeys.get("mod+p")!());
  await screen.findByRole("button", { name });
  fireEvent.keyDown(screen.getByPlaceholderText("Open file by name"), { key: "Enter" });
  expect(getEditors().editors).toHaveLength(1);
  expect(getEditors().active.opening).toBe(entry.id);
});
