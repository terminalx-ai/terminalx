import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitSource } from "@/lib/gitSource";
import type { CommitInfo } from "@/types/session";
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
    logCommits: vi.fn(async () => []),
    branches: vi.fn(async () => [{ name: "main", current: false, remote: false }, { name: "origin/release", current: false, remote: true }]),
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
  render(<ChangesPanel source={source} events={events} version={2} active live={false} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "turn" } });
  fireEvent.click(await screen.findByRole("button", { name: /turn.ts/ }));
  expect((await screen.findByTestId("diff")).textContent).toBe("src/turn.ts:old->new");
  expect(source.changesBetween).toHaveBeenCalledWith("base-tree", "head-tree", false);
  expect(source.fileContentsAt).toHaveBeenCalledWith("src/turn.ts", "base-tree", "head-tree");
  expect(invoke).not.toHaveBeenCalled();
});

it("shows the source's working tree against its head", async () => {
  const source = fakeSource("cloud:w2|repo");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} workingTree />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  fireEvent.click(await screen.findByRole("button", { name: /dirty.ts/ }));
  await waitFor(() => expect(source.fileContentsAt).toHaveBeenCalledWith("dirty.ts", "work-head", null));
  expect(invoke).not.toHaveBeenCalled();
});

it("reports a failed workspace diff in the source's words", async () => {
  const source = fakeSource("cloud:w3|repo");
  source.changesBetween.mockRejectedValueOnce("offline");
  render(<ChangesPanel source={source} events={events} version={2} active live={false} />);
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
    const props = { source, events, version: 2, active: true, live: false };
    const view = render(<ChangesPanel {...props} />);
    expect(await screen.findByText("All changes · 3 files")).toBeTruthy();
    expect(source.changesBetween).toHaveBeenLastCalledWith("merge-base", "snapshot", false);
    expect(screen.getByText(/Against main/)).toBeTruthy();
    view.rerender(<ChangesPanel {...props} events={[]} version={3} />);
    expect(source.changesBetween).toHaveBeenCalledTimes(1);
    expect(screen.getByText("All changes · 3 files")).toBeTruthy();
  });
}

it("persists explicit scope and target per repository across reopening", async () => {
  const source = fakeSource("remember");
  const props = { source, events, version: 2, active: true, live: false };
  const view = render(<ChangesPanel {...props} />);
  await screen.findByText(/Against main/);
  fireEvent.change(screen.getByLabelText("Comparison target"), { target: { value: "release" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText(/Against release/);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  await screen.findByRole("button", { name: /dirty.ts/ });
  view.unmount();
  const reopened = render(<ChangesPanel {...props} />);
  expect((screen.getByLabelText("Changes scope") as HTMLSelectElement).value).toBe("uncommitted");
  await screen.findByRole("button", { name: /dirty.ts/ });
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
  const props = { source, events: [], version: 0, active: true, live: false };
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
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /new/ }));
  expect((await screen.findByTestId("diff")).textContent).toBe("new:original->updated");
  fireEvent.click(screen.getByRole("button", { name: /new/ }));
  source.fileContentsAt.mockRejectedValueOnce("file unavailable");
  fireEvent.click(screen.getByRole("button", { name: /new/ }));
  await screen.findByText("source: file unavailable");
  expect(screen.queryByTestId("diff")).toBeNull();
});

it("refreshes after terminal edits, commits and branch changes on window focus", async () => {
  // The panel starts listening for focus in an effect that runs a task after
  // the file list is drawn; on a loaded CI runner a focus sent as soon as the
  // list shows can arrive before it, and nothing refreshes.
  const listens = vi.spyOn(window, "addEventListener");
  try {
    const source = fakeSource("refresh");
    render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
    await screen.findByRole("button", { name: /turn.ts/ });
    await waitFor(() => expect(listens).toHaveBeenCalledWith("focus", expect.any(Function)));
    source.changesBetween.mockResolvedValue([{ path: "terminal-edit", status: "added", additions: 1, deletions: 0 }]);
    fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: /terminal-edit/ });
    expect(source.reviewRange).toHaveBeenCalledTimes(2);
  } finally { listens.mockRestore(); }
});

