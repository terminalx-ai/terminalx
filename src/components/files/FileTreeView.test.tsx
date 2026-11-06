import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listDir: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/api", () => ({ fs: { listDir: mocks.listDir } }));
vi.mock("@/lib/changes", () => ({ useWorkingChanges: () => ({ files: [], loading: false, head: null }) }));
vi.mock("@/lib/editors", () => ({
  openFile: vi.fn(),
  useEditors: () => ({ editors: [], active: {} }),
}));
vi.mock("./FileTypeIcon", () => ({ FileTypeIcon: () => null }));

const { FileTreeView } = await import("./FileTreeView");

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe("FileTreeView", () => {
  it.each(["right-click", "Shift+F10", "ContextMenu"])("opens actions for the intended file with %s", async (input) => {
    mocks.listDir.mockResolvedValue([
      { path: "alpha.txt", name: "alpha.txt", isDir: false },
      { path: "beta.txt", name: "beta.txt", isDir: false },
    ]);
    render(<FileTreeView sessionId="files" root="/repos/alpha" rootName="Alpha" active />);
    await screen.findByText("beta.txt");
    const tree = screen.getByRole("tree");
    act(() => tree.focus());
    if (input === "right-click") fireEvent.contextMenu(screen.getByText("beta.txt"));
    else {
      fireEvent.keyDown(tree, { key: "ArrowDown" });
      fireEvent.keyDown(tree, { key: "ArrowDown" });
      fireEvent.keyDown(tree, { key: input === "Shift+F10" ? "F10" : "ContextMenu", shiftKey: input === "Shift+F10" });
    }
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open" }));
    const { openFile } = await import("@/lib/editors");
    expect(openFile).toHaveBeenCalledWith("files", "/repos/alpha", "beta.txt", undefined, "/repos/alpha", undefined);
    await waitFor(() => expect(document.activeElement).toBe(tree));
  });

  it("loads a fresh tree when its project root changes", async () => {
    mocks.listDir.mockImplementation(async (root: string) => [
      {
        path: root === "/repos/alpha" ? "alpha.txt" : "beta.txt",
        name: root === "/repos/alpha" ? "alpha.txt" : "beta.txt",
        isDir: false,
      },
    ]);

    const { rerender } = render(
      <FileTreeView sessionId="project:/repos/alpha" root="/repos/alpha" rootName="Alpha" active />,
    );
    await screen.findByText("alpha.txt");

    rerender(<FileTreeView sessionId="project:/repos/beta" root="/repos/beta" rootName="Beta" active />);

    await screen.findByText("beta.txt");
    expect(screen.queryByText("alpha.txt")).toBeNull();
    expect(mocks.listDir).toHaveBeenLastCalledWith("/repos/beta", "");
  });
});
