// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileTreeView } from "@/components/files/FileTreeView";
import { closeAllEditors, getEditors } from "@/lib/editors";
import type { TextSearch } from "@/lib/api";
import { cloudFileSource, StaleRequestError, type FileSource, type SourceEntry } from "@/lib/workspaceFiles";
import { CloudSearch } from "./CloudFiles";

vi.mock("@/lib/api", () => ({ fs: { listDir: vi.fn() }, api: {} }));
vi.mock("@/lib/changes", () => ({ useWorkingChanges: () => ({ files: [], loading: false, head: null }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn().mockResolvedValue(true) }));

const KEY = "cloud:org-1:ws-1";
const ROOT = `cloud://${KEY}`;

function fakeSource(overrides: Partial<FileSource> = {}): FileSource & { emit(paths: string[] | null): void } {
  const listeners = new Set<(paths: string[] | null) => void>();
  return {
    key: KEY,
    kind: "cloud",
    readOnly: false,
    listDir: async () => [],
    readText: async () => ({ content: "", size: 0, binary: false, truncated: false, version: "v" }),
    writeText: async () => ({ version: "v" }),
    stat: async () => ({ version: "v" }),
    watch: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (paths) => {
      for (const listener of listeners) listener(paths);
    },
    ...overrides,
  };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  cleanup();
  await closeAllEditors(KEY);
});

