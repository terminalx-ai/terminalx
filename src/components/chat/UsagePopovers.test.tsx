import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabEntry } from "@/types/session";
import type { Turn } from "@/lib/transcript";
import { ContextPopover, sessionEstimate, TurnDetailsPopover } from "./UsagePopovers";

const { check, readiness, status } = vi.hoisted(() => ({
  check: vi.fn(async () => ({ state: "ready", loginMethod: "Claude account", plan: "max" })),
  readiness: vi.fn(async () => ({ state: "ready", loginMethod: "Claude account", plan: "pro" })),
  status: { accounts: undefined as unknown },
}));
vi.mock("@/lib/agentReadiness", () => ({ checkAgentReadiness: check }));
vi.mock("@/lib/agentAccounts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agentAccounts")>()), agentAccounts: { readiness } }));
const localWindows = [
  { agent: "claude", key: "five", label: "5 hours", usedPercent: 42, resetsAt: Date.now() + 3600000, updatedAt: Date.now(), stale: false },
  { agent: "codex", key: "week", label: "Codex weekly", usedPercent: 81, resetsAt: null, updatedAt: Date.now(), stale: false },
];
vi.mock("@/lib/status", () => ({ useStatus: () => ({ usage: { windows: localWindows, accounts: status.accounts } }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); status.accounts = undefined; });
const tab = { id: "tab", harness: "claude", model: "opus", requestedModel: "sonnet", effort: "high" } as TabEntry;
const turn: Turn = {
  key: "t1", seq: 1, agent: "claude", model: "claude-sonnet-4-6", ts: "2026-11-07T10:00:00Z", work: [], toolCount: 0, editedFiles: 0, live: false,
  completed: { status: "ok", durationMs: 2000, ts: "2026-11-07T10:00:02Z" },
  usage: { inputTokens: 20, outputTokens: 100, cacheReadTokens: 70, cacheWriteTokens: 10, costUsd: 0.12 },
};
const base = { tab, used: 80000, max: 100000, reportedModel: "claude-opus-4-6", local: true, turns: [turn], compacting: false, compactDisabled: false, onCompact: vi.fn() };

async function openContext() {
  fireEvent.click(screen.getByRole("button", { name: /Context .*used|Context details/ }));
  return screen.findByRole("dialog", { name: "Context and session details" });
}

describe("context popover", () => {
  it("leads with the context and its bar, names the model and plan, and shows only this agent's windows (PRO-379)", async () => {
    render(<ContextPopover {...base} />);
    const dialog = await openContext();
    await waitFor(() => expect(dialog.textContent).toContain("Claude Max"));
    expect(within(dialog).queryByRole("heading")).toBeNull();
    expect(dialog.textContent!.startsWith("Context80K of 100K · 80%")).toBe(true);
    expect(within(dialog).getByRole("meter", { name: "Context used" }).getAttribute("aria-valuenow")).toBe("80");
    // Compact sits right under the bar, with what it does.
    const order = ["Compact now", "Types /compact into Claude Code", "Claude usage", "Signed in", "Provider", "Model", "This session so far"].map((text) => dialog.textContent!.indexOf(text));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    for (const text of ["Anthropic", "Opus 4.6", "claude-opus-4-6", "High", "$0.12", "estimated", "42%", "Max plan"]) expect(dialog.textContent).toContain(text);
    expect(dialog.textContent).toMatch(/Resets at .+ · in (59m|1h 0m)/);
    expect(within(dialog).getByRole("meter", { name: "5 hours used" }).getAttribute("aria-valuenow")).toBe("42");
    expect(within(dialog).queryByText("Codex weekly")).toBeNull();
    expect(within(dialog).queryByRole("status")).toBeNull();
    // Nothing below 12px.
    expect(dialog.querySelector("[class*='text-[11px]'], [class*='text-[10px]']")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the percentage beside the ring, and warns in amber when a window is close to its limit", async () => {
    localWindows[0]!.usedPercent = 86;
    try {
      render(<ContextPopover {...base} />);
      expect(screen.getByRole("button", { name: "Context 80% used" }).textContent).toBe("80%");
      const dialog = await openContext();
      expect(within(dialog).getByRole("status").textContent).toBe("You're close to your 5 hours limit.");
      expect(within(dialog).getByText("86%").className).toContain("text-warning");
    } finally { localWindows[0]!.usedPercent = 42; }
  });

  it("sends compact once while pending and reflects lower and zero context readings", async () => {
    let resolve!: () => void;
    const compact = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const view = render(<ContextPopover {...base} onCompact={compact} />);
    await openContext();
    const button = screen.getByRole("button", { name: "Compact now" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(compact).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Sending…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve());
    view.rerender(<ContextPopover {...base} used={20000} />);
    expect(screen.getByRole("button", { name: "Context 20% used" })).toBeDefined();
    view.rerender(<ContextPopover {...base} used={0} />);
    expect(screen.getByRole("button", { name: "Context 0% used" })).toBeDefined();
    view.rerender(<ContextPopover {...base} used={undefined} />);
    expect(screen.getByRole("button", { name: "Context details" }).title).toContain("No context data yet");
  });

  it("reports a failed compact and permits a retry", async () => {
    const compact = vi.fn().mockRejectedValueOnce(new Error("private backend detail")).mockResolvedValueOnce(undefined);
    render(<ContextPopover {...base} onCompact={compact} />);
    await openContext();
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not send /compact. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("disables compaction when blocked or already compacting, without borrowing local cloud account data", async () => {
    const compact = vi.fn();
    const view = render(<ContextPopover {...base} local={false} compactDisabled onCompact={compact} />);
    const dialog = await openContext();
    expect((screen.getByRole("button", { name: "Compact now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.textContent).not.toContain("42% used");
    expect(check).not.toHaveBeenCalled();
    view.rerender(<ContextPopover {...base} local={false} compacting onCompact={compact} />);
    expect((screen.getByRole("button", { name: "Compacting…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(compact).not.toHaveBeenCalled();
  });

  it("with one account names none and reads This Mac's login, as before", async () => {
    render(<ContextPopover {...base} />);
    const dialog = await openContext();
    await waitFor(() => expect(dialog.textContent).toContain("Claude account · Claude Max"));
    expect(dialog.textContent).toContain("Claude usage");
    expect(within(dialog).queryByText("Account")).toBeNull();
    expect(within(dialog).queryByText(/Other Claude accounts/)).toBeNull();
    expect(check).toHaveBeenCalledWith("claude");
    expect(readiness).not.toHaveBeenCalled();
  });

  it("names the tab's account, shows its own windows, then each other account under its label", async () => {
    const window = (usedPercent: number) => ({ agent: "claude", key: "five_hour", label: "5h", usedPercent, resetsAt: Date.now() + 3600000, updatedAt: Date.now(), stale: false });
    status.accounts = [
      { agent: "claude", accountId: "local", label: "This Mac's login", windows: [localWindows[0]], error: null, unavailable: false },
      { agent: "claude", accountId: "aaaa1111bbbb2222", label: "Work · Max", windows: [window(12)], error: null, unavailable: false },
      { agent: "claude", accountId: "cccc3333dddd4444", label: "Home · Pro", windows: [], error: "Claude OAuth usage request failed with HTTP 401", unavailable: true },
      { agent: "claude", accountId: "api-key", label: "API key", windows: [], error: null, unavailable: true },
      { agent: "codex", accountId: "local", label: "This Mac's login", windows: [localWindows[1]], error: null, unavailable: false },
    ];
    render(<ContextPopover {...base} tab={{ ...tab, launchedAccount: "aaaa1111bbbb2222" } as TabEntry} />);
    const dialog = await openContext();
    await waitFor(() => expect(dialog.textContent).toContain("Claude Pro"));
    expect(readiness).toHaveBeenCalledWith("claude", "aaaa1111bbbb2222");
    expect(check).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain("Claude usage · Work · Max");
    const others = within(dialog).getByLabelText("Other Claude accounts");
    expect(within(others).getByLabelText("This Mac's login").textContent).toContain("42%");
    expect(within(others).getByLabelText("Home · Pro").textContent).toContain("Usage unavailable");
    expect(within(others).getByLabelText("API key").textContent).toContain("No subscription usage windows");
    // The tab's own windows come first, read with its own account.
    const own = dialog.textContent!.slice(0, dialog.textContent!.indexOf("Other Claude accounts"));
    expect(own).toContain("12%");
    expect(own).not.toContain("42%");
    expect(dialog.textContent).not.toContain("Codex weekly");
  });

  it("distinguishes missing prices from zero and excludes unfinished turns", () => {
    expect(sessionEstimate([])).toEqual({ cost: 0, partial: false });
    expect(sessionEstimate([{ ...turn, usage: undefined }])).toEqual({ cost: null, partial: true });
    expect(sessionEstimate([turn, { ...turn, usage: undefined }, { ...turn, completed: undefined }])).toEqual({ cost: 0.12, partial: true });
    expect(sessionEstimate([{ ...turn, usage: { costUsd: 0 } }])).toEqual({ cost: 0, partial: false });
  });
});

describe("turn details", () => {
  it("heads with the agent and model names and the time range, then settings, tokens and tiles (PRO-379)", async () => {
    render(<TurnDetailsPopover turn={{ ...turn, settings: { permissionMode: "manual" }, usage: { ...turn.usage, effort: "high", fast: false } }}>Worked for 2s</TurnDetailsPopover>);
    fireEvent.click(screen.getByRole("button", { name: "Turn details" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn details" });
    expect(dialog.textContent).toMatch(/^Claude Code · Sonnet 4\.6/);
    expect(dialog.textContent).toMatch(/· \d{1,2}:00:00( [AP]M)? → \d{1,2}:00:02/);
    for (const text of ["EffortHigh", "Fast modeOff", "Permission modeAsk every time", "Tokens this turn", "Input20", "Output100", "Cache read70", "Cache write10",
      "70%cache hit", "50/soutput tokens", "$0.12estimated", "Cost is an estimate at API prices, not your bill."]) expect(dialog.textContent).toContain(text);
    expect(dialog.querySelector("[class*='text-[11px]'], [class*='text-[10px]']")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("takes the tab's settings for a turn without its own record, unless they changed since", async () => {
    const view = render(<TurnDetailsPopover turn={turn} fallback={{ effort: "low", permissionMode: "plan" }}>Worked</TurnDetailsPopover>);
    fireEvent.click(screen.getByRole("button", { name: "Turn details" }));
    let dialog = await screen.findByRole("dialog", { name: "Turn details" });
    expect(dialog.textContent).toContain("EffortLow");
    expect(dialog.textContent).toContain("Permission modePlan");
    fireEvent.keyDown(dialog, { key: "Escape" });
    view.rerender(<TurnDetailsPopover turn={turn} fallback={{ effort: "low", permissionMode: "plan", changed: { permissionMode: true } }}>Worked</TurnDetailsPopover>);
    fireEvent.click(screen.getByRole("button", { name: "Turn details" }));
    dialog = await screen.findByRole("dialog", { name: "Turn details" });
    expect(dialog.textContent).toContain("Permission modeNot recorded");
  });

  it("never offers metrics for unfinished turns", () => {
    const view = render(<TurnDetailsPopover turn={{ ...turn, completed: undefined, live: true }}>Worked</TurnDetailsPopover>);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<TurnDetailsPopover turn={{ ...turn, live: true }}>Worked</TurnDetailsPopover>);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not invent rates for old logs or zero denominators", async () => {
    render(<TurnDetailsPopover turn={{ ...turn, usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, completed: { ...turn.completed!, durationMs: 0 } }}>Worked</TurnDetailsPopover>);
    fireEvent.click(screen.getByRole("button", { name: "Turn details" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn details" });
    expect(dialog.textContent).not.toMatch(/NaN|Infinity|\d\/s/);
    // No cache hit, rate or price: each tile says so with a dash.
    expect(within(dialog).getAllByText("–")).toHaveLength(3);
  });
});