it("does not reuse a previous turn when the latest prompt has no snapshot", async () => {
  const source = fakeSource("missing-latest");
  const latest: AgentEvent = { ...events[0], seq: 3, payload: { type: "user_message", text: "Status?", queued: false } };
  render(<ChangesPanel source={source} events={[...events, latest]} version={3} active live />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "turn" } });
  await screen.findByText(/No turn snapshots are available/);
  expect(screen.queryByText(/Last turn ·/)).toBeNull();
});

it("clears an invalid comparison and retries the same target on Apply", async () => {
  const source = fakeSource("invalid-target");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
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
    const view = render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
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
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
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
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
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
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
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
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  expect(within(banner).getByText(/Until it is committed, this counts what the merge brings in as the branch's own work/)).toBeTruthy();
  expect(screen.getByText("All changes · 5 files")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Changed here" })).toBeNull();
});

it("shows no merge for a source that cannot tell, and a merge that cannot be read in its words", async () => {
  const cloud = fakeSource("merge-cloud");
  render(<ChangesPanel source={cloud} events={[]} version={0} active live={false} />);
  await screen.findByRole("button", { name: /turn.ts/ });
  expect(screen.queryByRole("region", { name: "Merge in progress" })).toBeNull();
  cleanup();
  const local = merging("merge-unreadable");
  local.unfinishedMerge.mockRejectedValue("index.lock exists");
  render(<ChangesPanel source={local} events={[]} version={0} active live={false} />);
  expect((await screen.findByRole("alert")).textContent).toBe("Whether a merge is in progress could not be read: source: index.lock exists");
  expect(screen.getByText("All changes · 5 files")).toBeTruthy();
});


it("opens discard from the list and diff header and confirms against the displayed base", async () => {
  const source = fakeSource("local:discard");
  source.cloud = false;
  source.canWrite = true;
  source.discard = vi.fn().mockResolvedValue(undefined);
  render(<ChangesPanel source={source} events={events} version={2} active live={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes to src/turn.ts" }));
  expect(source.discard).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: /Modified.*turn.ts/ }));
  await screen.findByTestId("diff");
  const discardButtons = screen.getAllByRole("button", { name: "Discard changes to src/turn.ts" });
  expect(discardButtons).toHaveLength(2);
  fireEvent.click(discardButtons[1]);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(source.discard).toHaveBeenCalledWith("src/turn.ts", "merge-base", undefined));
  expect(document.querySelector("button button")).toBeNull();
});

it("refetches file statistics with the whitespace choice in every scope", async () => {
  const { setPrefs } = await import("@/lib/prefs");
  setPrefs({ diffHideWhitespace: false });
  const source = fakeSource("whitespace-stats");
  const view = render(<ChangesPanel source={source} events={events} version={2} active live={false} />);
  await screen.findByRole("button", { name: /turn.ts/ });
  fireEvent.click(screen.getByLabelText("Hide whitespace changes"));
  await waitFor(() => expect(source.changesBetween).toHaveBeenLastCalledWith("merge-base", "snapshot", true));
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "turn" } });
  await waitFor(() => expect(source.changesBetween).toHaveBeenLastCalledWith("base-tree", "head-tree", true));
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  await waitFor(() => expect(source.workingChanges).toHaveBeenLastCalledWith(true));
  view.unmount();
  setPrefs({ diffHideWhitespace: false });
});

const commitSha = "a".repeat(40), parentSha = "b".repeat(40);
const selectedCommit: CommitInfo = { sha: commitSha, parent: parentSha, tree: "commit-tree", shortSha: "aaaaaaa", subject: "A selected commit", body: "", author: "Author", email: "author@example.com", date: "2026-01-01T00:00:00Z" };

