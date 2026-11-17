import { describe, expect, it } from "vitest";
import { ENVIRONMENT_TOOLS, environmentReport } from "./environmentInfo";

const report = () => ({ version: 1, observedAt: 1234, tools: ENVIRONMENT_TOOLS.map(([id]) => ({ id, status: "installed", version: "24.22.1" })) });

describe("environment runtime DTO", () => {
  it("accepts the exact tool set and drops unrecognized data", () => {
    expect(environmentReport({ ...report(), environment: { TOKEN: "secret" } })).toEqual(report());
    expect(environmentReport({ ...report(), tools: report().tools.map((tool) => ({ ...tool, path: "/private", output: "TOKEN=secret" })) })).toEqual(report());
  });
  it("refuses unsupported schemas, invalid timestamps and unknown statuses", () => {
    for (const value of [null, [], {}, { ...report(), version: 2 }, ...[0, -1, NaN, Infinity, 1.5, "1234"].map((observedAt) => ({ ...report(), observedAt }))]) {
      expect(() => environmentReport(value)).toThrow();
    }
    expect(() => environmentReport({ ...report(), tools: report().tools.map((tool) => ({ ...tool, status: "unknown" })) })).toThrow();
  });
  it("refuses truncated reports, duplicate tools, control characters and nonversions", () => {
    expect(() => environmentReport({ ...report(), tools: [] })).toThrow();
    expect(() => environmentReport({ ...report(), tools: report().tools.map(() => report().tools[0]) })).toThrow();
    for (const version of ["secret", "1.0\u001b[32m", "1.0/path", "1.0@host", "1.0\nTOKEN=foo", "1.0\n", "1..0", "1.", "1.0a", "1".repeat(33)]) {
      expect(() => environmentReport({ ...report(), tools: report().tools.map((t) => ({ ...t, version })) })).toThrow();
    }
  });
  it("allows tmux's version suffix only for tmux", () => {
    const value = report();
    value.tools = value.tools.map((tool) => tool.id === "tmux" ? { ...tool, version: "3.5a" } : tool);
    expect(environmentReport(value).tools.find((tool) => tool.id === "tmux")).toEqual({ id: "tmux", status: "installed", version: "3.5a" });
  });
  it("preserves missing and bounded probe failures instead of showing manifest versions", () => {
    const tools = ENVIRONMENT_TOOLS.map(([id], index) => ({ id, status: ["missing", "error", "timeout"][index % 3] }));
    expect(environmentReport({ ...report(), tools }).tools).toEqual(tools);
  });
});
