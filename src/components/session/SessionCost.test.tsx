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
const machineSession = { name: "Mac mini", sessionId: "rt-1", generation: "1" };

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
    // Partial: the chip says so before the popover is opened.
    await waitFor(() => expect(chip().textContent).toBe("≈ $0.13+"));
    expect(chip().getAttribute("aria-label")).toBe("Session usage: estimated $0.13 and more: no price for claude-new-9");
    expect(chip().getAttribute("title")).toContain("without the models that have no price (claude-new-9)");
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

  // PRO-408: a machine session's agents ran on the machine.
  it("on a machine session, reads usage, billing and windows on the machine, never this computer's", async () => {
    mocks.windows = [{ agent: "claude", key: "five_hour", label: "5h", usedPercent: 99, resetsAt: null, windowMinutes: 300, updatedAt: Date.now(), stale: false, source: "" }];
    const read = vi.fn(async () => ({
      usage: { sessionId: "rt-1", title: "Work", tabs: [], models: [], estimate: true as const },
      loginMethods: { codex: "API key", claude: "API key" },
      windows: [{ agent: "codex" as const, key: "five_hour", label: "5h", usedPercent: 63, resetsAt: Date.now() + 3_600_000, windowMinutes: 300, updatedAt: Date.now(), stale: false }],
    }));
    render(<SessionCost session={twoModels()} machine={{ ...machineSession, read }} />);
    await waitFor(() => expect(chip().textContent).toBe("≈ $0.84"));
    fireEvent.click(chip());
    const popover = await screen.findByRole("dialog", { name: "Session usage" });
    await waitFor(() => expect(within(popover).getByTestId("session-usage-billing").textContent).toBe("API key · billed per token"));
    expect(read).toHaveBeenCalled();
    // Nothing of this computer: not its logins, its transcripts or its windows.
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    const windows = within(popover).getAllByTestId("session-usage-window").map((w) => w.textContent ?? "");
    expect(windows.map((w) => w.split("resets")[0])).toEqual(["Codex · 5h63%"]);
    // The command names the session as the machine knows it; Stats is this computer's.
    expect(within(popover).getByRole("button", { name: "Copy terminalx sessions usage rt-1 --json, to run on Mac mini" })).toBeTruthy();
    expect(within(popover).getByTestId("session-usage-where").textContent).toBe("on Mac mini");
    expect(within(popover).queryByRole("button", { name: /Open Stats/ })).toBeNull();
  });

  it("on a machine session not connected, shows the totals its list carries and reads nothing", async () => {
    render(<SessionCost session={twoModels()} machine={{ ...machineSession, read: null }} />);
    await waitFor(() => expect(chip().textContent).toBe("≈ $0.84"));
    fireEvent.click(chip());
    const popover = await screen.findByRole("dialog", { name: "Session usage" });
    expect(within(popover).getByTestId("session-usage-billing").textContent).toBe("at API list prices");
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("reads a machine session's totals once when its tabs have messages and none yet", async () => {
    const models = [row("claude-sonnet-5-5", 9_000, 6_000, 88_000, 0.13)];
    const read = vi.fn(async () => ({
      usage: { sessionId: "rt-1", title: "Work", tabs: [{ tabId: "t1", agent: "claude", models, updated: "2026-11-11T10:00:00Z" }], models, estimate: true as const },
      loginMethods: {}, windows: [],
    }));
    const unread = session([{ ...tab("t1", "Work", "claude", null), providerSessionId: undefined, hasMessages: true }]);
    const machine = { ...machineSession, read };
    const { rerender } = render(<SessionCost session={unread} machine={machine} />);
    // The RPC reply is sufficient even if a session-list update has not arrived.
    expect((await screen.findByTestId("session-cost")).textContent).toBe("≈ $0.13");
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    const newer = { ...unread.tabs[0], usage: { updated: "2026-11-11T10:01:00Z", models: [row("claude-sonnet-5-5", 12_000, 8_000, 88_000, 0.25)] } };
    rerender(<SessionCost session={{ ...unread, tabs: [newer] }} machine={machine} />);
    expect(chip().textContent).toBe("≈ $0.25");
    expect(read).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(["timeout", "reconnect"])("backfills missing machine totals after a failed read and %s", async (recovery) => {
    vi.useFakeTimers();
    try {
      const models = [row("claude-sonnet-5-5", 9_000, 6_000, 88_000, 0.13)];
      const answer = {
        usage: { sessionId: machineSession.sessionId, title: "Work", tabs: [{ tabId: "t1", agent: "claude", models, updated: "2026-11-11T10:00:00Z" }], models, estimate: true as const },
        loginMethods: {},
        windows: [],
      };
      const read = vi.fn(async () => answer).mockRejectedValueOnce(new Error("Usage read failed"));
      const unread = session([{ ...tab("t1", "Work", "claude", null), providerSessionId: undefined, hasMessages: true }]);
      const renderCost = (generation: string, connected = true) => (
        <SessionCost session={unread} machine={{ ...machineSession, generation, read: connected ? () => read() : null }} />
      );
      const { rerender } = render(renderCost("1"));
      await act(async () => {});
      expect(screen.queryByTestId("session-cost")).toBeNull();
      expect(read).toHaveBeenCalledOnce();

      rerender(renderCost("1"));
      expect(read).toHaveBeenCalledOnce();
      if (recovery === "reconnect") {
        rerender(renderCost("offline", false));
        rerender(renderCost("2"));
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(chip().textContent).toBe("≈ $0.13");
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // PRO-408 review: each read makes the machine re-read every transcript, so a parent render must not ask again.
  it("reads a machine session's usage once per opening, however often its view renders", async () => {
    const answer = { usage: { sessionId: "rt-1", title: "Work", tabs: [], models: [], estimate: true as const }, loginMethods: {}, windows: [] };
    const read = vi.fn(async () => answer);
    // A new `read` on every render, as SessionView builds it.
    const view = (current: ReturnType<typeof twoModels>) => <SessionCost session={current} machine={{ ...machineSession, read: () => read() }} />;
    const { rerender } = render(view(twoModels()));
    await waitFor(() => expect(chip().textContent).toBe("≈ $0.84"));
    fireEvent.click(chip());
    await screen.findByRole("dialog", { name: "Session usage" });
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    for (let i = 0; i < 3; i++) rerender(view({ ...twoModels() }));
    await act(async () => {});
    expect(read).toHaveBeenCalledOnce();
    // Closing and opening again reads again.
    fireEvent.click(chip());
    fireEvent.click(chip());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("formats tokens and dollars as the design does", () => {
    expect([formatTokens(412_000), formatTokens(999), formatTokens(1_250_000), formatTokens(12_400_000)]).toEqual(["412k", "999", "1.3M", "12M"]);
    expect([formatCost(0.84), formatCost(0.004), formatCost(0), formatCost(null), formatCost(123.4)]).toEqual(["$0.84", "< $0.01", "$0.00", "—", "$123"]);
  });
});
