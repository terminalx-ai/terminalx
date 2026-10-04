// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ check: vi.fn(), remove: vi.fn(), alert: vi.fn(), refresh: vi.fn(), done: vi.fn() }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => ({ api: { workspaceDisposition: mocks.check, deleteSession: mocks.remove }, refreshSessions: mocks.refresh, connectionStage: "connected" }) }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  Pressable: ({ onPress, disabled, children }: any) => <button onClick={onPress} disabled={disabled}>{children}</button>,
  Text: ({ children }: any) => <span>{children}</span>,
}));
import { SessionDeleteButton } from "./SessionDeleteButton";
let root: Root;
let container: HTMLDivElement;
const clean = { safe: true, checked: true, sessions: 1, isMain: false, uncommitted: 0, stashes: 0, merged: true, pushed: true, branch: "feature", defaultBranch: "main", aheadOfBase: 0 };
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.check.mockResolvedValue(clean);
  mocks.remove.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SessionDeleteButton sessionId="s1" title="Fix login" onDeleted={mocks.done} />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const open = async () => { await act(async () => container.querySelector("button")!.click()); };
const choose = async (name: string) => { await act(async () => { const buttons = mocks.alert.mock.lastCall![2]; buttons.find((b: any) => b.text === name).onPress(); }); };
it("deletes only the selected session when its workspace is shared", async () => {
  mocks.check.mockResolvedValue({ ...clean, sessions: 2 });
  await open();
  expect(mocks.alert.mock.lastCall![2].map((b: any) => b.text)).not.toContain("Also delete workspace");
  await choose("Delete session only");
  expect(mocks.remove).toHaveBeenCalledWith("s1", false, false);
});
it("uses one confirmation for clean merged workspace removal", async () => {
  await open();
  await choose("Also delete workspace");
  expect(mocks.alert).toHaveBeenCalledTimes(1);
  expect(mocks.remove).toHaveBeenCalledWith("s1", true, false);
});
it("requires an explicit second confirmation for unmerged or unverified work", async () => {
  mocks.check.mockResolvedValue({ ...clean, safe: false, merged: false, aheadOfBase: 3, uncommitted: 2 });
  await open();
  expect(mocks.alert.mock.lastCall![1]).toContain("3 commits not in main");
  await choose("Also delete workspace");
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.alert.mock.lastCall![0]).toBe("Confirm permanent removal");
  await choose("Delete anyway");
  expect(mocks.remove).toHaveBeenCalledWith("s1", true, true);
});
it("keeps the workspace choice unavailable when its ownership cannot be read", async () => {
  mocks.check.mockRejectedValue(new Error("offline"));
  await open();
  expect(mocks.alert.mock.lastCall![2].map((b: any) => b.text)).not.toContain("Also delete workspace");
});
