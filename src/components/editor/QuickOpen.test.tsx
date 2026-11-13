import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileHit } from "@/lib/api";
import type { ChangedFile } from "@/types/session";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

const { QuickOpen } = await import("./QuickOpen");
const { getEditors } = await import("@/lib/editors");
const { recordRecentFile, recentFiles } = await import("@/lib/recentFiles");
const { registerProjectSearch } = await import("@/lib/projectSearch");

const ROOT = "/repo";
const KEY = `local:${ROOT}`;
const ALL = ["README.md", "package.json", "src/lib/scripts.ts", "src/lib/scripts.test.ts", "src/components/settings/ProjectScripts.tsx", "docs/scripts.md", ".github/workflows/ci.yml"];
const IGNORED = [".env.local", "dist/bundle.js"];
const CHANGED: ChangedFile[] = [
  { path: "src/components/settings/ProjectScripts.tsx", status: "modified", additions: 212, deletions: 4 },
  { path: "docs/scripts.md", status: "added", additions: 41, deletions: 0 },
];
/** Files that once were opened but are gone now. */
let missing = new Set<string>();

const hitOf = (path: string): FileHit => ({ path, name: path.split("/").pop()!, score: 1 });

/** A plain substring search stands in for the backend's fuzzy one: the dialog never ranks. */
function search(query: string, includeIgnored: boolean): FileHit[] {
  const files = includeIgnored ? [...ALL, ...IGNORED] : ALL;
  return files.filter((p) => p.toLowerCase().includes(query.toLowerCase())).map(hitOf);
}

function openQuickOpen() {
  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true });
}

const input = () => screen.findByRole("textbox", { name: "Search files" });
const rowNames = () => screen.getAllByRole("option").map((o) => o.querySelector("span.truncate")?.textContent);

function headingsAndRows(): string[] {
  const list = screen.getByRole("listbox", { name: "Files" });
  return [...list.children].map((li) => (li.getAttribute("role") === "option" ? `  ${li.querySelector("span.truncate")?.textContent}` : (li.textContent ?? "")));
}

beforeEach(() => {
  localStorage.clear();
  missing = new Set();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "search_files":
        return search(args.query as string, args.includeIgnored === true).slice(0, args.limit as number);
      case "count_files":
        return { files: args.includeIgnored ? ALL.length + IGNORED.length : ALL.length, truncated: false };
      case "file_mtime":
        return missing.has((args.path as string).slice(ROOT.length + 1)) ? null : 1;
      case "review_range":
        return { target: "origin/main", base: "base-tree", head: "head-tree" };
      case "changes_between":
        return CHANGED;
      case "copy_text":
        return null;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});
afterEach(cleanup);