describe("the file tree on a cloud workspace", () => {
  it("lists through the source, shows escaping links without following them, and follows changes", async () => {
    let listing: SourceEntry[] = [
      { name: "src", path: "src", isDir: true },
      { name: "escape", path: "escape", isDir: false, symlink: true, escapes: true },
      { name: "README.md", path: "README.md", isDir: false },
    ];
    const listDir = vi.fn(async (rel: string) => (rel === "" ? listing : []));
    const source = fakeSource({
      listDir,
      changes: async () => [{ path: "README.md", status: "modified" }],
    });
    render(<FileTreeView sessionId={KEY} root={ROOT} rootName="ws-1" active source={source} />);
    await screen.findByText("README.md");
    expect(screen.getByText("link outside")).toBeTruthy();
    await screen.findByText("M");

    fireEvent.click(screen.getByText("escape"));
    expect(getEditors().editors).toHaveLength(0);
    fireEvent.click(screen.getByText("README.md"));
    expect(getEditors().editors[0]).toMatchObject({ rel: "README.md", source: KEY, root: ROOT });

    // A local-only action is not offered for a remote file.
    fireEvent.contextMenu(screen.getByText("README.md"));
    await screen.findByRole("menuitem", { name: "Copy relative path" });
    expect(screen.queryByRole("menuitem", { name: "Reveal in Finder" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Copy path" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    // An agent adds a file: the root is listed again.
    listing = [...listing, { name: "NEW.md", path: "NEW.md", isDir: false }];
    act(() => source.emit(["NEW.md"]));
    await screen.findByText("NEW.md", {}, { timeout: 3000 });
  });

  it("catches up on changes made while it was hidden", async () => {
    let listing: SourceEntry[] = [{ name: "a.txt", path: "a.txt", isDir: false }];
    const source = fakeSource({ listDir: async () => listing });
    const view = (active: boolean) => <FileTreeView sessionId={KEY} root={ROOT} rootName="ws-1" active={active} source={source} />;
    const { rerender } = render(view(true));
    await screen.findByText("a.txt");
    rerender(view(false));
    listing = [...listing, { name: "b.txt", path: "b.txt", isDir: false }];
    // Missed: the hidden tree does not listen.
    act(() => source.emit(["b.txt"]));
    rerender(view(true));
    await screen.findByText("b.txt");
  });
});

describe("search on a cloud workspace", () => {
  it("cancels the previous query and only ever shows the latest answer", async () => {
    const signals: AbortSignal[] = [];
    const answers: ((result: TextSearch) => void)[] = [];
    const source = fakeSource({
      search: (_query, signal) => {
        signals.push(signal);
        return new Promise<TextSearch>((resolve) => answers.push(resolve));
      },
    });
    render(
      <TooltipProvider>
        <CloudSearch source={source} sessionId={KEY} root={ROOT} active />
      </TooltipProvider>,
    );
    const input = screen.getByLabelText("Search the workspace");
    fireEvent.change(input, { target: { value: "old" } });
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.change(input, { target: { value: "new" } });
    expect(signals[0]!.aborted).toBe(true);
    await waitFor(() => expect(signals).toHaveLength(2));

    // The stale answer arrives late and is ignored.
    answers[0]!({ hits: [{ path: "stale.ts", line: 1, col: 0, text: "old", matches: [[0, 3]] }], files: 1, capped: false });
    answers[1]!({ hits: [{ path: "fresh.ts", line: 4, col: 2, text: "  new", matches: [[2, 5]] }], files: 1, capped: true });
    await screen.findByText("fresh.ts");
    expect(screen.queryByText("stale.ts")).toBeNull();
    expect(screen.getByText(/1\+ results in 1 files/)).toBeTruthy();

    fireEvent.click(await screen.findByText((_, element) => element?.tagName === "SPAN" && element.textContent === "  new"));
    expect(getEditors().editors[0]).toMatchObject({ rel: "fresh.ts", source: KEY, jump: { line: 4, col: 2 } });
  });
});

describe("a cloud file source", () => {
  it("drops answers still on their way once its workspace closes, and cancels its searches", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let release: (value: unknown) => void = () => {};
    const client = {
      call: vi.fn((method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "fs.list") return new Promise((resolve) => (release = resolve));
        if (method === "fs.search") return new Promise(() => {});
        return Promise.resolve({});
      }),
      watchFiles: vi.fn(async () => () => {}),
    };
    const source = cloudFileSource(KEY, client as never, false);
    const listing = source.listDir("");
    const search = source.search!({ query: "x", regex: false, caseSensitive: false }, new AbortController().signal);
    source.dispose();
    release({ path: "", entries: [], truncated: false });
    await expect(listing).rejects.toBeInstanceOf(StaleRequestError);
    await expect(search).rejects.toBeInstanceOf(StaleRequestError);
    const searchId = calls.find((call) => call.method === "fs.search")!.params.searchId;
    expect(calls).toContainEqual({ method: "fs.cancel", params: { searchId } });
  });

  it("refuses paths that leave the workspace before sending them", async () => {
    const client = { call: vi.fn(async () => ({})), watchFiles: vi.fn() };
    const source = cloudFileSource(KEY, client as never, false);
    await expect(source.readText("../../etc/passwd")).rejects.toMatchObject({ code: "path_forbidden" });
    await expect(source.listDir("/Users")).rejects.toMatchObject({ code: "path_forbidden" });
    expect(client.call).not.toHaveBeenCalled();
  });

  it("maps Git status for the tree's badges and hides .git", async () => {
    const client = {
      call: vi.fn(async (method: string) =>
        method === "git.status"
          ? {
              repository: true,
              files: [
                { path: "new.txt", index: "?", worktree: "?" },
                { path: "edited.rs", index: " ", worktree: "M" },
                { path: "gone.rs", index: "D", worktree: " " },
                { path: "moved.rs", index: "R", worktree: " ", from: "old.rs" },
              ],
            }
          : {
              path: "",
              truncated: false,
              entries: [
                { name: ".git", path: ".git", kind: "directory", size: 0, modifiedMs: 1 },
                { name: "b.txt", path: "b.txt", kind: "file", size: 1, modifiedMs: 1 },
                { name: "A", path: "A", kind: "directory", size: 0, modifiedMs: 1 },
              ],
            },
      ),
      watchFiles: vi.fn(),
    };
    const source = cloudFileSource(KEY, client as never, false);
    expect(await source.changes!()).toEqual([
      { path: "new.txt", status: "added" },
      { path: "edited.rs", status: "modified" },
      { path: "gone.rs", status: "deleted" },
      { path: "moved.rs", status: "renamed" },
    ]);
    expect((await source.listDir("")).map((entry) => entry.name)).toEqual(["A", "b.txt"]);
  });
});
