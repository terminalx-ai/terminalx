import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type StatsUsageSnapshot, type StatsUsageState } from "@/lib/api";

const { snapshot } = vi.hoisted(() => ({
  snapshot: {
    app: { agentsSpawned: 7, agentTimeMs: 7_500_000, prsCreated: 2, trackingSince: "2026-08-02T12:00:00Z" },
    totalTokens: 12_700_000_000,
    estimatedCostUsd: 14178.14,
    hasPartialCost: false,
    activeDays: 27,
    cacheShare: 0.98,
    newInputTokens: 20_000_000,
    outputTokens: 30_000_000,
    cacheTokens: 12_650_000_000,
    reasoningTokens: 9_700_000,
    daily: [{ day: "2026-09-03", totalTokens: 100, claudeTokens: 40, codexTokens: 60 }],
    providers: [
      { id: "claude", label: "Claude", enabled: true, hasData: true, lastModel: "claude-opus-5", lastProject: "ai/raccoon", totalTokens: 5_000_000_000, sessions: 156, activityCount: 20_367, activityLabel: "turns", estimatedCostUsd: 4296.16, hasPartialCost: false },
      { id: "codex", label: "Codex", enabled: true, hasData: true, lastModel: "gpt-5.6-sol", lastProject: "ai/raccoon", totalTokens: 7_700_000_000, sessions: 267, activityCount: 58_535, activityLabel: "events", estimatedCostUsd: 9881.98, hasPartialCost: false },
      { id: "opencode", label: "OpenCode", enabled: false, hasData: false, lastModel: null, lastProject: null, totalTokens: 0, sessions: 0, activityCount: 0, activityLabel: "events", estimatedCostUsd: null, hasPartialCost: false },
    ],
    updatedAt: Date.parse("2026-09-03T12:00:00Z"),
  } satisfies StatsUsageSnapshot,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  api: { statsUsageSnapshot: vi.fn(), statsUsageRefresh: vi.fn() },
}));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));

const { StatsUsageView } = await import("./StatsUsageView");

const { statsUsageStore } = await import("@/lib/statsUsageStore");
const saved = (patch: Partial<StatsUsageState> = {}): StatsUsageState => ({
  scope: "test", generation: 1, snapshot, refreshing: false, error: null, ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.mocked(api.statsUsageSnapshot).mockReset().mockResolvedValue(saved());
  vi.mocked(api.statsUsageRefresh).mockReset().mockResolvedValue(saved());
});
afterEach(() => { cleanup(); statsUsageStore.dispose(); });

