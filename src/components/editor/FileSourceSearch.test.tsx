import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FileSource } from "@/lib/workspaceFiles";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (command: string) => { throw new Error(`A source-backed view called ${command}`); }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({
  WithTooltip: ({ children }: { children: React.ReactNode }) => children,
  Kbd: ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>,
  KbdGroup: ({ keys }: { keys: string[] }) => <kbd>{keys.join("")}</kbd>,
}));

const { ProjectSearch } = await import("./ProjectSearch");
const { QuickOpen } = await import("./QuickOpen");
const { FileTree } = await import("@/components/files/FileTree");
const { closeAllEditors, getEditors } = await import("@/lib/editors");
const { keepWholeWords, wholeWordRemoteQuery } = await import("@/lib/workspaceFiles");

function cloudSource(): FileSource & { search: ReturnType<typeof vi.fn>; findFiles: ReturnType<typeof vi.fn>; listDir: ReturnType<typeof vi.fn> } {
  return {
    key: "cloud:ws-1",
    kind: "cloud",
    readOnly: false,
    listDir: vi.fn(async () => [{ name: "remote.ts", path: "remote.ts", isDir: false }]),
    readText: vi.fn(),
    writeText: vi.fn(),
    stat: vi.fn(),
    changes: async () => [],
    search: vi.fn(async () => ({ hits: [{ path: "remote.ts", line: 4, col: 0, text: "foo()", matches: [[0, 3]] }], files: 1, capped: false })),
    findFiles: vi.fn(async () => [{ path: "src/remote.ts", name: "remote.ts", score: 1 }]),
  } as never;
}

function chord(key: string, shift: boolean) {
  fireEvent.keyDown(window, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, shiftKey: shift });
}

afterEach(async () => {
  cleanup();
  invoke.mockClear();
  await closeAllEditors("s1");
});

it("ProjectSearch greps the given source and offers no replace where it cannot rewrite", async () => {
  const source = cloudSource();
  render(<ProjectSearch sessionId="s1" root="/workspace" source={source} />);
  chord("h", true);
  expect(screen.queryByLabelText("Replace with")).toBeNull();
  chord("f", true);
  fireEvent.change(await screen.findByPlaceholderText("Search in project"), { target: { value: "foo" } });
  await screen.findByText("remote.ts");
  expect(source.search).toHaveBeenCalledWith({ query: "foo", regex: false, caseSensitive: false, wholeWord: false, limit: 500, replacement: undefined }, expect.any(AbortSignal));
  expect(screen.queryByLabelText("Show replace")).toBeNull();
  fireEvent.click(screen.getByText("foo"));
  expect(getEditors().editors[0]).toMatchObject({ rel: "remote.ts", source: "cloud:ws-1" });
  expect(invoke).not.toHaveBeenCalled();
});

it("QuickOpen finds files through the given source and opens them on it", async () => {
  const source = cloudSource();
  render(<QuickOpen sessionId="s1" root="/workspace" source={source} />);
  chord("p", false);
  fireEvent.click(await screen.findByRole("button", { name: /remote.ts/ }));
  expect(source.findFiles).toHaveBeenCalledWith("", 40);
  expect(getEditors().editors[0]).toMatchObject({ rel: "src/remote.ts", source: "cloud:ws-1" });
  expect(invoke).not.toHaveBeenCalled();
});

it("FileTree lists the given source", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const source = cloudSource();
  render(<FileTree sessionId="s1" root="/workspace" active source={source} />);
  expect(await screen.findByText("remote.ts")).toBeTruthy();
  expect(source.listDir).toHaveBeenCalledWith("");
  await waitFor(() => expect(invoke).not.toHaveBeenCalled());
});

it("a cloud whole-word search sends a literal as a bounded regex and filters a regex's hits", () => {
  const q = { regex: false, caseSensitive: false };
  expect(wholeWordRemoteQuery({ ...q, query: "id" })).toEqual({ query: "\\bid\\b", regex: true });
  expect(wholeWordRemoteQuery({ ...q, query: "a.b(" })).toEqual({ query: "\\ba\\.b\\(", regex: true });
  expect(wholeWordRemoteQuery({ ...q, query: "i.", regex: true })).toEqual({ query: "i.", regex: true });
  const hits = keepWholeWords([
    { path: "a.ts", line: 1, col: 0, text: "ids id é_id", matches: [[0, 2], [4, 6], [9, 11]], replacements: ["x", "y", "z"] },
    { path: "b.ts", line: 2, col: 1, text: "xid", matches: [[1, 3]] },
  ]);
  expect(hits).toEqual([{ path: "a.ts", line: 1, col: 4, text: "ids id é_id", matches: [[4, 6]], replacements: ["y"] }]);
});
