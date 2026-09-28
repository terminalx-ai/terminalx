import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { workStatus, gitPanelMounted, filesMounted } = vi.hoisted(() => ({ workStatus: vi.fn(), gitPanelMounted: vi.fn(), filesMounted: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { workStatus } }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => ({ panelWidth: 360 }), setPrefs: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: vi.fn(), keycaps: () => [] }));
vi.mock("@/lib/dialogs", () => ({ openSettle: vi.fn(), openWorkspaceDelete: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/changes/ChangesPanel", () => ({ ChangesPanel: () => { gitPanelMounted(); return <div>Commit changes</div>; } }));
vi.mock("@/components/changes/RepoPanel", () => ({ RepoPanel: () => { gitPanelMounted(); return <div>Push branch</div>; } }));
vi.mock("@/components/changes/PrPanel", () => ({ PrPanel: () => { gitPanelMounted(); return <div>Create PR</div>; } }));
vi.mock("@/components/files/FileTree", () => ({ FileTree: (props: { active: boolean; isGit: boolean }) => { filesMounted(props); return <div>Folder files</div>; } }));
const { RightPanel } = await import("./RightPanel");
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows files without mounting Git panels or resolving branch labels for folders", () => {
  render(<RightPanel cwd="/tmp/folder" isGit={false} labelMode="base" />);
  expect(screen.getByRole("button", { name: "Files" })).toBeTruthy();
  for (const name of ["Changes", "Repo", "PR"]) expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.getByText("Folder")).toBeTruthy();
  expect(filesMounted).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, isGit: false }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(gitPanelMounted).not.toHaveBeenCalled();
  expect(workStatus).not.toHaveBeenCalled();
});

it("preserves Git panels when switching back from a folder", () => {
  const view = render(<RightPanel cwd="/tmp/folder" isGit={false} />);
  view.rerender(<RightPanel cwd="/repo" isGit branch="main" />);
  for (const name of ["Changes", "Repo", "PR", "Files"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  expect(gitPanelMounted).toHaveBeenCalledTimes(3);
});
