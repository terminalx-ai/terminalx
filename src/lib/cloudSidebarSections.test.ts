import { describe, expect, it } from "vitest";
import { freeSectionName, groupIntoSections } from "./cloudSidebarSections";
import type { CloudProject } from "@/types/target";

// PRO-23: the reader's own sections of an organization's cloud projects.

const project = (identity: string): CloudProject => ({ key: `cloud:org-a:${identity}`, orgId: "org-a", identity, fullName: identity, selected: true, pinned: false, blank: false, workspaces: [] });

describe("grouping projects into sections", () => {
  const projects = [project("acme/api"), project("acme/docs"), project("acme/web")];

  it("keeps the sidebar's own order inside each section and lists the rest as ungrouped", () => {
    const grouped = groupIntoSections(projects, [
      { id: "b", name: "Parked", projects: ["acme/web", "acme/api"] },
      { id: "a", name: "Empty", projects: [] },
    ]);
    expect(grouped.sections.map(({ section, projects: inSection }) => [section.name, inSection.map((p) => p.identity)])).toEqual([
      ["Parked", ["acme/api", "acme/web"]],
      ["Empty", []],
    ]);
    expect(grouped.ungrouped.map((p) => p.identity)).toEqual(["acme/docs"]);
  });

  it("puts a project named by two sections (a hand-edited file) in the first only, and skips projects not shown", () => {
    const grouped = groupIntoSections(projects, [
      { id: "a", name: "One", projects: ["acme/api", "acme/gone"] },
      { id: "b", name: "Two", projects: ["acme/api"] },
    ]);
    expect(grouped.sections.map(({ projects: inSection }) => inSection.map((p) => p.identity))).toEqual([["acme/api"], []]);
  });
});

describe("a new section's name", () => {
  it("is the first free one", () => {
    expect(freeSectionName([])).toBe("New section");
    expect(freeSectionName([{ id: "a", name: "new section", projects: [] }, { id: "b", name: "New section 2", projects: [] }])).toBe("New section 3");
  });
});
