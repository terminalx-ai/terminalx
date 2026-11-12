import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { dropEditors, getEditors } from "@/lib/editors";
import type { GitSource } from "@/lib/gitSource";
import type { CommitInfo } from "@/types/session";
import type { AgentEvent } from "@/types/events";

const { invoke, sessions, patchTab } = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, _args?: unknown) => {
    if (command === "send_message") return { events: [], queued: false };
    throw new Error(`A source-backed panel called ${command}`);
  }),
  sessions: { value: [] as unknown[] },
  patchTab: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/sessions", async (original) => ({ ...(await original<typeof import("@/lib/sessions")>()), useSessionStore: () => ({ sessions: sessions.value }), patchTab }));
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

afterEach(() => { cleanup(); localStorage.clear(); invoke.mockClear(); patchTab.mockClear(); sessions.value = []; });

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

// ---- a merge left in progress (#736, PRO-293) --------------------------------

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "5555555555555555555555555555555555555555";
const mergeFiles = [
  { path: "CHANGELOG.md", status: "modified" as const, additions: 3, deletions: 1 },
  { path: "notes.txt", status: "added" as const, additions: 1, deletions: 0 },
  { path: "src/a.rs", status: "added" as const, additions: 40, deletions: 0 },
  { path: "src/b.rs", status: "modified" as const, additions: 12, deletions: 4 },
  { path: "src/late.rs", status: "added" as const, additions: 2, deletions: 0 },
];

/** A local checkout part way through merging origin/main: conflicts left, one file edited while merging, two as Git merged them. */
function merging(key: string, conflicted = ["CHANGELOG.md"], counts: Record<string, number> = { "CHANGELOG.md": 2 }) {
  const source = fakeSource(key);
  source.cloud = false;
  source.canWrite = true;
  source.changesBetween.mockResolvedValue(mergeFiles);
  const merge = { head: HEAD, mergeHead: BASE, names: ["origin/main", "main"], incoming: 14, conflicted, changedHere: ["notes.txt", ...(conflicted.length ? [] : ["CHANGELOG.md"])], fromBase: ["src/a.rs", "src/b.rs"],
    branch: "raccoon/teams-billing", conflictCounts: Object.fromEntries(conflicted.map((path) => [path, counts[path] ?? 1])) };
  return Object.assign(source, {
    unfinishedMerge: vi.fn(async () => merge),
    commitMerge: vi.fn(async () => {}),
    abortMerge: vi.fn(async () => {}),
    conflictFile: vi.fn(async () => { throw new Error("unused"); }),
    resolveConflict: vi.fn(async () => { throw new Error("unused"); }),
    markResolved: vi.fn(async () => {}),
    merge,
  });
}

it("lists unresolved files with their conflict counts apart from what the merge brought in, and says what aborting keeps", async () => {
  const source = merging("merge-split", ["CHANGELOG.md", "src/deep/seats.ts"], { "CHANGELOG.md": 2, "src/deep/seats.ts": 1 });
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  expect(within(banner).getByText("Merge in progress")).toBeTruthy();
  expect(within(banner).getByText("origin/main → raccoon/teams-billing")).toBeTruthy();
  expect(within(banner).getByText("Resolve the conflicts and stage them to commit the merge, or ask the agent to do it.")).toBeTruthy();
  const unresolved = within(await screen.findByRole("region", { name: "Unresolved conflicts" }));
  expect(screen.getByText("Unresolved conflicts · 2")).toBeTruthy();
  const rows = unresolved.getAllByTitle(/^Unresolved · /).map((row) => row.textContent);
  expect(rows).toEqual(["UCHANGELOG.md2 conflicts", "Useats.tssrc/deep1 conflict"]);
  // A file the merge was read without (src/late.rs) is never claimed for the base.
  expect(screen.getByText("Changed here · 2")).toBeTruthy();
  const here = within(screen.getByRole("region", { name: "Changed here" }));
  expect(here.getByText("notes.txt") && here.getByText("late.rs")).toBeTruthy();
  expect(screen.getByText("Brought in by the merge · 2")).toBeTruthy();
  const base = within(screen.getByRole("region", { name: "Brought in by the merge" }));
  expect(base.getAllByTitle(/·/).map((row) => row.title)).toEqual(["Added · src/a.rs", "Modified · src/b.rs"]);
  expect(base.getByText("+40") && base.getByText("−4")).toBeTruthy();
  expect(base.queryByText("CHANGELOG.md")).toBeNull();
  expect(screen.getByText("Aborting puts the branch back at 1111111 and keeps your uncommitted work.")).toBeTruthy();
  // Conflicts left: ask the agent or abort; nothing is committed.
  expect(within(banner).getByRole("button", { name: "Ask the agent to resolve" })).toBeTruthy();
  expect(within(banner).getByRole("button", { name: "Abort merge…" })).toBeTruthy();
  expect(within(banner).queryByRole("button", { name: "Commit merge" })).toBeNull();
  expect(source.commitMerge).not.toHaveBeenCalled();
});

