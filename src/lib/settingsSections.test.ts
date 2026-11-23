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

describe("Settings → Machines for everyone (PRO-342, PRO-360)", () => {
  it("is offered, with every row findable, whatever the Experimental switches say", () => {
    const rows = settingsInSection("machines");
    expect(rows.map((row) => row.id)).toEqual(["machines.allowOperating", "machines.listen", "machines.thisMac", "machines.pairingCode", "machines.yours", "machines.computers"]);
    noteExperimentalSettings({ nativeCodex: false, orchestratorRuns: false, localVmTasks: false });
    expect(settingsSectionOffered("machines")).toBe(true);
    for (const row of rows) expect(settingOffered(row)).toBe(true);
    // Experimental no longer has a Machines switch.
    expect(settingsInSection("experimental").map((row) => row.id)).not.toContain("experimental.machines");
    expect(PALETTE_SECTIONS.some((section) => section.id === "machines")).toBe(true);
    expect(SETTINGS_SECTIONS.machines).toMatchObject({ title: "Machines", entry: "machines.allowOperating" });
  });
});

describe("the Projects group (PRO-131)", () => {
  it("labels the group and a project's page 'Projects', the templates page 'Project templates', and keeps their ids", () => {
    // PRO-464: projects and organizations share one heading.
    expect(SETTINGS_GROUPS).toEqual(["Personal", "Agents & environment", "Projects & organizations", "More"]);
    expect(SETTINGS_SECTIONS.repositories).toMatchObject({ title: "Projects", group: "Projects & organizations", entry: "repositories.rootPath" });
    expect(SETTINGS_SECTIONS.projects).toMatchObject({ title: "Project templates", group: "Projects & organizations", entry: "projects.templates" });
    expect(SETTINGS_SECTIONS.organizations).toMatchObject({ group: "Projects & organizations" });
    const palette = Object.fromEntries(PALETTE_SECTIONS.map((section) => [section.id, section.title]));
    expect(palette.repositories).toBe("Projects");
    expect(palette.projects).toBe("Project templates");
  });
});
