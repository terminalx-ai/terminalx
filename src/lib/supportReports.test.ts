import { expect, it } from "vitest";
import { canSubmitReport, coverageLabel, localReportSource, prepareReport, reportExport, reportWindow } from "@terminalx/portable/supportReports";

it("projects only fixed events and classifications, within the supported window and count", () => {
  const to = 3000;
  const window = { from: 2000, to };
  const secret = "ghp_BOGUS_TEST_TOKEN_never_export";
  const events = Array.from({ length: 101 }, (_, index) => ({ at: to - index, kind: "connected", classification: "relay", detail: secret }));
  const report = localReportSource({ appVersion: secret, platform: "ios" }, window, ["connected"],
    [...events, { at: to + 1, kind: "connected" }, { at: to, kind: secret }, { at: to - 102, kind: "connected", classification: secret }],
    ["relay"], 2000);
  expect(report).toMatchObject({ appVersion: "unknown", status: "included", truncated: true });
  expect(report.events).toHaveLength(100);
  expect(report.coverage).toEqual({ from: 2901, to });
  expect(report.events.at(-1)).toEqual({ at: to - 99, kind: "connected", classification: "relay" });
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(reportWindow(to, 24).to).toBe(to);
});

it("keeps an available server snapshot when the local collector fails and exports only local fields", async () => {
  const snapshot = { key: "private-key", from: 1000, to: 2000, server: {
    status: "included" as const, capturedAt: 2000, truncated: false, events: [{ at: 1500, kind: "server-only" }],
  } };
  const preview = await prepareReport({ to: 2000, hours: 1, server: true }, async () => snapshot,
    async () => { throw new Error("collector failure"); }, { platform: "macos", appVersion: "0.2.40" });
  expect(preview).toMatchObject({ ...snapshot, local: { status: "failed", coverage: null, events: [] } });
  expect(canSubmitReport(preview, false)).toBe(true);
  expect(canSubmitReport(preview, true)).toBe(false);
  expect(JSON.parse(reportExport("desktop", preview, undefined, preview.local))).toEqual({
    v: 1, from: 1000, to: 2000, desktop: preview.local,
  });
});

it("distinguishes uncovered and partially covered windows from observed empty history", () => {
  const metadata = { platform: "ios", appVersion: "0.2.40" };
  const window = { from: 1000, to: 2000 };
  const collect = (retainedSince: number) => localReportSource(metadata, window, [], [], [], retainedSince);
  expect(collect(3000)).toMatchObject({ status: "empty", truncated: false, coverage: null });
  expect(coverageLabel(collect(3000), window)).toMatch(/does not cover/);
  expect(collect(1500).coverage).toEqual({ from: 1500, to: 2000 });
  expect(coverageLabel(collect(1500), window)).toMatch(/covers only/);
  expect(coverageLabel(collect(1000), window)).toBeNull();
});
