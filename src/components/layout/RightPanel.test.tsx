import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { workStatus, gitPanelMounted, filesMounted } = vi.hoisted(() => ({ workStatus: vi.fn(), gitPanelMounted: vi.fn(), filesMounted: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { workStatus, reviewRange: vi.fn(() => new Promise(() => {})) }, errorMessage: String }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => ({ panelWidth: 360 }), getPrefs: () => ({ sidebarShowArchived: false }), setPrefs: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: vi.fn(), keycaps: () => [], useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
vi.mock("@/lib/dialogs", () => ({ openSettle: vi.fn(), openWorkspaceDelete: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/changes/ChangesPanel", () => ({ ChangesPanel: () => { gitPanelMounted(); return <div>Commit changes</div>; } }));
vi.mock("@/components/changes/BranchTab", () => ({ BranchTab: ({ branch }: { branch: unknown }) => { gitPanelMounted(); return <div>{branch ? "Branch overview" : "Pull request only"}</div>; } }));
vi.mock("@/components/files/FileTree", () => ({ FileTree: (props: { active: boolean; isGit: boolean }) => { filesMounted(props); return <div>Folder files</div>; } }));
const { computerPanel } = vi.hoisted(() => ({ computerPanel: vi.fn() }));
vi.mock("@/components/computer/ComputerPanel", () => ({ ComputerPanel: (props: unknown) => { computerPanel(props); return <div>Computer panel</div>; } }));
const { RightPanel } = await import("./RightPanel");
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows files without mounting Git panels or resolving branch labels for folders", () => {
  render(<RightPanel cwd="/tmp/folder" isGit={false} labelMode="base" />);
  expect(screen.getByRole("button", { name: "Files" })).toBeTruthy();
  for (const name of ["Checks", "Changes"]) expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.getByText("Folder")).toBeTruthy();
  expect(filesMounted).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, isGit: false }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(gitPanelMounted).not.toHaveBeenCalled();
  expect(workStatus).not.toHaveBeenCalled();
});

it("preserves Git panels when switching back from a folder", () => {
  const view = render(<RightPanel cwd="/tmp/folder" isGit={false} />);
  view.rerender(<RightPanel cwd="/repo" isGit branch="main" />);
  // Changes (the commit box and history) and Checks (the pull request and its checks) are tabs of their own (PRO-394).
  expect(screen.getAllByRole("button").map((b) => b.textContent).filter(Boolean)).toEqual(["Changes", "Checks", "Files"]);
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(gitPanelMounted).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Branch overview")).toBeTruthy();
});

it("keeps a Checks tab for a cloud workspace, its pull request alone", () => {
  const source = { cloud: true, key: "cloud:w|repo", workStatus: workStatus } as never;
  workStatus.mockResolvedValue({ branch: "main" });
  render(<RightPanel cwd="/w" branch="main" gitSource={source} />);
  expect(screen.getByRole("button", { name: "Checks" })).toBeTruthy();
  expect(screen.getByText("Pull request only")).toBeTruthy();
});

it("attaches the Computer tab to the tab on screen and its own conversation (review 2)", () => {
  render(<RightPanel cwd="/repo" isGit={false} computer sessionId="session" mentionTabId="persisted-tab" computerTab={{ tabId: "shown-tab", conversation: "shown-conversation" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Computer" }));
  expect(computerPanel).toHaveBeenLastCalledWith(expect.objectContaining({ context: { sessionId: "session", tabId: "shown-tab", conversation: "shown-conversation" } }));
});

it("keeps panel tabs in a scrollable tablist with Refresh pinned outside and supports keyboard resizing", async () => {
  const { clampPanelWidth } = await import("./RightPanel");
  expect(clampPanelWidth(400, 760, 200)).toBe(240);

  render(<RightPanel cwd="/repo" isGit branch="main" computer browser sessionId="s1" />);
  const tablist = screen.getByRole("tablist", { name: "Panel views" });
  expect(tablist.className).toContain("overflow-x-auto");
  expect(tablist.className).toContain("min-w-0");
  expect(tablist.contains(screen.getByRole("button", { name: "Refresh" }))).toBe(false);

  const separator = screen.getByRole("separator", { name: "Resize right panel" });
  expect(separator.tabIndex).toBe(0);
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(document.documentElement.style.getPropertyValue("--panel-w")).toBe("376px");
});
