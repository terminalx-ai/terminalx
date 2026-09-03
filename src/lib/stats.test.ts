import { describe, expect, it } from "vitest";
import { formatAgentTime, formatTokens, heatmapDays, intensity } from "@/lib/stats";

describe("stats helpers", () => {
  it("formats token totals and work time compactly", () => {
    expect(formatTokens(12_700_000_000)).toBe("12.7B");
    expect(formatTokens(9_750_000)).toBe("9.75M");
    expect(formatAgentTime((76 * 24 + 4) * 3_600_000)).toBe("76d 4h");
  });

  it("pads the six-week heatmap and assigns relative levels", () => {
    const days = heatmapDays(
      [{ day: "2026-09-03", totalTokens: 100, claudeTokens: 40, codexTokens: 60 }],
      new Date(2026, 8, 3),
    );
    expect(days).toHaveLength(42);
    expect(days.at(-1)).toMatchObject({ day: "2026-09-03", level: 4 });
    expect(days.at(-2)?.level).toBe(0);
    expect(intensity(25, 100)).toBe(1);
    expect(intensity(76, 100)).toBe(4);
  });
});
