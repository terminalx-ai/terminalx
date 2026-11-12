import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listDir: vi.fn(), search: vi.fn(), openProjectSearch: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/api", () => ({ fs: { listDir: mocks.listDir }, files: { search: mocks.search } }));
vi.mock("@/lib/projectSearch", () => ({ openProjectSearch: mocks.openProjectSearch }));
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

  describe("name filter", () => {
    const paths = ["README.md", "src/app/Settings.tsx", "src/lib/api.ts", "docs/guide.md"];
    beforeEach(() => {
      mocks.listDir.mockImplementation(async (_root: string, rel: string) =>
        rel ? [] : [{ path: "docs", name: "docs", isDir: true }, { path: "src", name: "src", isDir: true }, { path: "README.md", name: "README.md", isDir: false }],
      );
      mocks.search.mockResolvedValue(paths.map((path) => ({ path, name: path.split("/").pop(), score: 0 })));
      mocks.openProjectSearch.mockClear();
    });

    it("narrows to matching names and their folders, with a count", async () => {
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="Alpha" active />);
      await screen.findByText("README.md");
      fireEvent.change(screen.getByLabelText("Filter files by name"), { target: { value: "setT" } });
      await screen.findByText("Settings.tsx");
      expect(screen.getByText("app")).toBeTruthy();
      expect(screen.queryByText("README.md")).toBeNull();
      expect(screen.getByTestId("file-tree-filter-count").textContent).toBe("1 of 8");
    });

    it("says nothing matched; Clear filter restores the earlier folders, Search in files carries the query", async () => {
      mocks.listDir.mockImplementation(async (_root: string, rel: string) =>
        rel === "docs" ? [{ path: "docs/guide.md", name: "guide.md", isDir: false }] : rel ? [] : [{ path: "docs", name: "docs", isDir: true }],
      );
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="Alpha" active />);
      fireEvent.click(await screen.findByText("docs"));
      await screen.findByText("guide.md");
      fireEvent.change(screen.getByLabelText("Filter files by name"), { target: { value: "zzz" } });
      await screen.findByText("No files match “zzz”");
      expect(screen.getByText("The filter matches file and folder names. To look inside files, search in files.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Search in files/ }));
      expect(mocks.openProjectSearch).toHaveBeenCalledWith("zzz");
      fireEvent.click(screen.getAllByRole("button", { name: "Clear filter" }).find((b) => b.textContent?.includes("Clear filter"))!);
      expect((screen.getByLabelText("Filter files by name") as HTMLInputElement).value).toBe("");
      expect(await screen.findByText("guide.md")).toBeTruthy();
    });

    it("is hidden where the source cannot find files by name", async () => {
      const source = { key: "cloud:x", kind: "cloud", readOnly: false, listDir: async () => [] } as never;
      render(<FileTreeView sessionId="f" root="/w" rootName="W" active source={source} />);
      await waitFor(() => expect(screen.getByRole("tree")).toBeTruthy());
      expect(screen.queryByLabelText("Filter files by name")).toBeNull();
    });
  });
});
