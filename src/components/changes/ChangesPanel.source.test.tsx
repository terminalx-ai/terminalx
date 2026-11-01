import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitSource } from "@/lib/gitSource";
import type { AgentEvent } from "@/types/events";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (command: string) => { throw new Error(`A source-backed panel called ${command}`); }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./DiffPane", () => ({ DiffPane: ({ path, before, after }: { path: string; before: string; after: string }) => <pre data-testid="diff">{`${path}:${before}->${after}`}</pre> }));

const { ChangesPanel } = await import("./ChangesPanel");

const events: AgentEvent[] = [
  { id: "prompt", sessionId: "s", tabId: "t", harness: "codex", seq: 1, ts: "", payload: { type: "user_message", text: "Go", queued: false, baseline: "base-tree" } },
  { id: "done", sessionId: "s", tabId: "t", harness: "codex", seq: 2, ts: "", payload: { type: "turn_completed", status: "ok", head: "head-tree", authFailed: false } },
];

function fakeSource(key: string): GitSource & { changesBetween: ReturnType<typeof vi.fn>; fileContentsAt: ReturnType<typeof vi.fn>; workingChanges: ReturnType<typeof vi.fn> } {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    key,
    cloud: true,
    canWrite: false,
    reviewRange: vi.fn(async (target: string | null, uncommitted: boolean) => ({ target: uncommitted ? "HEAD" : target ?? "main", base: uncommitted ? "work-head" : "merge-base", head: "snapshot" })),
    workingChanges: vi.fn(async () => ({ head: "work-head", files: [{ path: "dirty.ts", status: "modified" as const, additions: 1, deletions: 0 }] })),
    changesBetween: vi.fn(async () => [{ path: "src/turn.ts", status: "modified" as const, additions: 3, deletions: 1 }]),
    fileContentsAt: vi.fn(async () => ({ before: "old", after: "new" })),
    workStatus: unused,
    logCommits: unused,
    branches: unused,
    commit: unused,
    push: unused,
    pull: unused,
    ghAvailable: async () => true,
    prs: unused,
    createPr: unused,
    readyPr: unused,
    mergePr: unused,
    errorMessage: (error: unknown) => `source: ${String(error)}`,
  } as never;
}

afterEach(() => { cleanup(); localStorage.clear(); invoke.mockClear(); });

it("diffs the turn's range and reads both sides through the given source", async () => {
  const source = fakeSource("cloud:w1|repo");
  render(<ChangesPanel source={source} events={events} version={2} active live={false} onViewUncommitted={() => {}} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "turn" } });
  fireEvent.click(await screen.findByRole("button", { name: /turn.ts/ }));
  expect((await screen.findByTestId("diff")).textContent).toBe("src/turn.ts:old->new");
  expect(source.changesBetween).toHaveBeenCalledWith("base-tree", "head-tree");
  expect(source.fileContentsAt).toHaveBeenCalledWith("src/turn.ts", "base-tree", "head-tree");
  expect(invoke).not.toHaveBeenCalled();
});

it("shows the source's working tree against its head", async () => {
  const source = fakeSource("cloud:w2|repo");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} workingTree onViewUncommitted={() => {}} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  fireEvent.click(await screen.findByRole("button", { name: /turn.ts/ }));
  await waitFor(() => expect(source.fileContentsAt).toHaveBeenCalledWith("src/turn.ts", "work-head", "snapshot"));
  expect(invoke).not.toHaveBeenCalled();
});

it("reports a failed workspace diff in the source's words", async () => {
  const source = fakeSource("cloud:w3|repo");
  source.changesBetween.mockRejectedValueOnce("offline");
  render(<ChangesPanel source={source} events={events} version={2} active live={false} onViewUncommitted={() => {}} />);
  expect(await screen.findByText("source: offline")).toBeTruthy();
});

