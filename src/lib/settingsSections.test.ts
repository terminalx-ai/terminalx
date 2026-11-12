import { describe, expect, it } from "vitest";
import { noteExperimentalSettings } from "./experimentalSettings";
import { settingsSectionOffered } from "./settingsSections";

describe("sections behind an Experimental switch", () => {
  it("offers Orchestrator only while orchestration runs are on, and every other section always", () => {
    try {
      noteExperimentalSettings({ nativeCodex: false, orchestratorRuns: false });
      expect(settingsSectionOffered("orchestrator")).toBe(false);
      expect(settingsSectionOffered("general")).toBe(true);
      noteExperimentalSettings({ nativeCodex: false, orchestratorRuns: true });
      expect(settingsSectionOffered("orchestrator")).toBe(true);
    } finally { noteExperimentalSettings({ nativeCodex: false, orchestratorRuns: false }); }
  });
});