describe("QuickOpen", () => {
  it("lists recently opened files first, newest on top, then all files", async () => {
    for (const path of ["package.json", "src/lib/scripts.ts", "gone.ts", "src/components/settings/ProjectScripts.tsx"]) recordRecentFile(KEY, path);
    missing.add("gone.ts");
    render(<QuickOpen sessionId="s1" root={ROOT} branch="raccoon/project-scripts" />);
    openQuickOpen();
    await input();
    await waitFor(() => expect(headingsAndRows()[0]).toBe("Recent"));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(ALL.length));
    const rows = headingsAndRows();
    expect(rows.slice(0, 5)).toEqual(["Recent", "  ProjectScripts.tsx", "  scripts.ts", "  package.json", "All files"]);
    // A recent file is not listed twice, and one that is gone is dropped from the list.
    expect(rows.filter((r) => r === "  package.json")).toHaveLength(1);
    expect(rows).not.toContain("  gone.ts");
    expect(recentFiles(KEY)).not.toContain("gone.ts");
    expect(screen.getByText("Recent files first · 7 files in this worktree")).toBeTruthy();
  });

  it("opening a file puts it on top of the recent list", async () => {
    render(<QuickOpen sessionId="s1" root={ROOT} />);
    openQuickOpen();
    fireEvent.change(await input(), { target: { value: "readme" } });
    await waitFor(() => expect(rowNames()).toEqual(["README.md"]));
    fireEvent.keyDown(await input(), { key: "Enter" });
    expect(getEditors().editors.some((e) => e.rel === "README.md" && e.kind === "text")).toBe(true);
    expect(recentFiles(KEY)[0]).toBe("README.md");
  });

  it("marks changed files with their line counts and status, and leaves the rest bare", async () => {
    render(<QuickOpen sessionId="s1" root={ROOT} />);
    openQuickOpen();
    fireEvent.change(await input(), { target: { value: "scripts" } });
    const modified = await screen.findByRole("option", { name: /ProjectScripts\.tsx/ });
    expect(within(modified).getByText("+212")).toBeTruthy();
    expect(within(modified).getByText("−4")).toBeTruthy();
    expect(within(modified).getByLabelText("Modified").textContent).toBe("M");
    const added = screen.getByRole("option", { name: /scripts\.md/ });
    expect(within(added).getByText("+41")).toBeTruthy();
    expect(within(added).queryByText(/−/)).toBeNull();
    expect(within(added).getByLabelText("Added").textContent).toBe("A");
    const plain = screen.getByRole("option", { name: /^scripts\.ts/ });
    expect(within(plain).queryByText(/^\+/)).toBeNull();
    expect(within(plain).queryByLabelText(/Modified|Added/)).toBeNull();
  });

  it("shows the selected row's actions, with diff only on a changed file", async () => {
    render(<QuickOpen sessionId="s1" root={ROOT} />);
    openQuickOpen();
    fireEvent.change(await input(), { target: { value: "scripts" } });
    await waitFor(() => expect(rowNames()[0]).toBe("scripts.ts"));
    const first = screen.getAllByRole("option")[0];
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(within(first).getByText("open")).toBeTruthy();
    expect(within(first).queryByText("diff")).toBeNull();
    fireEvent.keyDown(await input(), { key: "ArrowDown" });
    fireEvent.keyDown(await input(), { key: "ArrowDown" });
    const changed = screen.getByRole("option", { name: /ProjectScripts\.tsx/ });
    expect(changed.getAttribute("aria-selected")).toBe("true");
    expect(within(changed).getByText("diff")).toBeTruthy();
    expect(within(first).queryByText("open")).toBeNull();
  });

  it("opens a changed file's diff on ⌘Enter, against the branch's base", async () => {
    render(<QuickOpen sessionId="s1" root={ROOT} />);
    openQuickOpen();
    fireEvent.change(await input(), { target: { value: "ProjectScripts" } });
    await screen.findByRole("option", { name: /ProjectScripts\.tsx/ });
    await waitFor(() => expect(screen.getByRole("option", { name: /ProjectScripts\.tsx/ }).textContent).toContain("+212"));
    fireEvent.keyDown(await input(), { key: "Enter", ctrlKey: true });
    const diff = getEditors().editors.find((e) => e.kind === "diff" && e.rel === "src/components/settings/ProjectScripts.tsx");
    expect(diff).toBeTruthy();
    expect(diff?.kind === "diff" && diff.diff).toMatchObject({ scope: "all", range: { base: "base-tree", head: "head-tree" }, uncommitted: false });
    expect(screen.queryByRole("textbox", { name: "Search files" })).toBeNull();
  });

  it("does nothing on ⌘Enter for an unchanged file", async () => {
    render(<QuickOpen sessionId="s1" root={ROOT} />);
    openQuickOpen();
    fireEvent.change(await input(), { target: { value: "package" } });
    await waitFor(() => expect(rowNames()).toEqual(["package.json"]));
    const before = getEditors().editors.length;
    fireEvent.keyDown(await input(), { key: "Enter", ctrlKey: true });
    expect(getEditors().editors.length).toBe(before);
    expect(screen.getByRole("textbox", { name: "Search files" })).toBeTruthy();
  });

  it("copies the selected file's path on ⌥⌘C", async () => {
    render(<QuickOpen sessionId="s1" root={ROOT} />);
    openQuickOpen();
    fireEvent.change(await input(), { target: { value: "ci.yml" } });
    await waitFor(() => expect(rowNames()).toEqual(["ci.yml"]));
    fireEvent.keyDown(await input(), { key: "ç", code: "KeyC", ctrlKey: true, altKey: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("copy_text", { text: "/repo/.github/workflows/ci.yml" }));
    expect(await screen.findByText("copied")).toBeTruthy();
  });

  it("says what was searched when nothing matches, and offers search in files and ignored files", async () => {
    render(<QuickOpen sessionId="s1" root={ROOT} branch="raccoon/project-scripts" />);
    openQuickOpen();
    fireEvent.change(await input(), { target: { value: "zqx" } });
    expect(await screen.findByText("No files match “zqx”")).toBeTruthy();
    expect(screen.getByText("File names and paths in raccoon/project-scripts were searched. Gitignored files are skipped.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Search inside files/ }).textContent).toContain("Ctrl");
    expect(screen.getByRole("button", { name: "Include gitignored files" })).toBeTruthy();
    expect(screen.getByText("edit the query")).toBeTruthy();
    expect(screen.getByText("7 files in this worktree")).toBeTruthy();
  });

  it("opens search in files filled in with the query", async () => {
    const opened: (string | undefined)[] = [];
    const unregister = registerProjectSearch((query) => opened.push(query));
    try {
      render(<QuickOpen sessionId="s1" root={ROOT} />);
      openQuickOpen();
      fireEvent.change(await input(), { target: { value: "needle " } });
      fireEvent.click(await screen.findByRole("button", { name: /Search inside files/ }));
      expect(opened).toEqual(["needle"]);
      expect(screen.queryByRole("textbox", { name: "Search files" })).toBeNull();

      // The shortcut does the same while nothing matches.
      openQuickOpen();
      fireEvent.change(await input(), { target: { value: "haystack" } });
      await screen.findByText("No files match “haystack”");
      fireEvent.keyDown(await input(), { key: "f", code: "KeyF", ctrlKey: true, shiftKey: true });
      expect(opened).toEqual(["needle", "haystack"]);
    } finally {
      unregister();
    }
  });

  it("reruns the search over gitignored files and shows what it finds", async () => {
    render(<QuickOpen sessionId="s1" root={ROOT} />);
    openQuickOpen();
    fireEvent.change(await input(), { target: { value: "env.local" } });
    fireEvent.click(await screen.findByRole("button", { name: "Include gitignored files" }));
    await waitFor(() => expect(rowNames()).toEqual([".env.local"]));
    expect(invoke).toHaveBeenCalledWith("search_files", { cwd: ROOT, query: "env.local", limit: 40, includeIgnored: true });
    expect(screen.getByText("Gitignored files included · 9 files in this worktree")).toBeTruthy();

    // Still no match: the message says ignored files were searched, and they can be skipped again.
    fireEvent.change(await input(), { target: { value: "zqx" } });
    expect(await screen.findByText("File names and paths in this worktree were searched. Gitignored files were searched too.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip gitignored files" }));
    await screen.findByRole("button", { name: "Include gitignored files" });
  });

  it("starts each opening without ignored files", async () => {
    render(<QuickOpen sessionId="s1" root={ROOT} />);
    openQuickOpen();
    fireEvent.change(await input(), { target: { value: "zqx" } });
    fireEvent.click(await screen.findByRole("button", { name: "Include gitignored files" }));
    await screen.findByRole("button", { name: "Skip gitignored files" });
    fireEvent.keyDown(await input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Search files" })).toBeNull());
    openQuickOpen();
    await waitFor(() => expect(screen.getByText(/^7 files in this worktree$/)).toBeTruthy());
  });
});