for (const cloud of [false, true]) {
  it(`defaults to accumulated work after status-only turns (${cloud ? "cloud" : "local"})`, async () => {
    const source = fakeSource(`default:${cloud}`);
    source.cloud = cloud;
    source.changesBetween.mockResolvedValue([
      { path: "A", status: "added", additions: 1, deletions: 0 },
      { path: "B", status: "modified", additions: 2, deletions: 1 },
      { path: "C", status: "added", additions: 1, deletions: 0 },
    ]);
    const props = { source, events, version: 2, active: true, live: false, onViewUncommitted: () => {} };
    const view = render(<ChangesPanel {...props} />);
    expect(await screen.findByText("All changes · 3 files")).toBeTruthy();
    expect(source.changesBetween).toHaveBeenLastCalledWith("merge-base", "snapshot");
    expect(screen.getByText(/Against main/)).toBeTruthy();
    view.rerender(<ChangesPanel {...props} events={[]} version={3} />);
    expect(source.changesBetween).toHaveBeenCalledTimes(1);
    expect(screen.getByText("All changes · 3 files")).toBeTruthy();
  });
}

it("persists explicit scope and target per repository across reopening", async () => {
  const source = fakeSource("remember");
  const props = { source, events, version: 2, active: true, live: false, onViewUncommitted: () => {} };
  const view = render(<ChangesPanel {...props} />);
  await screen.findByText(/Against main/);
  fireEvent.change(screen.getByLabelText("Comparison target"), { target: { value: "release" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText(/Against release/);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  await screen.findByText(/Against HEAD ·/);
  view.unmount();
  const reopened = render(<ChangesPanel {...props} />);
  expect((screen.getByLabelText("Changes scope") as HTMLSelectElement).value).toBe("uncommitted");
  await screen.findByText(/Against HEAD ·/);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "all" } });
  await screen.findByText(/Against release/);
  reopened.rerender(<ChangesPanel {...props} source={fakeSource("different-repo")} />);
  expect((screen.getByLabelText("Comparison target") as HTMLInputElement).value).toBe("");
  expect(screen.queryByText(/Against release/)).toBeNull();
  await screen.findByText(/Against main/);
});

it("distinguishes loading, unavailable data, clean workspaces and missing turn snapshots", async () => {
  const source = fakeSource("states");
  source.changesBetween.mockResolvedValue([]);
  const props = { source, events: [], version: 0, active: true, live: false, onViewUncommitted: () => {} };
  render(<ChangesPanel {...props} />);
  expect(screen.getByText("Loading changes…")).toBeTruthy();
  await screen.findByText("No changes in this scope.");
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "turn" } });
  await screen.findByText(/No turn snapshots are available/);
  source.changesBetween.mockRejectedValueOnce("offline");
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "all" } });
  await screen.findByText("source: offline");
  expect(screen.queryByText("No changes in this scope.")).toBeNull();
});

it("reads a rename's original path and surfaces file errors", async () => {
  const source = fakeSource("rename");
  source.changesBetween.mockResolvedValue([{ path: "new", oldPath: "old", status: "renamed", additions: 1, deletions: 0 }]);
  source.fileContentsAt.mockImplementation(async (path: string) => ({ before: path === "old" ? "original" : null, after: "updated" }));
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /new/ }));
  expect((await screen.findByTestId("diff")).textContent).toBe("new:original->updated");
  fireEvent.click(screen.getByRole("button", { name: /new/ }));
  source.fileContentsAt.mockRejectedValueOnce("file unavailable");
  fireEvent.click(screen.getByRole("button", { name: /new/ }));
  await screen.findByText("source: file unavailable");
  expect(screen.queryByTestId("diff")).toBeNull();
});

it("refreshes after terminal edits, commits and branch changes on window focus", async () => {
  const source = fakeSource("refresh");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  await screen.findByRole("button", { name: /turn.ts/ });
  source.changesBetween.mockResolvedValue([{ path: "terminal-edit", status: "added", additions: 1, deletions: 0 }]);
  fireEvent(window, new Event("focus"));
  await screen.findByRole("button", { name: /terminal-edit/ });
  expect(source.reviewRange).toHaveBeenCalledTimes(2);
});

