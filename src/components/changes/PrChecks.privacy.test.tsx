import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CheckAuthority, PullRequest } from "@/lib/api";
import { PRIVACY_MESSAGE, refreshDataPrivacy, setDataPrivacy } from "@/lib/dataPrivacy";
import { useFixCheckErrors } from "@/lib/fixCheckErrors";
import { PrPanel } from "./PrPanel";

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
let hold: "rerun" | "discovery" | "associated" | undefined;
let release: (() => void) | undefined;
let associatedOnly: boolean;

beforeEach(async () => {
  vi.clearAllMocks();
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
    if (command === "work_status") return { branch: "feature", defaultBranch: "main", aheadOfBase: 1 };
    if (command === "pr_check_authority") { admit(); return { owner: "native", epoch: policy.epoch }; }
    if (command === "pr_list") { admit(); return complete("discovery", associatedOnly ? [] : [pr]); }
    if (command === "pr_associations") return [{ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd: input.cwd } }];
    if (command === "pr_details") { admit(); return complete("associated", pr); }
    if (command === "pr_check_rerun") {
      admit(); writes.push(Number(String(args.checkUrl).split("/").at(-1)));
      return complete("rerun", undefined);
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

it.each(cases)("keeps the completed workflow and refuses the later batch continuation: %o", async ({ managed, cycle }) => {
  const view = render(<PrPanel cwd={input.cwd} branch="feature" active busy={false} />);
  const button = await screen.findByRole("button", { name: "Re-run all" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  hold = "rerun";
  fireEvent.click(button);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(writes).toEqual([12]); // Native reply is complete; only delivery is delayed.
  await act(async () => { await revoke(managed, cycle); release!(); });
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
