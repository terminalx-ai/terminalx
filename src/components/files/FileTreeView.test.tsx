import { cleanup, render, screen } from "@testing-library/react";
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