it("does not reuse a previous turn when the latest prompt has no snapshot", async () => {
  const source = fakeSource("missing-latest");
  const latest: AgentEvent = { ...events[0], seq: 3, payload: { type: "user_message", text: "Status?", queued: false } };
  render(<ChangesPanel source={source} events={[...events, latest]} version={3} active live onViewUncommitted={() => {}} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "turn" } });
  await screen.findByText(/No turn snapshots are available/);
  expect(screen.queryByText(/Last turn ·/)).toBeNull();
});

it("clears an invalid comparison and retries the same target on Apply", async () => {
  const source = fakeSource("invalid-target");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  await screen.findByRole("button", { name: /turn.ts/ });
  vi.mocked(source.reviewRange).mockRejectedValueOnce("invalid target");
  fireEvent.change(screen.getByLabelText("Comparison target"), { target: { value: "missing" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText("source: invalid target");
  expect(screen.queryByRole("button", { name: /turn.ts/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText(/Against missing/);
});

it("refreshes while idle without requiring a new agent turn", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const source = fakeSource("idle-refresh");
    const view = render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
    await screen.findByRole("button", { name: /turn.ts/ });
    source.changesBetween.mockResolvedValue([{ path: "terminal-edit", status: "added", additions: 1, deletions: 0 }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await screen.findByRole("button", { name: /terminal-edit/ });
    view.unmount();
  } finally { vi.useRealTimers(); }
});

// ---- a merge left in progress (#736) ----------------------------------------

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "5555555555555555555555555555555555555555";
const mergeFiles = [
  { path: "CHANGELOG.md", status: "modified" as const, additions: 3, deletions: 1 },
  { path: "notes.txt", status: "added" as const, additions: 1, deletions: 0 },
  { path: "src/a.rs", status: "added" as const, additions: 40, deletions: 0 },
  { path: "src/b.rs", status: "modified" as const, additions: 12, deletions: 4 },
  { path: "src/late.rs", status: "added" as const, additions: 2, deletions: 0 },
];

/** A local checkout part way through merging origin/main: one conflict left, one file edited while merging, two as Git merged them. */
function merging(key: string, conflicted = ["CHANGELOG.md"]) {
  const source = fakeSource(key);
  source.cloud = false;
  source.canWrite = true;
  source.changesBetween.mockResolvedValue(mergeFiles);
  const merge = { head: HEAD, mergeHead: BASE, names: ["origin/main", "main"], incoming: 14, conflicted, changedHere: ["notes.txt", ...(conflicted.length ? [] : ["CHANGELOG.md"])], fromBase: ["src/a.rs", "src/b.rs"] };
  return Object.assign(source, {
    unfinishedMerge: vi.fn(async () => merge),
    commitMerge: vi.fn(async () => {}),
    abortMerge: vi.fn(async () => {}),
    merge,
  });
}

it("tells the base's files apart from conflicts and from what was changed while merging", async () => {
  const source = merging("merge-split");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  expect(within(banner).getByText("Merging origin/main into this branch: not committed yet.")).toBeTruthy();
  expect(within(banner).getByText("5555555 brings in 14 commits. 2 files as Git merged them, 1 file changed here, 1 file with unresolved conflicts.")).toBeTruthy();
  await screen.findByRole("region", { name: "Unresolved conflicts" });
  expect(screen.getByText("Unresolved conflicts · 1")).toBeTruthy();
  // A file the merge was read without (src/late.rs) is never claimed for the base.
  expect(screen.getByText("Changed here · 2")).toBeTruthy();
  expect(screen.getByText("From origin/main, as Git merged them · 2")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Unresolved conflicts" })).getByRole("button", { name: /CHANGELOG.md/ })).toBeTruthy();
  const here = within(screen.getByRole("region", { name: "Changed here" }));
  expect(here.getByRole("button", { name: /notes.txt/ }) && here.getByRole("button", { name: /late.rs/ })).toBeTruthy();
  const base = within(screen.getByRole("region", { name: "From origin/main, as Git merged them" }));
  expect(base.getByRole("button", { name: /a.rs/ }) && base.getByRole("button", { name: /b.rs/ })).toBeTruthy();
  // The totals are still the whole of what is uncommitted.
  expect(screen.getByText("Uncommitted changes · 5 files")).toBeTruthy();
  // Nothing is committed with a conflict left.
  expect((within(banner).getByRole("button", { name: "Commit merge" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(banner).getByText("Resolve the conflicts and stage them to commit the merge.")).toBeTruthy();
  expect(source.commitMerge).not.toHaveBeenCalled();
});

it("commits the merge that was read once nothing is conflicted, and says why if it cannot", async () => {
  const source = merging("merge-commit", []);
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  source.commitMerge.mockRejectedValueOnce("HEAD moved since the merge was read");
  fireEvent.click(within(banner).getByRole("button", { name: "Commit merge" }));
  expect(await within(banner).findByRole("alert")).toHaveProperty("textContent", "source: HEAD moved since the merge was read");
  const reads = source.unfinishedMerge.mock.calls.length;
  source.unfinishedMerge.mockResolvedValue(null as never);
  fireEvent.click(within(banner).getByRole("button", { name: "Commit merge" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Merge in progress" })).toBeNull());
  expect(source.commitMerge).toHaveBeenLastCalledWith(source.merge);
  expect(source.unfinishedMerge.mock.calls.length).toBeGreaterThan(reads);
  expect(source.abortMerge).not.toHaveBeenCalled();
});

it("aborts the merge only after a confirmation that says what goes and what stays", async () => {
  const source = merging("merge-abort");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  fireEvent.click(within(banner).getByRole("button", { name: "Abort merge…" }));
  const dialog = await screen.findByRole("dialog", { name: "Abort the merge of origin/main?" });
  expect(within(dialog).getByText("The checkout goes back to 1111111, as it was before the merge (git merge --abort).")).toBeTruthy();
  const said = within(within(dialog).getByRole("list", { name: "What aborting does" })).getAllByRole("listitem").map((item) => item.textContent);
  expect(said).toEqual([
    "What was done while merging is lost, in CHANGELOG.md, notes.txt.",
    "2 files from origin/main leave the checkout. origin/main still has them.",
    "Untracked files stay. Git changes nothing if aborting would throw away an edit it cannot put back.",
  ]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep the merge" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(source.abortMerge).not.toHaveBeenCalled();

  fireEvent.click(within(banner).getByRole("button", { name: "Abort merge…" }));
  source.unfinishedMerge.mockResolvedValue(null as never);
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Abort merge" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Merge in progress" })).toBeNull());
  expect(source.abortMerge).toHaveBeenCalledWith(source.merge);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("says what is being merged in every scope, and splits only the uncommitted files", async () => {
  const source = merging("merge-all");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  expect(within(banner).getByText(/Until it is committed, this counts what the merge brings in as the branch's own work/)).toBeTruthy();
  expect(screen.getByText("All changes · 5 files")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Changed here" })).toBeNull();
});

it("shows no merge for a source that cannot tell, and a merge that cannot be read in its words", async () => {
  const cloud = fakeSource("merge-cloud");
  render(<ChangesPanel source={cloud} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  await screen.findByRole("button", { name: /turn.ts/ });
  expect(screen.queryByRole("region", { name: "Merge in progress" })).toBeNull();
  cleanup();
  const local = merging("merge-unreadable");
  local.unfinishedMerge.mockRejectedValue("index.lock exists");
  render(<ChangesPanel source={local} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).toBe("Whether a merge is in progress could not be read: source: index.lock exists");
  expect(screen.getByText("All changes · 5 files")).toBeTruthy();
});
