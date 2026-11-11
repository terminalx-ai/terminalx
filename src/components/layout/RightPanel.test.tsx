import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { workStatus, gitPanelMounted, filesMounted } = vi.hoisted(() => ({ workStatus: vi.fn(), gitPanelMounted: vi.fn(), filesMounted: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { workStatus } }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => ({ panelWidth: 360 }), getPrefs: () => ({ sidebarShowArchived: false }), setPrefs: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: vi.fn(), keycaps: () => [], useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
vi.mock("@/lib/dialogs", () => ({ openSettle: vi.fn(), openWorkspaceDelete: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/changes/ChangesPanel", () => ({ ChangesPanel: () => { gitPanelMounted(); return <div>Commit changes</div>; } }));
vi.mock("@/components/changes/BranchTab", () => ({ BranchTab: ({ branch }: { branch: unknown }) => { gitPanelMounted(); return <div>{branch ? "Branch overview" : "Pull request only"}</div>; } }));
vi.mock("@/components/files/FileTree", () => ({ FileTree: (props: { active: boolean; isGit: boolean }) => { filesMounted(props); return <div>Folder files</div>; } }));
const { RightPanel } = await import("./RightPanel");
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows files without mounting Git panels or resolving branch labels for folders", () => {
  render(<RightPanel cwd="/tmp/folder" isGit={false} labelMode="base" />);
  expect(screen.getByRole("button", { name: "Files" })).toBeTruthy();
  for (const name of ["Branch", "Changes"]) expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.getByText("Folder")).toBeTruthy();
  expect(filesMounted).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, isGit: false }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(gitPanelMounted).not.toHaveBeenCalled();
  expect(workStatus).not.toHaveBeenCalled();
});

it("preserves Git panels when switching back from a folder", () => {
  const view = render(<RightPanel cwd="/tmp/folder" isGit={false} />);
  view.rerender(<RightPanel cwd="/repo" isGit branch="main" />);
  // Branch holds the pull request (Overview) and the commit box and history (Changes): no Repo or PR of their own.
  expect(screen.getAllByRole("button").map((b) => b.textContent).filter(Boolean)).toEqual(["Branch", "Files"]);
  expect(screen.getAllByRole("tab").map((b) => b.textContent)).toEqual(["Overview", "Changes"]);
  expect(gitPanelMounted).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Branch overview")).toBeTruthy();
});

it("keeps a Branch tab for a cloud workspace, its pull request alone", () => {
  const source = { cloud: true, key: "cloud:w|repo", workStatus: workStatus } as never;
  workStatus.mockResolvedValue({ branch: "main" });
  render(<RightPanel cwd="/w" branch="main" gitSource={source} />);
  expect(screen.getByRole("button", { name: "Branch" })).toBeTruthy();
  expect(screen.getByText("Pull request only")).toBeTruthy();
});
