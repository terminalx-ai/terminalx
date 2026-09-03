import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "@/lib/api";

const { openStats, statusState } = vi.hoisted(() => ({
  openStats: vi.fn(),
  statusState: {
    settings: { visible: true, usage: true, resources: false, percent: "used" as "used" | "remaining" },
    usage: { windows: [] } as UsageSnapshot,
    usageRefreshing: false,
    resources: { agentCount: 0, orphanCount: 0, rssBytes: null, pressure: null },
    resourceSample: null,
    resourcesRefreshing: false,
    ready: true,
  },
}));

vi.mock("@/lib/status", () => ({
  refreshResourceSample: vi.fn(),
  refreshUsage: vi.fn(),
  removeResourceOptimistically: vi.fn(),
  setStatusSettings: vi.fn(),
  useStatus: () => statusState,
}));
vi.mock("@/lib/sessions", () => ({
  openStats,
  selectSession: vi.fn(),
  setActiveTab: vi.fn(),
  useSessionStore: () => ({
    harnesses: [
      { id: "claude", available: true },
      { id: "codex", available: true },
    ],
  }),
}));
vi.mock("@/lib/statusPolling", () => ({ useResourceSampling: vi.fn() }));

const { StatusBar } = await import("./StatusBar");

let statusBarWidth = 1_000;

class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: { width: statusBarWidth } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  openStats.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  statusBarWidth = 1_000;
  statusState.settings.percent = "used";
  const now = Date.now();
  statusState.usage = {
    windows: [
      { agent: "claude", key: "five_hour", label: "5h", usedPercent: 12, resetsAt: now + (2 * 60 + 10) * 60_000, windowMinutes: 300, updatedAt: now, stale: false },
      { agent: "claude", key: "seven_day", label: "7d", usedPercent: 41, resetsAt: now + (5 * 24 + 6) * 60 * 60_000, windowMinutes: 10_080, updatedAt: now, stale: false },
      { agent: "claude", key: "fable_weekly", label: "Fable", usedPercent: 82, resetsAt: now + (4 * 24 + 2) * 60 * 60_000, windowMinutes: 10_080, updatedAt: now, stale: false },
      { agent: "codex", key: "five_hour", label: "5h", usedPercent: 23, resetsAt: now + (3 * 60 + 5) * 60_000, windowMinutes: 300, updatedAt: now, plan: "pro", stale: false },
      { agent: "codex", key: "weekly", label: "weekly", usedPercent: 52, resetsAt: now + (6 * 24 + 4) * 60 * 60_000, windowMinutes: 10_080, updatedAt: now, plan: "pro", stale: false },
    ],
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("status bar usage", () => {
  it("renders the 5h, 7d, and Fable windows separately in the full tier", () => {
    const { container } = render(<StatusBar />);

    const claude = container.querySelector('[data-usage-agent="claude"]');
    const codex = container.querySelector('[data-usage-agent="codex"]');
    expect(claude).not.toBeNull();
    expect(codex).not.toBeNull();

    const claudeSegment = within(claude as HTMLElement);
    expect(claudeSegment.getByText("Claude")).toBeTruthy();
    expect(claudeSegment.getByText("5h 12%")).toBeTruthy();
    expect(claudeSegment.getByText("2h 10m", { exact: false })).toBeTruthy();
    expect(claudeSegment.getByText("7d 41%")).toBeTruthy();
    expect(claudeSegment.getByText("5d 6h", { exact: false })).toBeTruthy();
    expect(claudeSegment.getByText("Fable 82%")).toBeTruthy();
    expect(claudeSegment.getByText("4d 2h", { exact: false })).toBeTruthy();

    const codexSegment = within(codex as HTMLElement);
    expect(codexSegment.getByText("Codex")).toBeTruthy();
    expect(codexSegment.getByText("pro", { exact: false })).toBeTruthy();
    expect(codexSegment.getByText("5h 23%")).toBeTruthy();
    expect(codexSegment.getByText("3h 5m", { exact: false })).toBeTruthy();
    expect(codexSegment.getByText("7d 52%")).toBeTruthy();
    expect(codexSegment.getByText("6d 4h", { exact: false })).toBeTruthy();
  });

  it("uses Fable as the tightest compact window with the remaining preference", () => {
    statusBarWidth = 800;
    statusState.settings.percent = "remaining";
    const { container, getByRole } = render(<StatusBar />);

    expect(container.querySelector("[data-status-bar]")?.getAttribute("data-tier")).toBe("compact");
    const claude = container.querySelector('[data-usage-agent="claude"]');
    const claudeSegment = within(claude as HTMLElement);
    expect(claudeSegment.getByText("Fable 18%")).toBeTruthy();
    expect(claudeSegment.queryByText("5h 88%")).toBeNull();
    expect(getByRole("button", { name: /Claude Fable 18% remaining, resets 4d 2h/ })).toBeTruthy();
  });

  it("keeps Fable in the icon-only tier's accessible usage summary", () => {
    statusBarWidth = 400;
    const { container, getByRole } = render(<StatusBar />);

    expect(container.querySelector("[data-status-bar]")?.getAttribute("data-tier")).toBe("icon");
    const claude = container.querySelector('[data-usage-agent="claude"]');
    expect(within(claude as HTMLElement).queryByText("Claude")).toBeNull();
    expect(claude?.querySelector("i")?.className).toContain("bg-destructive");
    expect(getByRole("button", { name: /Claude Fable 82% used, resets 4d 2h/ })).toBeTruthy();
  });

  it("opens the full stats view from the usage popover footer", () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: /Claude 5h 12% used/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open Stats & Usage" }));
    expect(openStats).toHaveBeenCalledOnce();
  });
});