it("enables Commit merge once no conflict remains, commits the merge that was read, and says why if it cannot", async () => {
  const source = merging("merge-commit", []);
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  expect(screen.queryByRole("region", { name: "Unresolved conflicts" })).toBeNull();
  expect(within(banner).queryByRole("button", { name: "Ask the agent to resolve" })).toBeNull();
  const commit = within(banner).getByRole("button", { name: "Commit merge" }) as HTMLButtonElement;
  expect(commit.disabled).toBe(false);
  expect(within(banner).getByRole("button", { name: "Abort merge…" })).toBeTruthy();
  source.commitMerge.mockRejectedValueOnce("HEAD moved since the merge was read");
  fireEvent.click(commit);
  expect(await within(banner).findByRole("alert")).toHaveProperty("textContent", "source: HEAD moved since the merge was read");
  const reads = source.unfinishedMerge.mock.calls.length;
  source.unfinishedMerge.mockResolvedValue(null as never);
  fireEvent.click(within(banner).getByRole("button", { name: "Commit merge" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Merge in progress" })).toBeNull());
  expect(source.commitMerge).toHaveBeenLastCalledWith(source.merge);
  expect(source.unfinishedMerge.mock.calls.length).toBeGreaterThan(reads);
  expect(source.abortMerge).not.toHaveBeenCalled();
});

it("keeps Commit merge, disabled, for a source that cannot resolve conflicts in the app", async () => {
  const source = merging("merge-no-resolve");
  delete (source as Partial<typeof source>).conflictFile;
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  expect(within(banner).getByText("Resolve the conflicts and stage them to commit the merge.")).toBeTruthy();
  expect(within(banner).queryByRole("button", { name: "Ask the agent to resolve" })).toBeNull();
  expect((within(banner).getByRole("button", { name: "Commit merge" }) as HTMLButtonElement).disabled).toBe(true);
  // Its conflicted rows open nothing.
  expect(within(screen.getByRole("region", { name: "Unresolved conflicts" })).queryByRole("button")).toBeNull();
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

it("says what is being merged in every scope, with the merge's own uncommitted lists beside All changes", async () => {
  const source = merging("merge-all");
  vi.mocked(source.reviewRange).mockImplementation(async (target: string | null, uncommitted: boolean) => ({ target: uncommitted ? "HEAD" : target ?? "main", base: uncommitted ? "work-head" : "merge-base", head: uncommitted ? "work" : "snapshot" }));
  source.changesBetween.mockImplementation(async (base: string) => base === "work-head" ? mergeFiles.slice(0, 3) : mergeFiles);
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  expect(within(banner).getByText(/Until it is committed, this counts what the merge brings in as the branch's own work/)).toBeTruthy();
  expect(await screen.findByText("All changes · 5 files")).toBeTruthy();
  // The merge's lists are what is uncommitted, read against HEAD.
  expect(await screen.findByText("Brought in by the merge · 1")).toBeTruthy();
  expect(source.changesBetween).toHaveBeenCalledWith("work-head", "work", false);
});

it("asks the agent tab to resolve every conflicted file, with each file's count, and to stage without committing", async () => {
  sessions.value = [{ id: "s1", activeTab: "t1", tabs: [{ id: "t1", front: "chat" }] }];
  const source = merging("merge-ask", ["CHANGELOG.md", "src/deep/seats.ts"], { "CHANGELOG.md": 2, "src/deep/seats.ts": 1 });
  render(<ChangesPanel source={source} sessionId="s1" events={[]} version={0} active live={false} />);
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  fireEvent.click(within(banner).getByRole("button", { name: "Ask the agent to resolve" }));
  expect(await within(banner).findByText("Sent to the agent tab.")).toBeTruthy();
  const send = invoke.mock.calls.find(([command]) => command === "send_message") as unknown as [string, { sessionId: string; tabId: string; text: string }];
  expect(send[1]).toMatchObject({ sessionId: "s1", tabId: "t1" });
  expect(send[1].text).toContain('- "CHANGELOG.md": 2 conflicts');
  expect(send[1].text).toContain('- "src/deep/seats.ts": 1 conflict');
  expect(send[1].text).toContain('"origin/main" into "raccoon/teams-billing"');
  expect(send[1].text).toContain("keeping the intent of both sides");
  expect(send[1].text).toContain("Stage each file once it is resolved");
  expect(send[1].text).toContain("Do not commit the merge");
  expect(patchTab).toHaveBeenCalledWith("s1", "t1", { status: "in_progress" });
});

it("says why the agent cannot be asked without an agent tab", async () => {
  const source = merging("merge-no-agent");
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  const banner = await screen.findByRole("region", { name: "Merge in progress" });
  expect((within(banner).getByRole("button", { name: "Ask the agent to resolve" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(banner).getByText("Open an agent tab in this workspace to ask the agent.")).toBeTruthy();
});

it("opens a conflicted file in a centre conflict tab from its row", async () => {
  const source = merging("local:/merge-repo", ["src/deep/seats.ts"], { "src/deep/seats.ts": 2 });
  render(<ChangesPanel source={source} cwd="/merge-repo" sessionId="centre-conflict" events={[]} version={0} active live={false} />);
  fireEvent.click(await screen.findByTitle("Unresolved · src/deep/seats.ts"));
  expect(getEditors().editors.find((e) => e.sessionId === "centre-conflict")).toMatchObject({
    kind: "conflict", rel: "src/deep/seats.ts", name: "seats.ts · 2 conflicts", conflict: { head: HEAD, mergeHead: BASE, conflicts: 2 },
  });
  dropEditors((e) => e.sessionId === "centre-conflict");
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

it("opens local Changes rows in centre tabs with the chosen range and rename path", async () => {
  const source = fakeSource("local:/repo");
  source.cloud = false;
  source.changesBetween.mockResolvedValue([{ path: "new.ts", oldPath: "old.ts", status: "renamed", additions: 1, deletions: 1 }]);
  render(<ChangesPanel source={source} cwd="/repo" sessionId="centre" events={[]} version={0} active live={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /new.ts/ }));
  expect(getEditors().editors.find((e) => e.sessionId === "centre")).toMatchObject({
    kind: "diff", rel: "new.ts", name: "new.ts · All changes", diff: { range: { base: "merge-base", head: "snapshot" }, oldPath: "old.ts" },
  });
  expect(screen.queryByTestId("diff")).toBeNull();
  expect(source.fileContentsAt).not.toHaveBeenCalled();
  dropEditors((e) => e.sessionId === "centre");
});

// A local row opens its diff in a centre tab (PRO-218), whose header carries the same Discard (EditorSplit.test).
it("discards from the list against the displayed base and opens the row's diff in a centre tab", async () => {
  const source = fakeSource("local:discard");
  source.cloud = false;
  source.canWrite = true;
  source.discard = vi.fn().mockResolvedValue(undefined);
  render(<ChangesPanel source={source} sessionId="discard" events={events} version={2} active live={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes to src/turn.ts" }));
  expect(source.discard).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes to src/turn.ts" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(source.discard).toHaveBeenCalledWith("src/turn.ts", "merge-base", undefined));
  expect(document.querySelector("button button")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Modified.*turn.ts/ }));
  expect(getEditors().editors.find((e) => e.sessionId === "discard")).toMatchObject({ kind: "diff", rel: "src/turn.ts", diff: { scope: "all" } });
  expect(screen.queryByTestId("diff")).toBeNull();
  dropEditors((e) => e.sessionId === "discard");
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
  fireEvent.click(within(dialog).getByRole("button", { name: /^Discard$/ }));
  await waitFor(() => expect(source.discard).toHaveBeenCalledWith("edited.ts", "merge-base", undefined));
  await screen.findByText("All changes · 0 files");
});
