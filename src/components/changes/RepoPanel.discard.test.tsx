import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const backend = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// The diff header's menu is where a working-tree file is discarded; its own reading of the file is not under test.
vi.mock("./FileDiff", () => ({ FileDiff: ({ path, onDiscard }: { path: string; onDiscard?: () => void }) => (onDiscard ? <button type="button" onClick={onDiscard}>Discard from the diff header of {path}</button> : null) }));
const { RepoPanel } = await import("./RepoPanel");

const cwd = "/repos/alpha";
const file = (path: string, status: string, additions: number, deletions: number, oldPath?: string) => ({ path, status, additions, deletions, ...(oldPath ? { oldPath } : {}) });
let staged: ReturnType<typeof file>[];
let unstaged: ReturnType<typeof file>[];

beforeEach(() => {
  staged = [];
  unstaged = [];
  backend.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "git_has_remote": return true;
      case "work_status": return { isRepo: true, branch: "feature", upstream: null, ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 0, head: "abc", dirty: true };
      case "working_changes": return ["abc", [...new Map([...staged, ...unstaged].map((entry) => [entry.path, entry])).values()]];
      case "working_change_sets": return ["abc", "index", staged, unstaged];
      case "git_discard": return null;
      default: return null;
    }
  });
});
afterEach(async () => { await act(async () => cleanup()); backend.invoke.mockReset(); });

/** Select the file in one of the two lists, then discard it from its diff header. */
async function askDiscard(path: string, list: "Staged" | "Unstaged") {
  render(<TooltipProvider><RepoPanel cwd={cwd} active view="uncommitted" onViewChange={() => {}} /></TooltipProvider>);
  const section = await screen.findByRole("region", { name: list });
  fireEvent.click(await within(section).findByRole("button", { name: new RegExp(path.split("/").pop()!.replace(".", "\\.")) }));
  fireEvent.click(await screen.findByRole("button", { name: `Discard from the diff header of ${path}` }));
  return screen.findByRole("alertdialog", { name: `Discard changes to ${path}?` });
}

// PRO-400 review: a discard puts the index and the file back to the last commit, so the card must not describe one side of the index.
it("claims no line count for a file that is staged and then edited again", async () => {
  staged = [file("src/big.ts", "modified", 50, 0)];
  unstaged = [file("src/big.ts", "modified", 1, 0)];
  const dialog = await askDiscard("src/big.ts", "Unstaged");
  expect(dialog.textContent).toContain("Its changes, staged ones included, go back to the last commit. This can’t be undone.");
  expect(dialog.textContent).not.toMatch(/\d+ added/);
});

it("says a file staged as new and then edited is deleted", async () => {
  staged = [file("src/new.ts", "added", 20, 0)];
  unstaged = [file("src/new.ts", "modified", 2, 1)];
  const dialog = await askDiscard("src/new.ts", "Unstaged");
  expect(dialog.textContent).toContain("The file is not in that version, so it is deleted.");
});

it("undoes a staged rename that was edited afterwards, back to its old path", async () => {
  staged = [file("src/after.ts", "renamed", 0, 0, "src/before.ts")];
  unstaged = [file("src/after.ts", "modified", 3, 0)];
  const dialog = await askDiscard("src/after.ts", "Unstaged");
  expect(dialog.textContent).toContain("It goes back to src/before.ts.");
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(backend.invoke.mock.calls.some(([command, args]) => /discard/.test(command) && JSON.stringify(args).includes("src/before.ts"))).toBe(true));
});

it("counts the lines of a file changed on one side only", async () => {
  unstaged = [file("src/slug.js", "modified", 4, 1)];
  const dialog = await askDiscard("src/slug.js", "Unstaged");
  expect(dialog.textContent).toContain("4 added and 1 removed line go back to the last commit. This can’t be undone.");
});
