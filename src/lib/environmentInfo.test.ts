import { describe, expect, it } from "vitest";
import { ENVIRONMENT_TOOLS, environmentReport } from "./environmentInfo";

const report = () => ({ version: 1, observedAt: 1234, tools: ENVIRONMENT_TOOLS.map(([id]) => ({ id, status: "installed", version: "24.22.1" })) });

describe("environment runtime DTO", () => {
  it("accepts the exact tool set and drops unrecognized data", () => {
    expect(environmentReport({ ...report(), environment: { TOKEN: "secret" } })).toEqual(report());
  });
  it("refuses truncated reports, duplicate tools, control characters and nonversions", () => {
    expect(() => environmentReport({ ...report(), tools: [] })).toThrow();
    expect(() => environmentReport({ ...report(), tools: report().tools.map(() => report().tools[0]) })).toThrow();
    for (const version of ["secret", "1.0\u001b[32m", "1.0/path", "1.0@host", "1.0\nTOKEN=foo"]) {
      expect(() => environmentReport({ ...report(), tools: report().tools.map((t) => ({ ...t, version })) })).toThrow();
    }
  });
  it("preserves missing and bounded probe failures instead of showing manifest versions", () => {
    const tools = ENVIRONMENT_TOOLS.map(([id], index) => ({ id, status: ["missing", "error", "timeout"][index % 3] }));
    expect(environmentReport({ ...report(), tools }).tools).toEqual(tools);
  });
});
