import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { act, cleanup, fireEvent, render as renderView, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CheckAuthority, PullRequest } from "@/lib/api";
import { PRIVACY_MESSAGE, refreshDataPrivacy, setDataPrivacy } from "@/lib/dataPrivacy";
import { sendFailedChecks, useFixCheckErrors } from "@/lib/fixCheckErrors";
import { PrPanel } from "./PrPanel";

const render = (node: ReactNode) => renderView(<TooltipProvider>{node}</TooltipProvider>);

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/hotkeys", () => ({ useShortcut: vi.fn() }));
vi.mock("@/lib/agentEvents", () => ({ mergeTabEvents: vi.fn() }));

const pr: PullRequest = { number: 1, url: "https://github.com/owner/repo/pull/1", title: "Fix CI", state: "OPEN", isDraft: false, head: "feature", base: "main", additions: 1, deletions: 0, body: "", author: "dev", mergeable: "MERGEABLE", reviewDecision: null, checks: [
  { name: "test", state: "failure", url: "https://github.com/owner/repo/actions/runs/12", actions: { runId: 12, jobId: null } },
  { name: "lint", state: "failure", url: "https://github.com/owner/repo/actions/runs/56", actions: { runId: 56, jobId: null } },
] };
const input = { sessionId: "s", tabId: "agent", cwd: "/repo-privacy", branch: "feature", enabled: true };
let policy: { enabled: boolean; managed: boolean; epoch: number };
let writes: number[], collections: number, prompts: number;
let hold: "rerun" | "discovery" | "associated" | "authority" | undefined;
let release: (() => void) | undefined;
let associatedOnly: boolean;
let current: PullRequest;
let holdRun: number | undefined, refuseRun: number | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  current = structuredClone(pr); holdRun = undefined; refuseRun = undefined;
  policy = { enabled: false, managed: false, epoch: 0 };
  writes = []; collections = 0; prompts = 0; release = undefined; hold = undefined; associatedOnly = false;
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const admit = () => {
      const authority = args.authority as CheckAuthority | undefined;
      if (policy.enabled || (authority && (authority.owner !== "native" || authority.epoch !== policy.epoch))) throw new Error(PRIVACY_MESSAGE);
    };
    const complete = async (boundary: typeof hold, result: unknown) => {
      if (hold === boundary) { hold = undefined; await new Promise<void>((resolve) => { release = resolve; }); }
      return result;
    };
    if (command === "data_privacy_set") { if (args.enabled && !policy.enabled) policy.epoch++; policy.enabled = args.enabled as boolean; return policy; }
    if (command === "data_privacy_status") return policy;
    if (command === "gh_available") return true;
    if (command === "gh_connection_status") { admit(); return { state: "connected", hostname: "github.com", details: null }; }
    if (command === "git_has_remote") return true;
    if (command === "workspace_disposition") return { exists: true, checked: true, branch: "feature", isMain: true };
    if (command === "work_status") return { branch: "feature", defaultBranch: "main", aheadOfBase: 1 };
    if (command === "pr_check_authority") { admit(); return complete("authority", { owner: "native", epoch: policy.epoch }); }
    if (command === "pr_conversation") { admit(); return { ...current, viewer: "reviewer", canEdit: false, reviewers: [], unresolvedThreads: 0, activity: [] }; }
    if (command === "pr_list") { admit(); return complete("discovery", associatedOnly ? [] : [current]); }
    if (command === "pr_associations") return [{ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd: input.cwd } }];
    if (command === "pr_details") { admit(); return complete("associated", current); }
    if (command === "pr_check_rerun") {
      admit();
      const run = Number(String(args.checkUrl).split("/").at(-1));
      // The provider outcome exists before the reply is delivered to the UI.
      const refused = run === refuseRun;
      if (!refused) writes.push(run);
      if (holdRun === undefined || holdRun === run) await complete("rerun", undefined);
      if (refused) throw new Error("GitHub rejected this workflow rerun");
      return undefined;
    }
    if (command === "pr_check_fix_attachment") { admit(); collections++; return { path: "/logs/failure.log", truncated: false }; }
    if (command === "send_message") { prompts++; return { queued: false, events: [] }; }
    throw new Error(`Unexpected command: ${command}`);
  });
  await refreshDataPrivacy();
});
afterEach(async () => { cleanup(); policy.enabled = false; policy.managed = false; await refreshDataPrivacy(); });

