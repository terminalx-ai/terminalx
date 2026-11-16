import { describe, expect, it } from "vitest";
import { noteExperimentalSettings } from "./experimentalSettings";
import { SETTINGS_SECTIONS as PALETTE_SECTIONS, settingOffered, settingsSectionOffered } from "./settingsSections";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, settingsInSection } from "@/components/settings/settingsRegistry";

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

describe("Settings → Machines behind Experimental → Machines (PRO-342)", () => {
  it("is hidden, and none of its rows findable, unless experimental.machines is on", () => {
    const rows = settingsInSection("machines");
    expect(rows.map((row) => row.id)).toEqual(["machines.allowOperating", "machines.thisMac", "machines.pairingCode", "machines.yours", "machines.computers"]);
    try {
      noteExperimentalSettings({ nativeCodex: false, orchestratorRuns: true, localVmTasks: true });
      expect(settingsSectionOffered("machines")).toBe(false);
      for (const row of rows) expect(settingOffered(row)).toBe(false);
      noteExperimentalSettings({ nativeCodex: false, machines: true });
      expect(settingsSectionOffered("machines")).toBe(true);
      for (const row of rows) expect(settingOffered(row)).toBe(true);
      noteExperimentalSettings({ nativeCodex: false, machines: false });
      expect(settingsSectionOffered("machines")).toBe(false);
    } finally { noteExperimentalSettings({ nativeCodex: false, machines: false, orchestratorRuns: false, localVmTasks: false }); }
    expect(PALETTE_SECTIONS.some((section) => section.id === "machines")).toBe(true);
    expect(SETTINGS_SECTIONS.machines).toMatchObject({ title: "Machines", entry: "machines.allowOperating" });
  });
});

describe("the Projects group (PRO-131)", () => {
  it("labels the group and a project's page 'Projects', the templates page 'Project templates', and keeps their ids", () => {
    expect(SETTINGS_GROUPS).toEqual(["Personal", "Agents & environment", "Projects", "Admin", "More"]);
    expect(SETTINGS_SECTIONS.repositories).toMatchObject({ title: "Projects", group: "Projects", entry: "repositories.rootPath" });
    expect(SETTINGS_SECTIONS.projects).toMatchObject({ title: "Project templates", group: "Projects", entry: "projects.templates" });
    const palette = Object.fromEntries(PALETTE_SECTIONS.map((section) => [section.id, section.title]));
    expect(palette.repositories).toBe("Projects");
    expect(palette.projects).toBe("Project templates");
  });
});
