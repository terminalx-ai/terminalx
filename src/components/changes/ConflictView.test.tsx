import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitSource } from "@/lib/gitSource";
import type { FileSource } from "@/lib/workspaceFiles";
import type { ConflictChoice, ConflictFile, ConflictSegment, UnfinishedMerge } from "@/types/session";

const { invoke, sessions, patchTab } = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, _args?: unknown) => {
    if (command === "send_message") return { events: [], queued: false };
    throw new Error(`The conflict view called ${command}`);
  }),
  sessions: { value: [] as unknown[] },
  patchTab: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/sessions", async (original) => ({ ...(await original<typeof import("@/lib/sessions")>()), useSessionStore: () => ({ sessions: sessions.value }), patchTab }));

const { ConflictView, COMBINE_SENDS } = await import("./ConflictView");
const { dropEditors, getEditors, openConflict } = await import("@/lib/editors");

const HEAD = "1111111111111111111111111111111111111111";
const THEIRS = "5555555555555555555555555555555555555555";
const PATH = "apps/api/src/billing/seats.ts";
const NOW = Math.floor(Date.now() / 1000);

const merge: UnfinishedMerge = {
  head: HEAD, mergeHead: THEIRS, names: ["origin/main"], incoming: 3, conflicted: [PATH], changedHere: [], fromBase: [],
  branch: "raccoon/teams-billing", conflictCounts: { [PATH]: 2 },
};

/**
 * seats.ts as on disk: three lines, a conflict at line 4 (two lines each side,
 * theirs from line 8), line 11, a conflict at line 12, then the end. Shown with
 * the markers gone and yours kept, that is lines 1–3, the conflict at 4, line 6
 * and the second conflict at 7.
 */
function file(version: string, left: ("first" | "second")[] = ["first", "second"]): ConflictFile {
  const segments: ConflictSegment[] = [{ kind: "text", text: "import { priceFor } from \"./prices\";\n\nexport function prorate() {\n" }];
  let line = 4;
  let index = 0;
  if (left.includes("first")) {
    segments.push({ kind: "conflict", hunk: { index: index++, line, ours: "  const unit = pricePerSeat;\n  return unit;\n", theirs: "  const unit = priceFor(plan);\n  return roundCents(unit);\n", base: null } });
    line += 7;
  } else {
    segments.push({ kind: "text", text: "  const unit = priceFor(plan);\n  return roundCents(unit);\n" });
    line += 2;
  }
  segments.push({ kind: "text", text: "}\n" });
  line += 1;
  if (left.includes("second")) segments.push({ kind: "conflict", hunk: { index: index++, line, ours: "  return seats;\n", theirs: "  return seatsFor(change);\n", base: null } });
  else segments.push({ kind: "text", text: "  return seatsFor(change);\n" });
  return {
    path: PATH, version, segments, conflicts: index, unsupported: null,
    ours: { branch: "raccoon/teams-billing", commit: { id: "a1", subject: "Seat deltas", author: "Paresh", time: NOW - 2 * 3600, pr: null } },
    theirs: { branch: "origin/main", commit: { id: "b2", subject: "Multi-currency prices", author: "Aisha", time: NOW - 86400, pr: 209 } },
  };
}

function fakeSource(first: ConflictFile) {
  let disk = first;
  const source = {
    key: "local:/repo", cloud: false, canWrite: true,
    unfinishedMerge: vi.fn(async () => merge),
    conflictFile: vi.fn(async () => disk),
    resolveConflict: vi.fn(async (_merge: UnfinishedMerge, _file: ConflictFile, _index: number, _choice: ConflictChoice): Promise<ConflictFile> => { throw new Error("unset"); }),
    markResolved: vi.fn(async () => {}),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    /** What the next read finds on disk. */
    setDisk: (next: ConflictFile) => { disk = next; },
  };
  return source;
}

