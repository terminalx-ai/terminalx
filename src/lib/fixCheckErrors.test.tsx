import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agent, gh, type PullRequest } from "./api";
import { setPrefs } from "./prefs";
import { fixErrorsPrompt, useFixCheckErrors } from "./fixCheckErrors";

const mocks = vi.hoisted(() => ({ shortcut: vi.fn(), merge: vi.fn(), workStatus: vi.fn(), sessionPrs: vi.fn() }));
vi.mock("./api", () => ({ agent: { send: vi.fn() }, gh: { checkAuthority: vi.fn(), fixAttachment: vi.fn() }, errorMessage: (e: unknown) => String(e) }));
vi.mock("./agentEvents", () => ({ mergeTabEvents: mocks.merge }));
vi.mock("./hotkeys", () => ({ useShortcut: mocks.shortcut }));
vi.mock("./gitSource", () => ({ localGitSource: () => ({ workStatus: mocks.workStatus }) }));
vi.mock("./sessionPrs", () => ({ sessionPrs: mocks.sessionPrs }));

const pr = { url: "https://github.com/owner/repo/pull/1", state: "OPEN", checks: [{ name: "test", state: "failure", url: "https://github.com/owner/repo/actions/runs/12/job/34", actions: { runId: 12, jobId: 34 } }] } as PullRequest;
const input = { sessionId: "s", tabId: "active-agent", cwd: "/repo", branch: "feature", enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gh.checkAuthority).mockResolvedValue({ owner: "test-policy", epoch: 0 });
  vi.mocked(gh.fixAttachment).mockResolvedValue({ path: "/attachments/s/check-failures.log", truncated: true });
  vi.mocked(agent.send).mockResolvedValue({ events: [], queued: true });
  mocks.workStatus.mockResolvedValue({ branch: "feature", defaultBranch: "main" });
  mocks.sessionPrs.mockResolvedValue({ rows: [{ pr }] });
  setPrefs({ fixErrorsInstructions: "Run the affected tests." });
});
afterEach(cleanup);

it("collects one attachment and sends exactly one prompt to the selected tab, with extra instructions", async () => {
  const hook = renderHook(() => useFixCheckErrors(input));
  await act(async () => { await Promise.all([hook.result.current.fix(pr), hook.result.current.fix(pr)]); });
  expect(gh.fixAttachment).toHaveBeenCalledExactlyOnceWith("s", "active-agent", pr.url, { owner: "test-policy", epoch: 0 });
  expect(agent.send).toHaveBeenCalledExactlyOnceWith("s", "active-agent", expect.stringContaining("@/attachments/s/check-failures.log"));
  expect(vi.mocked(agent.send).mock.calls[0][2]).toContain("Additional instructions:\nRun the affected tests.");
  expect(mocks.merge).toHaveBeenCalledExactlyOnceWith("s", "active-agent", []);
  expect(hook.result.current.notice).toContain("Queued");
  expect(hook.result.current.notice).toContain("trimmed to 256 KiB");
});

it("cancels delivery when the selected tab changes during log collection", async () => {
  let resolve!: (value: { path: string; truncated: boolean }) => void;
  vi.mocked(gh.fixAttachment).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const hook = renderHook((props) => useFixCheckErrors(props), { initialProps: input });
  let pending!: Promise<void>;
  await act(async () => { pending = hook.result.current.fix(pr); });
  hook.rerender({ ...input, tabId: "another-agent" });
  vi.mocked(gh.fixAttachment).mockResolvedValueOnce({ path: "/new.log", truncated: false });
  await act(async () => { await hook.result.current.fix(pr); });
  expect(agent.send).toHaveBeenCalledExactlyOnceWith("s", "another-agent", expect.stringContaining("@/new.log"));
  await act(async () => { resolve({ path: "/old.log", truncated: false }); await pending; });
  expect(agent.send).toHaveBeenCalledOnce();
});