async function revoke(managed: boolean, cycle: boolean) {
  if (managed) { policy.enabled = true; policy.managed = true; policy.epoch++; await refreshDataPrivacy(); }
  else await setDataPrivacy(true);
  if (cycle) {
    if (managed) { policy.enabled = false; policy.managed = false; await refreshDataPrivacy(); }
    else await setDataPrivacy(false);
  }
}
const cases = [
  { managed: false, cycle: false }, { managed: false, cycle: true },
  { managed: true, cycle: false }, { managed: true, cycle: true },
];

it.each(cases)("retains direct failed-log delivery authority across a delayed reply: %o", async ({ managed, cycle }) => {
  hold = "authority";
  const pending = sendFailedChecks("s", "agent", pr.url, "").catch((error: unknown) => error);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => { await revoke(managed, cycle); release!(); });
  expect(String(await pending)).toContain(PRIVACY_MESSAGE);
  expect(collections).toBe(0); expect(prompts).toBe(0);
  expect(mocks.invoke).toHaveBeenCalledWith("pr_check_fix_attachment", {
    sessionId: "s", tabId: "agent", prUrl: pr.url, authority: { owner: "native", epoch: 0 },
  });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_check_authority")).toHaveLength(1);
  await act(async () => { policy.enabled = false; policy.managed = false; await refreshDataPrivacy(); });
  expect(collections).toBe(0); expect(prompts).toBe(0);
  expect(await sendFailedChecks("s", "agent", pr.url, "")).toContain("Sent");
  expect(collections).toBe(1); expect(prompts).toBe(1);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_check_fix_attachment").at(-1)![1].authority).toEqual({ owner: "native", epoch: 1 });
});