it("selects and restores a commit's exact range and returns to the saved workspace target", async () => {
  const source = fakeSource("commit-scope");
  vi.mocked(source.logCommits).mockImplementation(async (from) => from === parentSha ? [{ ...selectedCommit, sha: parentSha, parent: null, tree: "parent-tree" }] : [selectedCommit]);
  const props = { source, events, version: 2, active: true, live: false };
  const view = render(<ChangesPanel {...props} />);
  await screen.findByText(/Against main/);
  const target = screen.getByRole("combobox", { name: "Comparison target" });
  const suggestions = document.getElementById(target.getAttribute("list")!)!;
  expect([...suggestions.querySelectorAll("option")].map((option) => option.value)).toEqual(["main", "origin/release"]);
  fireEvent.change(target, { target: { value: "origin/release" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText(/Against origin\/release/);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "commit" } });
  await screen.findByText("Choose a commit to review its changes.");
  await screen.findByRole("option", { name: "aaaaaaa · A selected commit" });
  fireEvent.change(screen.getByLabelText("Commit to review"), { target: { value: commitSha } });
  await screen.findByText("Commit changes · 1 file");
  expect(source.changesBetween).toHaveBeenLastCalledWith("parent-tree", "commit-tree", false);
  fireEvent.click(screen.getByRole("button", { name: /turn.ts/ }));
  await screen.findByTestId("diff");
  expect(source.fileContentsAt).toHaveBeenLastCalledWith("src/turn.ts", "parent-tree", "commit-tree");
  view.unmount();
  render(<ChangesPanel {...props} />);
  expect(screen.getByLabelText("Changes scope")).toHaveProperty("value", "commit");
  await screen.findByText("Commit changes · 1 file");
  fireEvent.click(screen.getByRole("button", { name: "Back to all changes" }));
  await screen.findByText(/Against origin\/release/);
  expect(screen.getByLabelText("Comparison target")).toHaveProperty("value", "origin/release");
});

it("discards an in-flight commit response when the scope changes", async () => {
  const source = fakeSource("commit-race");
  let resolve!: (value: typeof selectedCommit[]) => void;
  vi.mocked(source.logCommits).mockImplementation((from) => from ? new Promise((done) => { resolve = done; }) : Promise.resolve([selectedCommit]));
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "commit" } });
  await screen.findByRole("option", { name: "aaaaaaa · A selected commit" });
  fireEvent.change(screen.getByLabelText("Commit to review"), { target: { value: commitSha } });
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Back to all changes" }));
  await screen.findByText(/Against main/);
  await act(async () => resolve([{ ...selectedCommit, parent: null }]));
  expect(screen.queryByText("Commit changes · 1 file")).toBeNull();
  expect(screen.getByText(/Against main/)).toBeTruthy();
});

it("refreshes viewed identities in Uncommitted after a terminal edit", async () => {
  const source = fakeSource("uncommitted-viewed");
  const dirty = { path: "dirty.ts", status: "modified", additions: 1, deletions: 0, blobHash: "old" };
  source.workingChanges.mockResolvedValue({ head: "work-head", files: [dirty] });
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  fireEvent.click(await screen.findByLabelText("Viewed dirty.ts"));
  expect(screen.getByText("1 of 1 viewed")).toBeTruthy();
  source.workingChanges.mockResolvedValue({ head: "work-head", files: [{ ...dirty, blobHash: "new" }] });
  // Wait for the refresh effect after the initial range resolves.
  await waitFor(() => expect(source.changesBetween).toHaveBeenCalledWith("work-head", "snapshot", false));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  fireEvent(window, new Event("focus"));
  await screen.findByText("Changed since viewed");
  expect(screen.getByLabelText("Viewed dirty.ts")).toHaveProperty("checked", false);
});