it("cancels on unmount and reports collection failures without sending a partial prompt", async () => {
  vi.mocked(gh.fixAttachment).mockRejectedValueOnce(new Error("Logs expired"));
  const hook = renderHook(() => useFixCheckErrors(input));
  await act(async () => { await expect(hook.result.current.fix(pr)).rejects.toThrow("Logs expired"); });
  expect(hook.result.current.error).toContain("Logs expired");
  expect(agent.send).not.toHaveBeenCalled();
  let resolve!: (value: { path: string; truncated: boolean }) => void;
  vi.mocked(gh.fixAttachment).mockImplementation(() => new Promise((done) => { resolve = done; }));
  let pending!: Promise<void>;
  await act(async () => { pending = hook.result.current.fix(pr); });
  hook.unmount();
  resolve({ path: "/gone.log", truncated: false });
  await pending;
  expect(agent.send).not.toHaveBeenCalled();
});

it("registers the session shortcut, discovers a failing PR, and refuses ambiguous targets", async () => {
  const hook = renderHook(() => useFixCheckErrors(input));
  expect(mocks.shortcut).toHaveBeenLastCalledWith("session.fixErrors", expect.any(Function), { enabled: true });
  await act(async () => { await hook.result.current.fix(); });
  expect(agent.send).toHaveBeenCalledOnce();
  mocks.sessionPrs.mockResolvedValue({ rows: [{ pr }, { pr: { ...pr, url: pr.url + "2" } }] });
  await act(async () => { await expect(hook.result.current.fix()).rejects.toThrow("Several pull requests"); });
  expect(agent.send).toHaveBeenCalledOnce();
});

it("does not send when disabled and quotes attachment paths containing spaces", async () => {
  const hook = renderHook(() => useFixCheckErrors({ ...input, enabled: false }));
  await act(async () => { await hook.result.current.fix(pr); });
  expect(agent.send).not.toHaveBeenCalled();
  expect(fixErrorsPrompt(pr.url, "/My Files/failure.log", " ")).toContain('@"/My Files/failure.log"');
  expect(fixErrorsPrompt(pr.url, "/log", " ")).not.toContain("Additional instructions");
});

it("leaves out a pull request linked from another branch (PRO-294): this session's agent cannot push to it", async () => {
  const linked = { ...pr, url: "https://github.com/owner/repo/pull/9" } as PullRequest;
  const association = (url: string, isLinked: boolean) => ({ url, number: 9, head: "other", scope: { kind: "local" as const, cwd: "/repo" }, linked: isLinked });
  const hook = renderHook(() => useFixCheckErrors(input));
  // Only the linked PR fails: nothing for this session to fix.
  mocks.sessionPrs.mockResolvedValue({ rows: [{ pr: linked, current: false, association: association(linked.url, true) }] });
  await act(async () => { await expect(hook.result.current.fix()).rejects.toThrow("No failing GitHub Actions checks"); });
  expect(agent.send).not.toHaveBeenCalled();
  // Both fail: the session's own PR is the one, not "several".
  mocks.sessionPrs.mockResolvedValue({ rows: [{ pr: linked, current: false, association: association(linked.url, true) }, { pr, current: true }] });
  await act(async () => { await hook.result.current.fix(); });
  expect(gh.fixAttachment).toHaveBeenCalledExactlyOnceWith("s", "active-agent", pr.url, { owner: "test-policy", epoch: 0 });
  // A linked PR on this session's own branch is its work after all.
  vi.mocked(gh.fixAttachment).mockClear();
  mocks.sessionPrs.mockResolvedValue({ rows: [{ pr: linked, current: true, association: association(linked.url, true) }] });
  await act(async () => { await hook.result.current.fix(); });
  expect(gh.fixAttachment).toHaveBeenCalledExactlyOnceWith("s", "active-agent", linked.url, { owner: "test-policy", epoch: 0 });
});
