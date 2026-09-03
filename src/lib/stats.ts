import type { UsageDay } from "@/lib/api";

export interface HeatmapDay extends UsageDay {
  level: 0 | 1 | 2 | 3 | 4;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${compact(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${compact(value / 1_000_000)}M`;
  if (value >= 1_000) return `${compact(value / 1_000)}K`;
  return value.toLocaleString();
}

function compact(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "");
}

export function formatCost(value: number | null): string {
  if (value == null) return "n/a";
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function formatAgentTime(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${Math.floor(ms % 3_600_000 / 60_000)}m`;
  const minutes = Math.floor(ms / 60_000);
  return minutes > 0 ? `${minutes}m` : `${Math.floor(ms / 1_000)}s`;
}

export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function heatmapDays(daily: UsageDay[], now = new Date(), count = 42): HeatmapDay[] {
  const byDay = new Map(daily.map((day) => [day.day, day]));
  const days = Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - count + index + 1);
    const key = localDayKey(date);
    return byDay.get(key) ?? { day: key, totalTokens: 0, claudeTokens: 0, codexTokens: 0 };
  });
  const max = Math.max(0, ...days.map((day) => day.totalTokens));
  return days.map((day) => ({
    ...day,
    level: intensity(day.totalTokens, max),
  }));
}

export function intensity(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!value || !max) return 0;
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}
