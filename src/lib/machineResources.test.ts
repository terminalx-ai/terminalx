import { describe, expect, it } from "vitest";
import type { RuntimeResources } from "@terminalx/portable/workspaceGit";
import { gbText, resourceMeters, resourcesSummary, updatedText } from "./machineResources";

const GB = 1_000_000_000;
const resources = (patch: Partial<RuntimeResources> = {}): RuntimeResources => ({
  v: 1,
  memory: { totalBytes: 16 * GB, availableBytes: 6.8 * GB },
  storage: { totalBytes: 500 * GB, availableBytes: 212 * GB, totalInodes: 0, availableInodes: 0 },
  cpu: { cores: 8, usage: 0.38 },
  observedAt: 1,
  ...patch,
});

describe("a machine's resources (PRO-350, 21.10)", () => {
  it("says cores and how fresh the reading is", () => {
    expect(resourcesSummary(resources(), 1_000, 3_000)).toBe("8 cores · updated just now");
    expect(resourcesSummary(resources({ cpu: undefined }), 1_000, 3_000)).toBe("updated just now");
    expect(updatedText(0, 40_000)).toBe("updated 40 s ago");
    expect(updatedText(0, 180_000)).toBe("updated 3 min ago");
  });

  it("shows CPU %, memory used of total and free disk, each with a bar", () => {
    const meters = resourceMeters(resources());
    expect(meters.map((meter) => [meter.id, meter.label, meter.value])).toEqual([
      ["cpu", "CPU", "38%"],
      ["memory", "Memory", "9.2 of 16 GB"],
      ["disk", "Disk", "212 GB free"],
    ]);
    expect(meters[0].fraction).toBeCloseTo(0.38);
    expect(meters[1].fraction).toBeCloseTo(0.575);
    expect(meters[2].fraction).toBeCloseTo(0.576);
  });

  it("leaves CPU out for an older runtime, and waits for a second reading's usage", () => {
    expect(resourceMeters(resources({ cpu: undefined })).map((meter) => meter.id)).toEqual(["memory", "disk"]);
    expect(resourceMeters(resources({ cpu: { cores: 8, usage: null } }))[0]).toEqual({ id: "cpu", label: "CPU", value: "…", fraction: 0 });
    expect(resourceMeters(resources({ cpu: null, memory: null, storage: null }))).toEqual([]);
  });

  it("writes gigabytes as a spec sheet does", () => {
    expect(gbText(16 * GB)).toBe("16 GB");
    expect(gbText(9.24 * GB)).toBe("9.2 GB");
    expect(gbText(212.4 * GB)).toBe("212 GB");
  });
});
