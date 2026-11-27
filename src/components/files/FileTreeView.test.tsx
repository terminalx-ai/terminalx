import { revealInFileManager } from "@/lib/platform";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDir: vi.fn(),
  search: vi.fn(),
  list: vi.fn(),
  openProjectSearch: vi.fn(),
  changes: { files: [] as { path: string; status: string; oldPath?: string }[], staged: [] as { path: string; status: string; oldPath?: string }[], unstaged: undefined as { path: string; status: string; oldPath?: string }[] | undefined },
  reviewRange: vi.fn(),
  discard: vi.fn(),
  openDiff: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/api", () => ({ fs: { listDir: mocks.listDir }, files: { search: mocks.search, list: mocks.list } }));
vi.mock("@/lib/gitSource", () => ({
  localGitSource: (cwd: string) => ({ key: `local:${cwd}`, reviewRange: mocks.reviewRange, discard: mocks.discard, errorMessage: String }),
}));
vi.mock("@/lib/projectSearch", () => ({ openProjectSearch: mocks.openProjectSearch }));
vi.mock("@/lib/changes", () => ({ useWorkingChanges: () => ({ files: mocks.changes.files, staged: mocks.changes.staged, unstaged: mocks.changes.unstaged ?? mocks.changes.files, loading: false, head: null }) }));
vi.mock("@/lib/editors", () => ({
  openFile: vi.fn(),
  openDiff: mocks.openDiff,
  useEditors: () => ({ editors: [], active: {} }),
}));
vi.mock("./FileTypeIcon", () => ({ FileTypeIcon: () => null }));

