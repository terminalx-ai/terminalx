import { expect, it } from "vitest";
import { localReportSource, reportWindow } from "@terminalx/portable/supportReports";

it("projects only fixed events and classifications, within the supported window and count", () => {
  const to = 3000;
  const window = { from: 2000, to };
  const secret = "ghp_BOGUS_TEST_TOKEN_never_export";
  const events = Array.from({ length: 101 }, (_, index) => ({ at: to - index, kind: "connected", classification: "relay", detail: secret }));
  const report = localReportSource({ appVersion: secret, platform: "ios" }, window, ["connected"],
    [...events, { at: to + 1, kind: "connected" }, { at: to, kind: secret }, { at: to - 102, kind: "connected", classification: secret }],
    ["relay"]);
  expect(report).toMatchObject({ appVersion: "unknown", status: "included", truncated: true });
  expect(report.events).toHaveLength(100);
  expect(report.events.at(-1)).toEqual({ at: to - 99, kind: "connected", classification: "relay" });
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(reportWindow(to, 24).to).toBe(to);
});