describe("StatsUsageView", () => {
  it("renders a persisted snapshot before a delayed refresh finishes, without dimming", async () => {
    const refresh = deferred<StatsUsageState>();
    vi.mocked(api.statsUsageRefresh).mockReturnValue(refresh.promise);
    const view = render(<StatsUsageView />);
    expect(screen.queryByText("Reading local transcripts…")).toBeNull();
    expect(await screen.findByText("12.7B")).toBeTruthy();
    expect(screen.queryByText("Reading local transcripts…")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Refreshing…");
    expect(view.container.querySelector(".opacity-70")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh local analytics" }).hasAttribute("disabled")).toBe(true);
    await act(async () => refresh.resolve(saved()));
  });

  it("keeps data and the refresh job across navigation; publishes the whole result together", async () => {
    const refresh = deferred<StatsUsageState>();
    vi.mocked(api.statsUsageRefresh).mockReturnValue(refresh.promise);
    const first = render(<StatsUsageView />);
    await screen.findByText("12.7B");
    const oldTimestamp = screen.getByText(/ · Updated /).textContent;
    first.unmount();
    const second = render(<StatsUsageView />);
    expect(screen.getByText("12.7B")).toBeTruthy();
    expect(screen.getByText(/ · Updated /).textContent).toBe(oldTimestamp);
    expect(api.statsUsageRefresh).toHaveBeenCalledTimes(1);
    second.unmount();
    const updated = {
      ...snapshot, totalTokens: 42_000, updatedAt: snapshot.updatedAt + 86_400_000,
      app: { ...snapshot.app, agentsSpawned: 99 },
      daily: [{ day: "2026-09-03", totalTokens: 42_000, claudeTokens: 0, codexTokens: 42_000 }],
      providers: snapshot.providers.map((p) => ({ ...p, sessions: 1 })),
    };
    await act(async () => refresh.resolve(saved({ snapshot: updated, generation: 2 })));
    // A new visit reads the shared result synchronously, even before IPC returns.
    vi.mocked(api.statsUsageSnapshot).mockReturnValue(new Promise(() => {}));
    render(<StatsUsageView />);
    expect(screen.getByText("42K")).toBeTruthy();
    expect(screen.getByText("99")).toBeTruthy();
    expect(screen.getByText("2 sessions")).toBeTruthy();
    expect(screen.getByText(/ · Updated /).textContent).not.toBe(oldTimestamp);
  });

  it.each(["refresh", "read", "persist"])("retains saved data and its timestamp after a %s failure, with Retry", async (failure) => {
    render(<StatsUsageView />);
    await screen.findByText("12.7B");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(""));
    const timestamp = screen.getByText(/ · Updated /).textContent;
    if (failure === "read") vi.mocked(api.statsUsageSnapshot).mockRejectedValueOnce(new Error("read failed"));
    else if (failure === "refresh") vi.mocked(api.statsUsageRefresh).mockRejectedValueOnce(new Error("scan failed"));
    else vi.mocked(api.statsUsageRefresh).mockResolvedValueOnce(saved({ error: "persist failed" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh local analytics" }));
    await screen.findByRole("alert");
    expect(screen.getByText("12.7B")).toBeTruthy();
    expect(screen.getByText(/ · Updated /).textContent).toBe(timestamp);
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows initial loading only without a valid saved result, then rehydrates on frontend restart", async () => {
    const refresh = deferred<StatsUsageState>();
    vi.mocked(api.statsUsageSnapshot).mockResolvedValueOnce(saved({ snapshot: null }));
    vi.mocked(api.statsUsageRefresh).mockReturnValueOnce(refresh.promise);
    const first = render(<StatsUsageView />);
    await screen.findByText("Reading local transcripts…");
    await act(async () => refresh.resolve(saved()));
    await screen.findByText("12.7B");
    first.unmount();
    statsUsageStore.dispose();
    vi.mocked(api.statsUsageRefresh).mockReturnValue(new Promise(() => {}));
    render(<StatsUsageView />);
    await screen.findByText("12.7B");
    expect(screen.queryByText("Reading local transcripts…")).toBeNull();
  });

  it("renders the transcript-backed overview and provider totals", async () => {
    render(<StatsUsageView />);
    expect(screen.getByText("TerminalX activity plus local Claude and Codex token analytics.")).toBeTruthy();
    expect(await screen.findByText("12.7B")).toBeTruthy();
    expect(screen.getByText("98%")).toBeTruthy();
    expect(screen.getByText("423 sessions")).toBeTruthy();
    expect(screen.getByText("gpt-5.6-sol · ai/raccoon")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Agents spawned counts each live start of work/)).toBeTruthy();
    expect(screen.getByText(/Latest 30 local calendar dates/)).toBeTruthy();
  });

  it("shows lifetime counters without a provider cache, through a failed refresh", async () => {
    const refresh = deferred<StatsUsageState>();
    const appOnly = saved({ snapshot: null, activity: snapshot.app });
    vi.mocked(api.statsUsageSnapshot).mockResolvedValue(appOnly);
    vi.mocked(api.statsUsageRefresh).mockReturnValue(refresh.promise);
    render(<StatsUsageView />);
    expect(await screen.findByText("7")).toBeTruthy();
    expect(screen.getByText("Reading local transcripts…")).toBeTruthy();
    expect(screen.queryByText("Total tokens")).toBeNull();
    await act(async () => refresh.resolve({ ...appOnly, error: "Provider history is unreadable" }));
    expect(screen.getByRole("alert").textContent).toContain("Provider history is unreadable");
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("PRs created")).toBeTruthy();
    expect(screen.queryByText("Reading local transcripts…")).toBeNull();
    expect(screen.queryByText("Total tokens")).toBeNull();
  });

  it("keeps known totals visible alongside an accounting error", async () => {
    const withError = saved({ snapshot: {
      ...snapshot, app: { ...snapshot.app, accountingError: "Activity recovery is incomplete: unreadable history" },
    } });
    vi.mocked(api.statsUsageSnapshot).mockResolvedValue(withError);
    vi.mocked(api.statsUsageRefresh).mockResolvedValue(withError);
    render(<StatsUsageView />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Activity recovery is incomplete: unreadable history");
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("does not replace a valid snapshot with zero when a later read fails", async () => {
    render(<StatsUsageView />);
    await screen.findByText("7");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(""));
    vi.mocked(api.statsUsageSnapshot).mockRejectedValueOnce(new Error("Activity history could not be loaded"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh local analytics" }));
    expect(await screen.findByText(/Activity history could not be loaded/)).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });
});
