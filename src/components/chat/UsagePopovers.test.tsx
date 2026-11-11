import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabEntry } from "@/types/session";
import type { Turn } from "@/lib/transcript";
import { ContextPopover, sessionEstimate, TurnDetailsPopover } from "./UsagePopovers";

const { check } = vi.hoisted(() => ({ check: vi.fn(async () => ({ state: "ready", loginMethod: "Claude account", plan: "max" })) }));
vi.mock("@/lib/agentReadiness", () => ({ checkAgentReadiness: check }));
vi.mock("@/lib/status", () => ({ useStatus: () => ({ usage: { windows: [
  { agent: "claude", key: "five", label: "5 hours", usedPercent: 42, resetsAt: Date.now() + 3600000, updatedAt: Date.now(), stale: false },
  { agent: "codex", key: "week", label: "Codex weekly", usedPercent: 81, resetsAt: null, updatedAt: Date.now(), stale: false },
] } }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
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
  it("shows context, requested and reported settings, estimate and only this agent's account windows", async () => {
    render(<ContextPopover {...base} />);
    const dialog = await openContext();
    await waitFor(() => expect(dialog.textContent).toContain("Claude account"));
    for (const text of ["80,000 / 100,000", "sonnet", "claude-opus-4-6", "high", "max", "$0.12", "42% used", "main agent only"]) expect(dialog.textContent).toContain(text);
    expect(within(dialog).queryByText("Codex weekly")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

  it("distinguishes missing prices from zero and excludes unfinished turns", () => {
    expect(sessionEstimate([])).toEqual({ cost: 0, partial: false });
    expect(sessionEstimate([{ ...turn, usage: undefined }])).toEqual({ cost: null, partial: true });
    expect(sessionEstimate([turn, { ...turn, usage: undefined }, { ...turn, completed: undefined }])).toEqual({ cost: 0.12, partial: true });
    expect(sessionEstimate([{ ...turn, usage: { costUsd: 0 } }])).toEqual({ cost: 0, partial: false });
  });
});

describe("turn details", () => {
  it("shows completed metrics with disjoint token counters and full-turn throughput", async () => {
    render(<TurnDetailsPopover turn={turn}>Worked for 2s</TurnDetailsPopover>);
    fireEvent.click(screen.getByRole("button", { name: "Turn details" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn details" });
    for (const text of ["Claude", "claude-sonnet-4-6", "70.0%", "50.0 tokens/s", "Avg output rate", "Started", "Ended", "Input (uncached)", "Cache write"]) expect(dialog.textContent).toContain(text);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
    expect(dialog.textContent).not.toMatch(/NaN|Infinity|tokens\/s/);
    expect(within(dialog).getAllByText("Unavailable")).toHaveLength(2);
  });
});
