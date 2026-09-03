import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatsUsageSnapshot } from "@/lib/api";

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
  api: { statsUsageSnapshot: vi.fn().mockResolvedValue(snapshot) },
}));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));

const { StatsUsageView } = await import("./StatsUsageView");

afterEach(cleanup);

describe("StatsUsageView", () => {
  it("renders the transcript-backed overview and provider totals", async () => {
    render(<StatsUsageView />);

    expect(await screen.findByText("12.7B")).toBeTruthy();
    expect(screen.getByText("98%")).toBeTruthy();
    expect(screen.getByText("423 sessions")).toBeTruthy();
    expect(screen.getByText("gpt-5.6-sol · ai/raccoon")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable" }).hasAttribute("disabled")).toBe(true);
  });
});