const { FileTreeView, filterRows } = await import("./FileTreeView");

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe("filterRows", () => {
  it("counts matching files against all files: a matching folder is shown but not counted", () => {
    const result = filterRows(["aa/ab/x.txt"], "a");
    expect(result.rows.map((row) => row.path)).toEqual(["aa", "aa/ab"]);
    expect([result.matched, result.total]).toEqual([0, 1]);
    const named = filterRows(["aa/ab/x.txt", "aa/a.md"], "a");
    expect([named.matched, named.total]).toEqual([1, 2]);
  });
});

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
    fireEvent.click(within(menu).getByRole("menuitem", { name: "View" }));
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
    const paths = ["README.md", "src/app/Settings.tsx", "src/lib/api.ts", "docs/guide.md", ".github/workflows/settings.yml"];
    beforeEach(() => {
      mocks.listDir.mockImplementation(async (_root: string, rel: string) =>
        rel ? [] : [{ path: "docs", name: "docs", isDir: true }, { path: "src", name: "src", isDir: true }, { path: "README.md", name: "README.md", isDir: false }],
      );
      mocks.list.mockResolvedValue({ paths, truncated: false });
      mocks.openProjectSearch.mockClear();
    });
    const openFilter = () => fireEvent.click(screen.getByRole("button", { name: "Filter" }));

    it("shows the field only while the filter button is on; turning it off clears the filter", async () => {
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="Alpha" active />);
      await screen.findByText("README.md");
      expect(screen.queryByLabelText("Filter files by name")).toBeNull();
      openFilter();
      expect(screen.getByRole("button", { name: "Filter" }).getAttribute("aria-pressed")).toBe("true");
      const field = screen.getByLabelText("Filter files by name");
      expect(document.activeElement).toBe(field);
      fireEvent.change(field, { target: { value: "setT" } });
      await screen.findByText("Settings.tsx");
      openFilter();
      expect(screen.queryByLabelText("Filter files by name")).toBeNull();
      expect(await screen.findByText("README.md")).toBeTruthy();
      openFilter();
      expect((screen.getByLabelText("Filter files by name") as HTMLInputElement).value).toBe("");
    });

    it("narrows to matching names and their folders, with a count", async () => {
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="Alpha" active />);
      await screen.findByText("README.md");
      openFilter();
      fireEvent.change(screen.getByLabelText("Filter files by name"), { target: { value: "setT" } });
      await screen.findByText("Settings.tsx");
      expect(screen.getByText("app")).toBeTruthy();
      expect(screen.queryByText("README.md")).toBeNull();
      // Hidden files count and match too, as the tree shows them.
      expect(screen.getByText("settings.yml")).toBeTruthy();
      // The total is the worktree's files (five), not its folders and files or the rows listed.
      expect(screen.getByTestId("file-tree-filter-count").textContent).toBe("2 of 5");
      expect(mocks.list).toHaveBeenCalledWith("/repos/alpha", 60_000);
      expect(screen.queryByTestId("file-tree-filter-truncated")).toBeNull();
    });

    it("says when the file list was cut short instead of a count that looks complete", async () => {
      mocks.list.mockResolvedValue({ paths, truncated: true });
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="Alpha" active />);
      await screen.findByText("README.md");
      openFilter();
      fireEvent.change(screen.getByLabelText("Filter files by name"), { target: { value: "setT" } });
      await screen.findByText("Settings.tsx");
      expect(screen.getByTestId("file-tree-filter-count").textContent).toBe("2 of 5+");
      expect(screen.getByTestId("file-tree-filter-truncated").textContent).toContain("Only the first 60,000 files are filtered");
    });

    it("shows why the filter has nothing to show when the file list cannot be read", async () => {
      mocks.list.mockRejectedValue("permission denied");
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="Alpha" active />);
      await screen.findByText("README.md");
      openFilter();
      fireEvent.change(screen.getByLabelText("Filter files by name"), { target: { value: "setT" } });
      expect((await screen.findByTestId("file-tree-filter-error")).textContent).toContain("permission denied");
      // No folder rows that would ignore a click while filtering.
      expect(screen.queryByText("docs")).toBeNull();
      expect(screen.queryByText("README.md")).toBeNull();
    });

    it("says nothing matched; Clear filter restores the earlier folders, Search in files carries the query", async () => {
      mocks.listDir.mockImplementation(async (_root: string, rel: string) =>
        rel === "docs" ? [{ path: "docs/guide.md", name: "guide.md", isDir: false }] : rel ? [] : [{ path: "docs", name: "docs", isDir: true }],
      );
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="Alpha" active />);
      fireEvent.click(await screen.findByText("docs"));
      await screen.findByText("guide.md");
      openFilter();
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
      expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
    });
  });

  describe("header, rows and file menu", () => {
    beforeEach(() => {
      mocks.listDir.mockImplementation(async (_root: string, rel: string) =>
        rel ? [] : [{ path: "src", name: "src", isDir: true }, { path: "a.ts", name: "a.ts", isDir: false }, { path: "b.ts", name: "b.ts", isDir: false }],
      );
      mocks.changes.files = [{ path: "a.ts", status: "modified" }];
      mocks.reviewRange.mockResolvedValue({ target: "HEAD", base: "tree-base", head: "tree-head" });
      mocks.discard.mockResolvedValue(undefined);
      mocks.openDiff.mockClear();
      mocks.discard.mockClear();
    });
    afterEach(() => {
      mocks.changes.files = [];
      mocks.changes.staged = [];
      mocks.changes.unstaged = undefined;
    });

    it("heads the tree with the checkout's name and branch, and lists 26px mono rows with no root row", async () => {
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="alpha" branch="raccoon/feature" active />);
      await screen.findByText("a.ts");
      const header = screen.getByTestId("file-tree-header");
      expect(within(header).getByText("alpha")).toBeTruthy();
      expect(within(header).getByTestId("file-tree-branch").className).toContain("font-mono");
      expect(within(header).getByText("raccoon/feature")).toBeTruthy();
      expect(within(header).getByRole("button", { name: "Filter" })).toBeTruthy();
      expect(within(header).getByRole("button", { name: "New file" })).toBeTruthy();
      expect(within(header).getByRole("button", { name: "Open file by name" }).textContent).toMatch(/^(⌘P|Ctrl\+P)$/);
      const rows = screen.getAllByRole("treeitem");
      expect(rows.map((r) => r.getAttribute("data-path"))).toEqual(["src", "a.ts", "b.ts"]);
      for (const row of rows) expect(row.className).toMatch(/h-\[26px\].*font-mono|font-mono.*h-\[26px\]/);
      expect(rows[0].querySelector("[data-folder-icon]")).toBeTruthy();
    });

    it("offers View, View diff, Attach in chat, Open in, the copies, Reveal and Discard, each with an icon", async () => {
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="alpha" mentionTabId="tab-1" active />);
      fireEvent.contextMenu(await screen.findByText("a.ts"));
      const menu = await screen.findByRole("menu");
      const items = within(menu).getAllByRole("menuitem");
      const label = (item: HTMLElement) => {
        const copy = item.cloneNode(true) as HTMLElement;
        copy.querySelectorAll("[aria-hidden]").forEach((node) => node.remove());
        return copy.textContent?.trim();
      };
      expect(items.map(label)).toEqual([
        "View",
        "View diff",
        "Attach in chatAdds @a.ts",
        "Open in",
        "Copy path",
        "Copy relative path",
        revealInFileManager,
        "Discard changes",
      ]);
      const keys = (item: HTMLElement) => item.querySelector("span[aria-hidden]")?.textContent;
      expect(keys(items[0])).toBe("↵");
      expect(keys(items[4])).toMatch(/^(⌥⌘C|Ctrl\+?Alt\+?C)$/i);
      for (const item of items) expect(item.querySelector("svg")).toBeTruthy();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "View diff" }));
      await waitFor(() =>
        expect(mocks.openDiff).toHaveBeenCalledWith("f", "/repos/alpha", "a.ts", { scope: "all", range: { base: "tree-base", head: "tree-head" }, oldPath: undefined, target: null, uncommitted: true }),
      );
    });

    it("asks before discarding a file's changes", async () => {
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="alpha" active />);
      fireEvent.contextMenu(await screen.findByText("a.ts"));
      fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Discard changes" }));
      const dialog = await screen.findByRole("dialog");
      // The dialog names the file (PRO-400). The tree has no line counts for it, so it says what goes back without them.
      expect(within(dialog).getByText("Discard changes to a.ts?")).toBeTruthy();
      expect(dialog.textContent).toContain("go back to the last commit. This can’t be undone.");
      expect(mocks.discard).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith("a.ts", undefined, undefined));
    });

    // PRO-400 review: discarding a file the last commit does not have deletes it, and the card must say so.
    it("says a new file is deleted, whether untracked or staged as new and edited since", async () => {
      mocks.changes.files = [{ path: "a.ts", status: "added" }];
      const view = render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="alpha" active />);
      fireEvent.contextMenu(await screen.findByText("a.ts"));
      fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Discard changes" }));
      expect((await screen.findByRole("dialog")).textContent).toContain("The file is not in that version, so it is deleted.");
      view.unmount();

      // The tree's own status is the unstaged one ("modified"); the index knows the file is new.
      mocks.changes.files = [{ path: "a.ts", status: "modified" }];
      mocks.changes.staged = [{ path: "a.ts", status: "added" }];
      mocks.changes.unstaged = [{ path: "a.ts", status: "modified" }];
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="alpha" active />);
      fireEvent.contextMenu(await screen.findByText("a.ts"));
      fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Discard changes" }));
      expect((await screen.findByRole("dialog")).textContent).toContain("The file is not in that version, so it is deleted.");
    });

    it("greys out View diff and Discard for a file with no changes", async () => {
      render(<FileTreeView sessionId="f" root="/repos/alpha" rootName="alpha" active />);
      fireEvent.contextMenu(await screen.findByText("b.ts"));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "View diff" }).getAttribute("aria-disabled")).toBe("true");
      expect(within(menu).getByRole("menuitem", { name: "Discard changes" }).getAttribute("aria-disabled")).toBe("true");
    });

    it("virtualizes large trees so only a viewport slice is rendered in the DOM (P-41)", async () => {
      const many = Array.from({ length: 500 }, (_, i) => ({
        path: `file-${String(i).padStart(4, "0")}.ts`,
        name: `file-${String(i).padStart(4, "0")}.ts`,
        isDir: false,
      }));
      mocks.listDir.mockResolvedValue(many);
      render(<FileTreeView sessionId="f" root="/repos/large" rootName="large" active />);
      await screen.findByText("file-0000.ts");
      const mounted = screen.getAllByRole("treeitem");
      expect(mounted.length).toBeLessThan(150);
      expect(mounted.length).toBeGreaterThan(10);
    });
  });
});
