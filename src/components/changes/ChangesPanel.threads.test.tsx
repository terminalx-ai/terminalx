import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitSource } from "@/lib/gitSource";
import { saveChangesChoice } from "@/lib/changesScope";
import { reviewSnapshot as snapshot, reviewThread as thread } from "@/test/reviewThreads";
import { requestThreadJump, type ReviewThreadAccess } from "@/lib/reviewThreads";

const { invoke, openDiff } = vi.hoisted(() => ({ invoke: vi.fn(async (command: string) => { throw new Error(`unexpected ${command}`); }), openDiff: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/editors", async (original) => ({ ...(await original<typeof import("@/lib/editors")>()), openDiff }));
vi.mock("@/lib/sessions", async (original) => ({ ...(await original<typeof import("@/lib/sessions")>()), useSessionStore: () => ({ sessions: [{ id: "s", activeTab: "tab" }] }) }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
const { ChangesPanel } = await import("./ChangesPanel");

// The thread's recorded code sits on line 42 of the branch's version of the file.
const lines = (changed: string) => [...Array.from({ length: 39 }, (_, i) => `line ${i + 1}`), "context", changed, "const token = legacy.token;", "return token;"].join("\n");
const pr = { url: snapshot.url, number: 14, state: "OPEN", title: "Login", head: "feature" };
let n = 0;
let read: ReturnType<typeof vi.fn>;

/** A session with a PR whose PR panel has never been opened: only the Changes view asks. */
function fakeSource(key: string, cloud: boolean, files = [{ path: "src/other.ts", status: "modified", additions: 1, deletions: 0 }, { path: thread.path, status: "modified", additions: 3, deletions: 1 }]) {
  read = vi.fn(async () => ({ ...snapshot, threads: [thread, { ...thread, id: "thread-2", isResolved: true }, { ...thread, id: "thread-3", isResolved: true }] }));
  const access = { read, file: vi.fn(), resolve: vi.fn(), reply: vi.fn() } as ReviewThreadAccess;
  return {
    key, cloud, canWrite: true,
    workStatus: vi.fn(async () => ({ branch: "feature", defaultBranch: "main" })),
    prs: vi.fn(async (branch: string) => branch === "feature" ? [pr] : []),
    prAssociations: vi.fn(async () => ({ associations: [], discoveryOnly: true })),
    reviewThreads: vi.fn(() => access),
    reviewRange: vi.fn(async (_target: string | null, uncommitted: boolean) => ({ target: "main", base: uncommitted ? "head" : "merge-base", head: "snapshot" })),
    changesBetween: vi.fn(async (base: string) => base === "head" ? [] : files),
    fileContentsAt: vi.fn(async () => ({ before: lines("old"), after: lines("new") })),
    branches: vi.fn(async () => []),
    errorMessage: String,
  } as unknown as GitSource;
}

beforeEach(() => { openDiff.mockClear(); });
afterEach(() => { cleanup(); localStorage.clear(); });

it("finds the session's PR itself and shows its threads inline and in the footer, with no PR panel", async () => {
  const source = fakeSource(`cloud:alone-${++n}|repo`, true);
  render(<ChangesPanel source={source} sessionId="s" events={[]} version={0} active live={false} />);
  expect((await screen.findByTestId("changes-review-threads")).textContent).toBe("PR #14 review threads1 open · 2 resolved");
  expect(source.prs).toHaveBeenCalledWith("feature");
  expect(source.reviewThreads).toHaveBeenCalledWith(snapshot.url);
  expect(read).toHaveBeenCalledTimes(1);

  fireEvent.click(await screen.findByRole("button", { name: /login.ts/ }));
  const card = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.diff-pane article[data-review-thread="thread-1"]');
    expect(el).not.toBeNull(); return el!;
  });
  // Drawn by the shared line-comment widget right after the line the thread is on.
  expect(card.parentElement!.parentElement!.previousElementSibling?.textContent).toContain("const token = legacy.token;");
  expect(within(card).getByText("on GitHub · line 42")).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Send to agent" })).toBeTruthy();
});

it("shows nothing about review threads when the branch has no PR", async () => {
  const source = fakeSource(`cloud:none-${++n}|repo`, true);
  vi.mocked(source.prs).mockResolvedValue([]);
  render(<ChangesPanel source={source} sessionId="s" events={[]} version={0} active live={false} />);
  await screen.findByRole("button", { name: /login.ts/ });
  await waitFor(() => expect(source.prs).toHaveBeenCalled());
  expect(screen.queryByTestId("changes-review-threads")).toBeNull();
  expect(source.reviewThreads).not.toHaveBeenCalled();
});

it("opens the thread's file when its Checks row is chosen, and says so when no change has it", async () => {
  const source = fakeSource(`cloud:jump-${++n}|repo`, true);
  render(<ChangesPanel source={source} sessionId="s" events={[]} version={0} active live={false} />);
  await screen.findByTestId("changes-review-threads");
  await screen.findByRole("button", { name: /login.ts/ });
  expect(await requestThreadJump(source.key, thread)).toBe(true);
  await waitFor(() => expect(document.querySelector('.diff-pane article[data-review-thread="thread-1"]')).not.toBeNull());
  expect(await requestThreadJump(source.key, { ...thread, path: "gone.ts" })).toBe(false);
});

it("loads All changes first when the list shown does not have the thread's file, then opens it", async () => {
  const source = fakeSource(`cloud:later-${++n}|repo`, true);
  saveChangesChoice(source.key, { scope: "turn", target: null, commit: null });
  render(<ChangesPanel source={source} sessionId="s" events={[]} version={0} active live={false} />);
  await screen.findByTestId("changes-review-threads");
  await screen.findByText(/No turn snapshots are available/);
  expect(await requestThreadJump(source.key, thread)).toBe(true);
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Changes scope" }) as HTMLSelectElement).value).toBe("all"));
  await waitFor(() => expect(document.querySelector('.diff-pane article[data-review-thread="thread-1"]')).not.toBeNull());
});

it("opens a local checkout's thread in its centre diff tab, even before its list has loaded it", async () => {
  const root = `/jump-local-${++n}`;
  const source = fakeSource(`local:${root}`, false);
  saveChangesChoice(source.key, { scope: "turn", target: null, commit: null });
  render(<ChangesPanel source={source} cwd={root} sessionId="s" events={[]} version={0} active live={false} />);
  await screen.findByTestId("changes-review-threads");
  await screen.findByText(/No turn snapshots are available/);
  expect(await requestThreadJump(source.key, thread)).toBe(true);
  expect(openDiff).toHaveBeenCalledWith("s", root, thread.path, expect.objectContaining({ scope: "all", range: { base: "merge-base", head: "snapshot" }, uncommitted: false }));
});