function fakeFiles() {
  const listeners = new Set<(paths: string[] | null) => void>();
  const files = {
    kind: "local",
    stat: vi.fn(async () => ({ version: "1" })),
    watch: (listener: (paths: string[] | null) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: (paths: string[] | null) => { for (const listener of listeners) listener(paths); },
  };
  return files;
}

function show(source: ReturnType<typeof fakeSource>, files = fakeFiles(), sessionId = "s1") {
  const id = openConflict(sessionId, "/repo", PATH, merge, 2);
  const entry = getEditors().editors.find((e) => e.id === id);
  if (entry?.kind !== "conflict") throw new Error("no conflict tab");
  render(<ConflictView entry={entry} visible source={source as unknown as GitSource} files={files as unknown as FileSource} />);
  return { id, files };
}

const tabName = (id: string) => getEditors().editors.find((e) => e.id === id)?.name;

beforeEach(() => { sessions.value = [{ id: "s1", activeTab: "t1", tabs: [{ id: "t1", front: "chat" }] }]; });
afterEach(() => { cleanup(); dropEditors(() => true); invoke.mockClear(); patchTab.mockClear(); });

it("shows the path, which branch goes into which, both sides of each conflict and Conflict x of N", async () => {
  const source = fakeSource(file("v1"));
  show(source);
  expect(await screen.findByText("Conflict 1 of 2")).toBeTruthy();
  expect(screen.getByText(PATH)).toBeTruthy();
  expect(screen.getByText("origin/main into raccoon/teams-billing")).toBeTruthy();
  const first = within(screen.getByRole("group", { name: "Conflict 1 of 2, line 4" }));
  expect(first.getByText("raccoon/teams-billing · 2h ago")).toBeTruthy();
  expect(first.getByText("origin/main · #209 Multi-currency prices · Aisha")).toBeTruthy();
  // Numbered as the file reads once resolved with yours kept: both sides from 4, the text after from 6.
  expect(within(first.getByRole("region", { name: "Yours" })).getAllByText(/^[45]$/).map((n) => n.textContent)).toEqual(["4", "5"]);
  expect(within(first.getByRole("region", { name: "Theirs" })).getAllByText(/^[45]$/).map((n) => n.textContent)).toEqual(["4", "5"]);
  expect(screen.getByText("6")).toBeTruthy();
  expect(first.getByRole("button", { name: "Keep yours" }) && first.getByRole("button", { name: "Keep theirs" }) && first.getByRole("button", { name: "Keep both" })).toBeTruthy();
  expect(first.getByText(COMBINE_SENDS)).toBeTruthy();
  // The other conflict shows both sides but acts only once it is the current one.
  const second = within(screen.getByRole("group", { name: "Conflict 2 of 2, line 7" }));
  expect(second.queryByRole("button", { name: "Keep yours" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next conflict" }));
  expect(screen.getByText("Conflict 2 of 2")).toBeTruthy();
  expect(second.getByRole("button", { name: "Keep yours" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Next conflict" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous conflict" }));
  expect(screen.getByText("Conflict 1 of 2")).toBeTruthy();
});

for (const [label, choice] of [["Keep yours", "ours"], ["Keep theirs", "theirs"], ["Keep both", "both"]] as const) {
  it(`${label} writes that conflict with "${choice}", shows the file returned, and the tab counts what is left`, async () => {
    const source = fakeSource(file("v1"));
    const after = file("v2", ["first"]);
    source.resolveConflict.mockResolvedValueOnce(after);
    const { id } = show(source);
    await screen.findByText("Conflict 1 of 2");
    expect(tabName(id)).toBe("seats.ts · 2 conflicts");
    fireEvent.click(screen.getByRole("button", { name: "Next conflict" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Conflict 2 of 2, line 7" })).getByRole("button", { name: label }));
    await screen.findByText("Conflict 1 of 1");
    expect(source.resolveConflict).toHaveBeenCalledTimes(1);
    const [m, f, index, chosen] = source.resolveConflict.mock.calls[0];
    expect([m, f.version, index, chosen]).toEqual([merge, "v1", 1, choice]);
    expect(screen.getByText("  return seatsFor(change);", { normalizer: (text) => text })).toBeTruthy();
    expect(screen.queryByRole("group", { name: /line 7/ })).toBeNull();
    expect(tabName(id)).toBe("seats.ts · 1 conflict");
  });
}

it("enables Mark resolved only once no conflict is left, stages the latest version, then has Changes read the merge again", async () => {
  const source = fakeSource(file("v1", ["first"]));
  source.resolveConflict.mockResolvedValueOnce(file("v2", []));
  const { id } = show(source);
  await screen.findByText("Conflict 1 of 1");
  const mark = () => screen.getByRole("button", { name: "Mark resolved" }) as HTMLButtonElement;
  expect(mark().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep theirs" }));
  await screen.findByText("No conflicts left");
  expect(tabName(id)).toBe("seats.ts · 0 conflicts");
  expect(mark().disabled).toBe(false);
  const changes = vi.fn();
  window.addEventListener("workspace-files-changed", changes);
  source.unfinishedMerge.mockResolvedValue({ ...merge, conflicted: [], changedHere: [PATH], conflictCounts: {} });
  fireEvent.click(mark());
  await screen.findByText(`${PATH} is resolved and staged. Commit the merge from Changes once every conflict is resolved.`);
  expect(source.markResolved).toHaveBeenCalledTimes(1);
  expect(source.markResolved.mock.calls[0]).toEqual([merge, expect.objectContaining({ version: "v2" })]);
  expect(changes).toHaveBeenCalled();
  window.removeEventListener("workspace-files-changed", changes);
});

it("keeps Mark resolved off for a file that cannot be resolved conflict by conflict", async () => {
  const source = fakeSource({ ...file("v1", []), segments: [], unsupported: "binary file" });
  show(source);
  expect(await screen.findByText(/This file cannot be resolved conflict by conflict: binary file/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Mark resolved" }) as HTMLButtonElement).disabled).toBe(true);
});

it("reads the file again when the watcher says it changed, and on focus", async () => {
  const source = fakeSource(file("v1"));
  const { files } = show(source);
  await screen.findByText("Conflict 1 of 2");
  const reads = source.conflictFile.mock.calls.length;
  source.setDisk(file("v2", ["second"]));
  act(() => files.emit(["other.ts"]));
  expect(source.conflictFile.mock.calls.length).toBe(reads);
  act(() => files.emit([PATH]));
  await screen.findByText("Conflict 1 of 1");
  expect(source.conflictFile.mock.calls.length).toBe(reads + 1);
  // The next write names the version read last.
  source.resolveConflict.mockResolvedValueOnce(file("v3", []));
  fireEvent.click(screen.getByRole("button", { name: "Keep yours" }));
  await screen.findByText("No conflicts left");
  expect(source.resolveConflict.mock.calls[0][1].version).toBe("v2");
  source.setDisk(file("v4", ["first"]));
  act(() => { window.dispatchEvent(new Event("focus")); });
  await screen.findByText("Conflict 1 of 1");
});

it("says why a stale write was refused, reads the file again and never writes with the old version", async () => {
  const source = fakeSource(file("v1"));
  show(source);
  await screen.findByText("Conflict 1 of 2");
  // The file changed on disk without a watcher event reaching the view yet.
  source.setDisk(file("v2", ["second"]));
  source.resolveConflict.mockRejectedValueOnce(new Error("seats.ts changed since it was read. Read it again before resolving."));
  fireEvent.click(screen.getByRole("button", { name: "Keep yours" }));
  expect((await screen.findByRole("alert")).textContent).toBe("seats.ts changed since it was read. Read it again before resolving.");
  await screen.findByText("Conflict 1 of 1");
  source.resolveConflict.mockResolvedValueOnce(file("v3", []));
  fireEvent.click(screen.getByRole("button", { name: "Keep theirs" }));
  await screen.findByText("No conflicts left");
  expect(source.resolveConflict.mock.calls.map(([, f, index, choice]) => [f.version, index, choice])).toEqual([["v1", 0, "ours"], ["v2", 0, "theirs"]]);
});

it("asks the agent tab to combine just the current conflict, naming the file, the conflict and its line", async () => {
  const source = fakeSource(file("v1"));
  show(source);
  await screen.findByText("Conflict 1 of 2");
  fireEvent.click(screen.getByRole("button", { name: "Next conflict" }));
  fireEvent.click(screen.getByRole("button", { name: "Ask the agent to combine them" }));
  expect(await screen.findByText("Conflict 2 sent to the agent tab.")).toBeTruthy();
  const [, args] = invoke.mock.calls.find(([command]) => command === "send_message") as unknown as [string, { sessionId: string; tabId: string; text: string }];
  expect(args).toMatchObject({ sessionId: "s1", tabId: "t1" });
  expect(args.text).toContain(`the file "${PATH}"`);
  expect(args.text).toContain("conflict 2 of 2, the one whose <<<<<<< marker is on line 12");
  expect(args.text).toContain('"origin/main" into "raccoon/teams-billing"');
  expect(args.text).toContain("leave the conflict markers and text of every other conflict");
  expect(args.text).toContain("Do not stage the file");
  expect(patchTab).toHaveBeenCalledWith("s1", "t1", { status: "in_progress" });
  expect(source.resolveConflict).not.toHaveBeenCalled();
});

it("says why the agent cannot be asked when the workspace has no agent tab", async () => {
  sessions.value = [];
  const source = fakeSource(file("v1"));
  show(source, fakeFiles(), "checkout:/repo");
  await screen.findByText("Conflict 1 of 2");
  expect((screen.getByRole("button", { name: "Ask the agent to combine them" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Open an agent tab in this workspace to ask the agent.")).toBeTruthy();
});

it("says the merge is over when the one the tab was opened for is no longer in progress", async () => {
  const source = fakeSource(file("v1"));
  source.unfinishedMerge.mockResolvedValue({ ...merge, mergeHead: "9".repeat(40) });
  show(source);
  expect(await screen.findByText(/no longer in progress/)).toBeTruthy();
  expect(source.conflictFile).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Keep yours" })).toBeNull());
});
