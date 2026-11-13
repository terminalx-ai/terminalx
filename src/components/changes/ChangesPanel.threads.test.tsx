import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitSource } from "@/lib/gitSource";
import { reviewSnapshot as snapshot, reviewThread as thread } from "@/test/reviewThreads";
import { registerReviewPr, requestThreadJump, type ReviewThreadAccess } from "@/lib/reviewThreads";

const { invoke, openDiff } = vi.hoisted(() => ({ invoke: vi.fn(async (command: string) => { throw new Error(`unexpected ${command}`); }), openDiff: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/editors", async (original) => ({ ...(await original<typeof import("@/lib/editors")>()), openDiff }));
vi.mock("@/lib/sessions", async (original) => ({ ...(await original<typeof import("@/lib/sessions")>()), useSessionStore: () => ({ sessions: [] }) }));
vi.mock("./DiffPane", () => ({ DiffPane: ({ path, workspace }: { path: string; workspace?: string }) => <pre data-testid="diff">{`${workspace}:${path}`}</pre> }));
const { ChangesPanel } = await import("./ChangesPanel");

let n = 0;
let stop: () => void;
const read = vi.fn();
function fakeSource(key: string, cloud: boolean): GitSource {
  return {
    key, cloud, canWrite: false,
    reviewRange: vi.fn(async () => ({ target: "main", base: "merge-base", head: "snapshot" })),
    changesBetween: vi.fn(async () => [{ path: "src/other.ts", status: "modified", additions: 1, deletions: 0 }, { path: thread.path, status: "modified", additions: 3, deletions: 1 }]),
    fileContentsAt: vi.fn(async () => ({ before: "old", after: "new" })),
    branches: vi.fn(async () => []),
    errorMessage: String,
  } as unknown as GitSource;
}
const register = (key: string) => registerReviewPr(key, { url: snapshot.url, number: 14, state: "OPEN", canWrite: true, errorMessage: String,
  access: { read, file: vi.fn(), resolve: vi.fn(), reply: vi.fn() } as ReviewThreadAccess });

beforeEach(() => {
  read.mockReset().mockResolvedValue({ ...snapshot, threads: [{ ...thread, isResolved: true }] });
  openDiff.mockClear();
});
afterEach(() => { cleanup(); stop(); localStorage.clear(); });

it("shows the PR's review thread counts in the Changes footer", async () => {
  const source = fakeSource(`cloud:threads-${++n}|repo`, true);
  stop = register(source.key);
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  expect((await screen.findByTestId("changes-review-threads")).textContent).toBe("PR #14 review threads0 open · 1 resolved");
  expect(read).toHaveBeenCalledTimes(1);
});

it("opens the thread's file when its Checks row is chosen, and says so when the file is not listed", async () => {
  const source = fakeSource(`cloud:jump-${++n}|repo`, true);
  stop = register(source.key);
  render(<ChangesPanel source={source} events={[]} version={0} active live={false} />);
  await screen.findByRole("button", { name: /login.ts/ });
  let handled = false;
  act(() => { handled = requestThreadJump(source.key, thread); });
  expect(handled).toBe(true);
  expect((await screen.findByTestId("diff")).textContent).toBe(`${source.key}:${thread.path}`);
  expect(requestThreadJump(source.key, { ...thread, path: "gone.ts" })).toBe(false);
});

it("opens a local checkout's thread in its centre diff tab", async () => {
  const root = `/jump-local-${++n}`;
  const source = fakeSource(`local:${root}`, false);
  stop = register(source.key);
  render(<ChangesPanel source={source} cwd={root} sessionId="s" events={[]} version={0} active live={false} />);
  await screen.findByRole("button", { name: /login.ts/ });
  let handled = false;
  act(() => { handled = requestThreadJump(source.key, thread); });
  expect(handled).toBe(true);
  await waitFor(() => expect(openDiff).toHaveBeenCalledWith("s", root, thread.path, expect.objectContaining({ scope: "all", range: expect.objectContaining({ base: "merge-base", head: "snapshot" }) })));
});