it.each(cases)("keeps the completed workflow and refuses the later batch continuation: %o", async ({ managed, cycle }) => {
  const view = render(<PrPanel cwd={input.cwd} branch="feature" active busy={false} />);
  const button = await screen.findByRole("button", { name: "Re-run all" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  hold = "rerun";
  fireEvent.click(button);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(writes).toEqual([12]); // Native reply is complete; only delivery is delayed.
  await act(async () => { await revoke(managed, cycle); release!(); });
  fireEvent.click(await screen.findByRole("button", { name: "Show details" }));
  await screen.findByText(PRIVACY_MESSAGE);
  expect(writes).toEqual([12]);
  expect(screen.getByLabelText("test: queued")).toBeTruthy();
  expect(screen.getByLabelText("lint: failure")).toBeTruthy();
  const calls = mocks.invoke.mock.calls.filter(([command]) => command === "pr_check_rerun");
  expect(calls).toHaveLength(2);
  expect(calls.map(([, args]) => args.authority)).toEqual([{ owner: "native", epoch: 0 }, { owner: "native", epoch: 0 }]);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_check_authority")).toHaveLength(1);
  await act(async () => { policy.enabled = false; policy.managed = false; await refreshDataPrivacy(); });
  expect(writes).toEqual([12]); // Disabling never resumes the old loop.
  view.unmount();
  render(<PrPanel cwd={input.cwd} branch="feature" active busy={false} />);
  const fresh = await screen.findByRole("button", { name: "Re-run all" });
  await waitFor(() => expect((fresh as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(fresh);
  await screen.findByText("Re-run requested for 2 Actions runs.");
  expect(writes).toEqual([12, 12, 56]);
});

for (const boundary of ["discovery", "associated"] as const) {
  it.each(cases)(`retains shortcut authority after completed ${boundary}: %o`, async ({ managed, cycle }) => {
    associatedOnly = boundary === "associated";
    hold = boundary;
    const hook = renderHook(() => useFixCheckErrors(input));
    let pending!: Promise<unknown>;
    await act(async () => { pending = hook.result.current.fix().catch((error: unknown) => error); });
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await act(async () => { await revoke(managed, cycle); release!(); await pending; });
    expect(hook.result.current.error).toContain(PRIVACY_MESSAGE);
    expect(collections).toBe(0); expect(prompts).toBe(0);
    const requests = mocks.invoke.mock.calls.filter(([command]) => ["pr_list", "pr_details", "pr_check_fix_attachment"].includes(command));
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.every(([, args]) => args.authority?.owner === "native" && args.authority?.epoch === 0)).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "pr_check_authority")).toHaveLength(1);
    await act(async () => { policy.enabled = false; policy.managed = false; await refreshDataPrivacy(); });
    expect(collections).toBe(0); expect(prompts).toBe(0);
    await act(async () => { await hook.result.current.fix(); });
    expect(collections).toBe(1); expect(prompts).toBe(1);
    const attachment = mocks.invoke.mock.calls.filter(([command]) => command === "pr_check_fix_attachment").at(-1)!;
    expect(attachment[1].authority).toEqual({ owner: "native", epoch: 1 });
  });
}

// Freeze independent poll timers: every read observed before clicking Refresh
// must come from the completed action, not the separate background scheduler.
for (const count of [1, 2]) {
  for (const outcome of ["success", "ordinary-error"] as const) {
    it.each(cases)(`does not reconcile a delayed final ${outcome} for ${count} workflow(s): %o`, async ({ managed, cycle }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        current.checks = current.checks.slice(0, count);
        const finalRun = count === 1 ? 12 : 56;
        hold = "rerun"; holdRun = finalRun;
        if (outcome === "ordinary-error") refuseRun = finalRun;
        await act(async () => {
          render(<PrPanel cwd={input.cwd} sessionId="s" branch="feature" active busy={false}
            workspace={{ projectPath: input.cwd, onDelete: vi.fn() }} />);
        });
        const reads = () => mocks.invoke.mock.calls.filter(([command]) => ["work_status", "pr_list", "pr_details", "pr_associations", "pr_landed", "workspace_disposition"].includes(command));
        const before = [...reads()];
        expect(before.some(([command]) => command === "pr_list")).toBe(true);
        expect(before.some(([command]) => command === "workspace_disposition")).toBe(true);
        const button = screen.getByRole("button", { name: "Re-run all" });
        expect((button as HTMLButtonElement).disabled).toBe(false);
        await act(async () => { fireEvent.click(button); });
        expect(release).toBeTypeOf("function");
        const completed = current.checks.map((check) => check.actions!.runId).filter((run) => run !== refuseRun);
        expect(writes).toEqual(completed);
        await act(async () => { await revoke(managed, cycle); release!(); });
        if (outcome === "success") expect(screen.getByRole("status").textContent).toContain(`Re-run requested for ${count} Actions`);
        else {
          fireEvent.click(screen.getByRole("button", { name: "Show details" }));
          expect(screen.getByRole("alert").textContent).toContain("GitHub rejected this workflow rerun");
        }
        for (const check of current.checks) {
          expect(screen.getByLabelText(`${check.name}: ${completed.includes(check.actions!.runId) ? "queued" : "failure"}`)).toBeTruthy();
        }
        expect(reads()).toEqual(before); // no immediate unscoped reconciliation
        expect(writes).toEqual(completed); // no mutation replay
        await act(async () => { policy.enabled = false; policy.managed = false; await refreshDataPrivacy(); });
        expect(reads()).toEqual(before);
        // Main refreshes discovery immediately and after rechecking the GitHub connection.
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" })); });
        expect(reads().filter(([command]) => command === "pr_list")).toHaveLength(before.filter(([command]) => command === "pr_list").length + 2);
        expect(reads().filter(([command]) => command === "workspace_disposition")).toHaveLength(before.filter(([command]) => command === "workspace_disposition").length + 2);
        expect(writes).toEqual(completed);
        if (outcome === "ordinary-error") expect(screen.getByRole("alert").textContent).toContain("GitHub rejected this workflow rerun");
      } finally {
        cleanup();
        vi.useRealTimers();
      }
    });
  }
}