const retainedEvents: AgentEvent[] = [
  events[0],
  { ...events[1], id: "checkpoint-1", seq: 2, payload: { type: "turn_checkpoint", seq: 1, base: "first-base", head: "first-head" } },
  { ...events[1], seq: 3, payload: { ...events[1].payload, head: "first-head" } as AgentEvent["payload"] },
  { ...events[0], id: "prompt-2", seq: 4, payload: { type: "user_message", text: "Second turn", queued: false, baseline: "second-base" } },
  { ...events[1], id: "checkpoint-2", seq: 5, payload: { type: "turn_checkpoint", seq: 4, base: "second-base", head: "second-head" } },
  { ...events[1], id: "done-2", seq: 6, payload: { type: "turn_completed", status: "ok", head: "second-head", authFailed: false } },
];

it("reviews only an earlier checkpoint's files and lines, persists its selection, and keeps it out of other tabs", async () => {
  const source = fakeSource("retained-turns");
  source.cloud = false;
  source.canWrite = true;
  source.discard = vi.fn();
  source.changesBetween.mockImplementation(async (base) => [{ path: base === "first-base" ? "earlier.ts" : "latest.ts", status: "modified", additions: 1, deletions: 1, blobHash: base }]);
  source.fileContentsAt.mockImplementation(async (_path, base, head) => ({ before: base, after: head }));
  const props = { source, events: retainedEvents, version: 6, active: true, live: false };
  const view = render(<ChangesPanel {...props} />);
  const option = screen.getByRole("option", { name: "Turn · Go" }) as HTMLOptionElement;
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: option.value } });
  fireEvent.click(await screen.findByRole("button", { name: /earlier.ts/ }));
  expect((await screen.findByTestId("diff")).textContent).toBe("earlier.ts:first-base->first-head");
  expect(screen.queryByRole("button", { name: /latest.ts/ })).toBeNull();
  expect(source.changesBetween).toHaveBeenLastCalledWith("first-base", "first-head", false);
  expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
  view.unmount();
  const reopened = render(<ChangesPanel {...props} />);
  await screen.findByRole("button", { name: /earlier.ts/ });
  expect(screen.getByLabelText("Changes scope")).toHaveProperty("value", option.value);
  source.changesBetween.mockClear();
  reopened.rerender(<ChangesPanel {...props} events={retainedEvents.map((event) => ({ ...event, tabId: "other-tab" }))} version={7} />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: /earlier.ts/ })).toBeNull();
  expect(source.changesBetween).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back to all changes" }));
  await screen.findByText(/Against main/);
});

it("reports an expired earlier checkpoint without falling back to workspace lines", async () => {
  const source = fakeSource("expired-turn");
  source.changesBetween.mockImplementation(async (base) => {
    if (base === "first-base") throw new Error("checkpoint tree is unavailable");
    return [];
  });
  render(<ChangesPanel source={source} events={retainedEvents} version={6} active live={false} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: (screen.getByRole("option", { name: "Turn · Go" }) as HTMLOptionElement).value } });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "source: Error: checkpoint tree is unavailable");
  expect(source.changesBetween).toHaveBeenLastCalledWith("first-base", "first-head", false);
});

it("keeps the current discard dialog and Viewed controls together in All changes", async () => {
  const source = fakeSource("discard-with-viewed");
  source.cloud = false;
  source.canWrite = true;
  source.discard = vi.fn().mockResolvedValue(undefined);
  source.changesBetween.mockResolvedValue([{ path: "edited.ts", status: "modified", additions: 2, deletions: 1, blobHash: "before-discard" }]);
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  fireEvent.click(await screen.findByLabelText("Viewed edited.ts"));
  expect(screen.getByText("1 of 1 viewed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes to edited.ts" }));
  expect(source.discard).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  source.changesBetween.mockResolvedValue([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard", exact: true }));
  await waitFor(() => expect(source.discard).toHaveBeenCalledWith("edited.ts", "merge-base", undefined));
  await screen.findByText("All changes · 0 files");
});
