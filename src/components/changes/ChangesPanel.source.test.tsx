import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitSource } from "@/lib/gitSource";
import type { AgentEvent } from "@/types/events";
import type { UnfinishedMerge } from "@/types/session";

const { invoke, ask } = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string) => { throw new Error(`A source-backed panel called ${command}`); }),
  ask: vi.fn(async (_message: string, _options?: unknown) => false),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));
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

afterEach(() => { cleanup(); localStorage.clear(); invoke.mockClear(); ask.mockReset(); ask.mockResolvedValue(false); });

/** A source whose checkout holds `merge`, until it is committed or aborted. */
function merging(key: string, merge: UnfinishedMerge, files: { path: string; status: "added" | "modified"; additions: number; deletions: number }[]) {
  const source = fakeSource(key);
  source.changesBetween.mockResolvedValue(files);
  const unfinishedMerge = vi.fn(async (): Promise<UnfinishedMerge | null> => merge);
  const settle = async () => { unfinishedMerge.mockResolvedValue(null); };
  const commitMerge = vi.fn(settle);
  const abortMerge = vi.fn(settle);
  Object.assign(source, { unfinishedMerge, commitMerge, abortMerge });
  return { source, commitMerge, abortMerge };
}

it("tells a merge's own changes from what it brought in, and commits it", async () => {
  const { source, commitMerge } = merging("merging", { mergeHead: "995514cb", name: "995514c", conflicted: [], changedHere: ["CHANGELOG.md"], incoming: ["src-tauri/src/worktree_control.rs", "src/lib/terminal.ts"] }, [
    { path: "CHANGELOG.md", status: "modified", additions: 21, deletions: 0 },
    { path: "src-tauri/src/worktree_control.rs", status: "added", additions: 317, deletions: 0 },
    { path: "src/lib/terminal.ts", status: "modified", additions: 18, deletions: 0 },
  ]);
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  const here = await screen.findByRole("region", { name: "Changed here" });
  expect(within(here).getAllByRole("button").map((row) => row.textContent)).toEqual([expect.stringContaining("CHANGELOG.md")]);
  expect(within(screen.getByRole("region", { name: "From 995514c" })).getAllByRole("button")).toHaveLength(2);
  const notice = screen.getByRole("status", { name: "Merge in progress" });
  expect(notice.textContent).toContain("Merging 995514c, not committed yet. 1 file changed here · 2 files from 995514c, as Git merged them.");

  fireEvent.click(within(notice).getByRole("button", { name: "Commit merge" }));
  await waitFor(() => expect(commitMerge).toHaveBeenCalledWith("995514cb"));
  await waitFor(() => expect(screen.queryByRole("status", { name: "Merge in progress" })).toBeNull());
  expect(screen.queryByRole("region", { name: "Changed here" })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it("aborts a merge only once the person confirms what it loses, and never commits one still in conflict", async () => {
  const { source, commitMerge, abortMerge } = merging("aborting", { mergeHead: "abc1234", name: "main", conflicted: ["a.txt"], changedHere: ["notes.txt"], incoming: ["b.txt"] }, [
    { path: "a.txt", status: "modified", additions: 3, deletions: 1 },
    { path: "b.txt", status: "added", additions: 1, deletions: 0 },
    { path: "notes.txt", status: "added", additions: 1, deletions: 0 },
  ]);
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  const notice = await screen.findByRole("status", { name: "Merge in progress" });
  expect(notice.textContent).toContain("1 file still in conflict · 1 file changed here · 1 file from main, as Git merged it. Resolve the conflicts to commit it.");
  expect((within(notice).getByRole("button", { name: "Commit merge" }) as HTMLButtonElement).disabled).toBe(true);
  // All changes also holds the branch's own commits: not sorted by the merge.
  expect(screen.queryByRole("region", { name: "From main" })).toBeNull();

  fireEvent.click(within(notice).getByRole("button", { name: "Abort merge" }));
  await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  expect(ask.mock.calls[0][0]).toContain("1 file resolved, changed or added by hand and 1 file still in conflict in this merge will be lost. main keeps its own changes.");
  expect(abortMerge).not.toHaveBeenCalled();

  ask.mockResolvedValue(true);
  abortMerge.mockRejectedValueOnce("A different merge is in progress now");
  fireEvent.click(within(notice).getByRole("button", { name: "Abort merge" }));
  expect((await within(notice).findByRole("alert")).textContent).toBe("source: A different merge is in progress now");
  fireEvent.click(within(notice).getByRole("button", { name: "Abort merge" }));
  await waitFor(() => expect(abortMerge).toHaveBeenLastCalledWith("abc1234"));
  await waitFor(() => expect(screen.queryByRole("status", { name: "Merge in progress" })).toBeNull());
  expect(commitMerge).not.toHaveBeenCalled();
});

it("shows no merge for a source that cannot read one", async () => {
  const source = fakeSource("no-merge-capability");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} onViewUncommitted={() => {}} />);
  await screen.findByRole("button", { name: /turn.ts/ });
  expect(screen.queryByRole("status", { name: "Merge in progress" })).toBeNull();
});

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
