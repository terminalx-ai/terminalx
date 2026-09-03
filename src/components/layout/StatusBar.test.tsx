import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "@/lib/api";

const { statusState } = vi.hoisted(() => ({
  statusState: {
    settings: { visible: true, usage: true, resources: false, percent: "used" as const },
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

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const now = Date.now();
  statusState.usage = {
    windows: [
      { agent: "claude", key: "five_hour", label: "5h", usedPercent: 12, resetsAt: now + (2 * 60 + 10) * 60_000, windowMinutes: 300, updatedAt: now, stale: false },
      { agent: "claude", key: "seven_day", label: "7d", usedPercent: 41, resetsAt: now + (5 * 24 + 6) * 60 * 60_000, windowMinutes: 10_080, updatedAt: now, stale: false },
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
  it("renders the 5h and 7d windows separately for both agents in the full tier", () => {
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

    const codexSegment = within(codex as HTMLElement);
    expect(codexSegment.getByText("Codex")).toBeTruthy();
    expect(codexSegment.getByText("pro", { exact: false })).toBeTruthy();
    expect(codexSegment.getByText("5h 23%")).toBeTruthy();
    expect(codexSegment.getByText("3h 5m", { exact: false })).toBeTruthy();
    expect(codexSegment.getByText("7d 52%")).toBeTruthy();
    expect(codexSegment.getByText("6d 4h", { exact: false })).toBeTruthy();
  });
});
