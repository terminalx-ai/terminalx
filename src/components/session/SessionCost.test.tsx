import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelUsage, SessionEntry, TabEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  invoke: vi.fn(),
  readiness: vi.fn(),
  upsertSession: vi.fn(),
  openStats: vi.fn(),
  windows: [] as unknown[],
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", () => ({ experimental: { settings: mocks.settings } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@/lib/agentReadiness", () => ({ checkAgentReadiness: mocks.readiness }));
vi.mock("@/lib/sessions", () => ({ upsertSession: mocks.upsertSession, openStats: mocks.openStats }));
vi.mock("@/lib/status", () => ({ useStatus: () => ({ usage: { windows: mocks.windows } }) }));
vi.mock("@/lib/models", () => ({ modelLabel: (_harness: string, id: string) => ({ "gpt-6.1-sol": "GPT-6.1 Sol", "claude-sonnet-5-5": "Sonnet 5.5" })[id] ?? id }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

const { SessionCost, totals, formatTokens, formatCost } = await import("./SessionCost");
const { resetExperimentalSettingsForTests } = await import("@/lib/experimentalSettings");

const row = (model: string, input: number, output: number, read: number, costUsd: number | null): ModelUsage =>
  ({ model, inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: 0, costUsd });

function tab(id: string, title: string, harness: string, models: ModelUsage[] | null): TabEntry {
  return {
    id, title, harness, model: "", permissionMode: "default", status: "completed", created: "", modified: "", providerSessionId: `${id}-conversation`,
    usage: models ? { models, updated: "2026-11-11T10:00:00Z" } : null,
  };
}

function session(tabs: TabEntry[]): SessionEntry {
  return { id: "s1", title: "Make slugify handle punctuation", tabs } as unknown as SessionEntry;
}

const twoModels = () => session([
  tab("t1", "Make slugify handle punctuation", "codex", [row("gpt-6.1-sol", 38_000, 21_000, 412_000, 0.71)]),
  tab("t2", "Review the regex", "claude", [row("claude-sonnet-5-5", 9_000, 6_000, 88_000, 0.13)]),
]);

const chip = () => screen.getByTestId("session-cost");

beforeEach(() => {
  resetExperimentalSettingsForTests();
  mocks.settings.mockReset().mockResolvedValue({ nativeCodex: false, sessionCost: true });
  mocks.invoke.mockReset().mockResolvedValue(null);
  mocks.readiness.mockReset().mockImplementation(async (agent: string) => ({ state: "ready", checkedAt: null, version: null, loginMethod: agent === "claude" ? "Claude account" : "ChatGPT account" }));
  mocks.upsertSession.mockReset();
  mocks.openStats.mockReset();
  mocks.windows = [];
});
afterEach(cleanup);

describe("Session cost in the header (PRO-273)", () => {
  it("stays out of the header until Settings → Experimental turns it on", async () => {
    mocks.settings.mockResolvedValue({ nativeCodex: false, sessionCost: false });
    render(<SessionCost session={twoModels()} />);
    await waitFor(() => expect(mocks.settings).toHaveBeenCalled());
    expect(screen.queryByTestId("session-cost")).toBeNull();
    // Turned on elsewhere: the header follows at once.
    act(() => mocks.listeners.get("experimental_settings_changed")!({ payload: { nativeCodex: false, sessionCost: true } }));
    await waitFor(() => expect(chip().textContent).toBe("≈ $0.84"));
  });

  it("shows both tabs' models, each tab's cost, and their sum as an API-equivalent estimate on subscriptions", async () => {
    mocks.windows = [
      { agent: "codex", key: "five_hour", label: "5h", usedPercent: 41, resetsAt: Date.now() + 3_600_000, windowMinutes: 300, updatedAt: Date.now(), stale: false, source: "" },
      { agent: "claude", key: "five_hour", label: "5h", usedPercent: 12, resetsAt: Date.now() + 7_200_000, windowMinutes: 300, updatedAt: Date.now(), stale: false, source: "" },
    ];
    render(<SessionCost session={twoModels()} />);
    await waitFor(() => expect(chip().textContent).toBe("≈ $0.84"));
    expect(chip().getAttribute("title")).toBe("Estimated session cost");
    fireEvent.click(chip());
    const popover = await screen.findByRole("dialog", { name: "Session usage" });
    const rows = within(popover).getAllByTestId("session-usage-model");
    expect(rows.map((r) => r.textContent)).toEqual(["GPT-6.1 Sol38k21k412k$0.71", "Sonnet 5.59k6k88k$0.13"]);
    expect(within(popover).getAllByTestId("session-usage-tab").map((r) => r.textContent)).toEqual(["Tab “Make slugify handle punctuation”$0.71", "Tab “Review the regex”$0.13"]);
    expect(within(popover).getByTestId("session-usage-total").textContent).toBe("$0.84");
    await waitFor(() => expect(within(popover).getByTestId("session-usage-billing").textContent).toBe("subscriptions · nothing billed per token"));
    expect(popover.textContent).toContain("API-equivalent");
    const windows = within(popover).getAllByTestId("session-usage-window").map((w) => w.textContent ?? "");
    expect(windows.map((w) => w.split("resets")[0])).toEqual(["Codex · 5h41%", "Claude · 5h12%"]);
    expect(popover.textContent).toContain("terminalx sessions usage");
    // Opening it reads the totals again from the transcripts.
    expect(mocks.invoke).toHaveBeenCalledWith("session_usage", { sessionId: "s1" });
    fireEvent.click(within(popover).getByRole("button", { name: /Open Stats/ }));
    expect(mocks.openStats).toHaveBeenCalled();
  });

  it("calls it an estimate billed per token on an API key", async () => {
    mocks.readiness.mockResolvedValue({ state: "ready", checkedAt: null, version: null, loginMethod: "API key" });
    render(<SessionCost session={twoModels()} />);
    fireEvent.click(await screen.findByTestId("session-cost"));
    const popover = await screen.findByRole("dialog", { name: "Session usage" });
    await waitFor(() => expect(within(popover).getByTestId("session-usage-billing").textContent).toBe("API key · billed per token"));
    expect(popover.textContent).toContain("estimate");
    expect(popover.textContent).not.toContain("API-equivalent");
  });

  it("shows an unpriced model's tokens with no cost, never zero", async () => {
    render(<SessionCost session={session([tab("t1", "One", "claude", [row("claude-sonnet-5-5", 9_000, 6_000, 88_000, 0.13), row("claude-new-9", 500, 70, 0, null)])])} />);
    await waitFor(() => expect(chip().textContent).toBe("≈ $0.13"));
    fireEvent.click(chip());
    const popover = await screen.findByRole("dialog", { name: "Session usage" });
    const unpriced = within(popover).getAllByTestId("session-usage-model")[1];
    expect(unpriced.textContent).toBe("claude-new-9" + "500" + "70" + "0" + "—");
    expect(popover.textContent).toContain("No price for claude-new-9: its tokens are counted, its cost is not.");
    cleanup();
    render(<SessionCost session={session([tab("t1", "One", "claude", [row("claude-new-9", 500, 70, 0, null)])])} />);
    await waitFor(() => expect(chip().textContent).toBe("≈ —"));
    expect(chip().getAttribute("aria-label")).toBe("Session usage: no price for its models");
  });

  it("reads totals once for a session that has none yet", async () => {
    const before = session([tab("t1", "One", "claude", null)]);
    const after = session([tab("t1", "One", "claude", [row("claude-sonnet-5-5", 1, 1, 0, 0.01)])]);
    mocks.invoke.mockResolvedValue({ usage: {}, session: after });
    const view = render(<SessionCost session={before} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("session_usage", { sessionId: "s1" }));
    expect(mocks.upsertSession).toHaveBeenCalledWith(after);
    view.rerender(<SessionCost session={before} />);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});

describe("usage arithmetic", () => {
  it("sums priced models and lists the unpriced", () => {
    expect(totals([row("a", 1, 2, 3, 0.5), row("b", 10, 20, 30, null)])).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 0, costUsd: 0.5, unpricedModels: ["b"] });
    expect(totals([row("b", 10, 0, 0, null)]).costUsd).toBeNull();
    expect(totals([]).costUsd).toBe(0);
  });

  it("formats tokens and dollars as the design does", () => {
    expect([formatTokens(412_000), formatTokens(999), formatTokens(1_250_000), formatTokens(12_400_000)]).toEqual(["412k", "999", "1.3M", "12M"]);
    expect([formatCost(0.84), formatCost(0.004), formatCost(0), formatCost(null), formatCost(123.4)]).toEqual(["$0.84", "< $0.01", "$0.00", "—", "$123"]);
  });
});
