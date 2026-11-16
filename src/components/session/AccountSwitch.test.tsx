import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => null as unknown) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { accountGone, accountHasRoom, AccountGoneNotice, AccountSwitchNote, forgetSwitch, switchTabAccount, switchTargets, targetsWithRoom, windowHasRoom } = await import("./AccountSwitch");
type Account = import("@/lib/agentAccounts").AgentAccount;
type Usage = import("@/lib/api").UsageSnapshot;
type Window = import("@/lib/api").UsageWindow;
type Tab = import("@/types/session").TabEntry;

const NOW = Date.UTC(2026, 10, 15, 12);
const WORK = "0123456789abcdef";
const SPARE = "fedcba9876543210";
const account = (id: string, label: string, patch: Partial<Account> = {}): Account =>
  ({ id, agent: "claude", kind: "subscription", label, email: null, plan: null, organization: null, local: id === "local", isDefault: id === "local", missing: false, addedAt: null, ...patch });
const view = (accounts: Account[]) => ({ agent: "claude" as const, accounts, defaultAccount: "local", projectDefaults: {} });
const window = (usedPercent: number, patch: Partial<Window> = {}): Window =>
  ({ agent: "claude", key: "five_hour", label: "5-hour", usedPercent, resetsAt: NOW + 3_600_000, windowMinutes: 300, updatedAt: NOW, stale: false, ...patch });
const usageOf = (accountId: string, label: string, windows: Window[], patch: Record<string, unknown> = {}) => ({ accountId, label, windows, error: null, unavailable: false, agent: "claude", ...patch });
const tab = (patch: Record<string, unknown> = {}) => ({ id: "t1", harness: "claude", title: null, model: "opus", permissionMode: "manual", status: "idle", created: "", providerSessionId: "conv-1", ...patch }) as unknown as Tab;

const three = view([account("local", "This Mac's login"), account(WORK, "Work · Max"), account(SPARE, "Spare · Pro")]);

beforeEach(() => { mocks.invoke.mockClear(); forgetSwitch("t1"); });
afterEach(cleanup);

describe("which accounts a tab may continue on", () => {
  it("counts a window as having room under its limit, or once it has reset", () => {
    expect(windowHasRoom(window(99), NOW)).toBe(true);
    expect(windowHasRoom(window(100), NOW)).toBe(false);
    expect(windowHasRoom(window(100, { resetsAt: NOW - 1 }), NOW)).toBe(true);
    expect(windowHasRoom(window(100, { resetsAt: null }), NOW)).toBe(false);
  });

  it("offers only an account read to have room in every window: not an unread, failed or API-key one", () => {
    expect(accountHasRoom(usageOf(WORK, "Work", [window(20), window(40, { key: "seven_day" })]), NOW)).toBe(true);
    expect(accountHasRoom(usageOf(WORK, "Work", [window(20), window(100, { key: "seven_day" })]), NOW)).toBe(false);
    expect(accountHasRoom(usageOf(WORK, "Work", []), NOW)).toBe(false);
    expect(accountHasRoom(usageOf(WORK, "Work", [window(10)], { error: "Usage unavailable" }), NOW)).toBe(false);
    expect(accountHasRoom(usageOf("api-key", "API key", [], { unavailable: true }), NOW)).toBe(false);
    expect(accountHasRoom(undefined, NOW)).toBe(false);
  });

  it("lists the other signed-in accounts, never the tab's own, and nothing with one account", () => {
    expect(switchTargets(three, tab()).map((a) => a.id)).toEqual([WORK, SPARE]);
    expect(switchTargets(three, tab({ launchedAccount: WORK })).map((a) => a.id)).toEqual(["local", SPARE]);
    const signedOut = view([account("local", "This Mac's login"), account(WORK, "Work · Max", { missing: true })]);
    expect(switchTargets(signedOut, tab())).toEqual([]);
    expect(switchTargets(view([account("local", "This Mac's login")]), tab())).toEqual([]);
    expect(switchTargets(null, tab())).toEqual([]);
  });

  it("at a limit, keeps only those whose windows have room", () => {
    const usage = { accounts: [
      usageOf("local", "This Mac's login", [window(100)]),
      usageOf(WORK, "Work · Max", [window(100)]),
      usageOf(SPARE, "Spare · Pro", [window(35)]),
    ] } as unknown as Usage;
    expect(targetsWithRoom(switchTargets(three, tab()), usage, "claude", NOW).map((a) => a.label)).toEqual(["Spare · Pro"]);
    // Another agent's usage under the same id is not this one's.
    const codex = { accounts: [{ ...usageOf(WORK, "Work", [window(5)]), agent: "codex" }, usageOf(SPARE, "Spare", [window(100)])] } as unknown as Usage;
    expect(targetsWithRoom(switchTargets(three, tab()), codex, "claude", NOW)).toEqual([]);
  });
});

describe("a tab whose account is gone", () => {
  it("says it was removed, or signed out, and nothing for This Mac's login or an account still there", () => {
    expect(accountGone(three, tab({ account: "aaaaaaaaaaaaaaaa" }))).toEqual({ reason: "removed" });
    expect(accountGone(view([account("local", "L"), account(WORK, "Work · Max", { missing: true })]), tab({ account: WORK }))).toEqual({ reason: "signedOut", label: "Work · Max" });
    expect(accountGone(three, tab({ account: WORK }))).toBeNull();
    expect(accountGone(three, tab())).toBeNull();
    expect(accountGone(null, tab({ account: WORK }))).toBeNull();
  });

  it("offers the other accounts, and switches on the click", () => {
    const onSwitch = vi.fn();
    render(<AccountGoneNotice gone={{ reason: "removed" }} targets={[account(SPARE, "Spare · Pro")]} switching={null} error={null} onSwitch={onSwitch} />);
    expect(screen.getByTestId("account-gone").textContent).toContain("was removed");
    fireEvent.click(screen.getByRole("button", { name: "Continue with Spare · Pro" }));
    expect(onSwitch).toHaveBeenCalledWith(expect.objectContaining({ id: SPARE }));
  });
});

describe("switching a tab's account", () => {
  it("restarts the agent on the chosen account and resumes its conversation", async () => {
    await switchTabAccount({ id: "s1" }, tab(), account(SPARE, "Spare · Pro"));
    expect(mocks.invoke).toHaveBeenCalledWith("tab_resume_conversation", { sessionId: "s1", tabId: "t1", harness: "claude", providerSessionId: "conv-1", account: SPARE });
    await expect(switchTabAccount({ id: "s1" }, tab({ providerSessionId: null }), account(SPARE, "Spare · Pro"))).rejects.toThrow("no conversation");
  });

  it("says which model runs after the switch when the new plan gives another", async () => {
    const { rerender } = render(<AccountSwitchNote tabId="t1" reportedModel="claude-opus-5-5" />);
    expect(screen.queryByTestId("account-switch-note")).toBeNull();
    await act(() => switchTabAccount({ id: "s1" }, tab(), account(SPARE, "Spare · Pro")));
    expect(screen.getByTestId("account-switch-note").textContent).toContain("Now on Spare · Pro.");
    rerender(<AccountSwitchNote tabId="t1" reportedModel="claude-sonnet-5-5" modelName={(id) => id === "claude-sonnet-5-5" ? "Sonnet 5.5" : "Opus 5.5"} />);
    expect(screen.getByTestId("account-switch-note").textContent).toContain("Now on Spare · Pro. Its plan runs Sonnet 5.5, not Opus 5.5.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("account-switch-note")).toBeNull();
  });
});
