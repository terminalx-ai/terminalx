import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_ROWS } from "@/components/settings/settingsRegistry";
import { noteExperimentalSettings } from "@/lib/experimentalSettings";
import { settingOffered } from "@/lib/settingsSections";
import { groupSettingsByPage, searchSettings, SETTINGS_SEARCH_LIMIT, settingsSearchSummary } from "./settingsSearch";

const orchestratorRuns = (on: boolean) => noteExperimentalSettings({ nativeCodex: false, sessionCost: false, orchestratorRuns: on });

beforeEach(() => orchestratorRuns(false));
afterEach(() => orchestratorRuns(false));

describe("settings row search", () => {
  it("ranks a title match ahead of a description match ahead of a search term", () => {
    // "When quitting TerminalX" (title), "When a session warns…" (description), and "when" as a search term.
    const ids = searchSettings("when").map((match) => match.id);
    const title = ids.indexOf("general.quitBehavior");
    const description = ids.indexOf("storage.recoveryIncidents");
    const term = ids.indexOf("storage.mergedCleanup");
    expect(title).toBe(0);
    expect(description).toBeGreaterThan(title);
    expect(term).toBeGreaterThan(description);
  });

  it("finds the font rows for 'font', and only those", () => {
    const ids = searchSettings("font").map((match) => match.id);
    expect(ids).toContain("appearance.textSize");
    // Not every row whose description happens to hold an f, an o, an n and a t in order.
    expect(ids).toEqual(["appearance.textSize"]);
  });

  it("finds nothing for a mistyped second word, as the empty state expects", () => {
    expect(searchSettings("dark mdoe")).toEqual([]);
    expect(searchSettings("dark mode").map((match) => match.id)).toContain("appearance.mode");
  });

  it("forgives a typo in a title but not in a description", () => {
    expect(searchSettings("sonuds")).toEqual([]);
    expect(searchSettings("thme").map((match) => match.id)).toContain("appearance.theme");
  });

  it("keeps finding what the old section search found, now as rows", () => {
    const first = (query: string) => searchSettings(query)[0]?.id;
    expect(first("data privacy")).toBe("general.dataPrivacy");
    expect(first("archive script")).toBe("repositories.scripts");
    expect(first("setup script")).toBe("repositories.scripts");
    expect(first("settings file")).toBe("general.settingsFile");
    expect(first("worktreeinclude")).toBe("repositories.filesToCopy");
    expect(first("files to copy")).toBe("repositories.filesToCopy");
    expect(first("variables")).toBe("environment.variables");
    expect(first("local vm")).toBe("localVms.tasks");
    expect(searchSettings("hotkeys").map((match) => match.section)).toContain("shortcuts");
    expect(searchSettings("zzzz-no-such-setting")).toEqual([]);
  });

  it("finds the repository Actions, Preview URLs and Environment pages", () => {
    const first = (query: string) => searchSettings(query)[0]?.id;
    expect(first("preview urls")).toBe("repositories.previewUrls");
    expect(first("localhost port")).toBe("repositories.previewUrls");
    expect(first("dev server")).toBe("repositories.actions");
    expect(searchSettings("actions").map((match) => match.id)).toContain("repositories.actions");
    expect(first("dotenv")).toBe("repositories.environment");
    expect(searchSettings("keychain").map((match) => match.id)).toContain("repositories.environment");
  });

  it("finds every project row under 'Projects', by its new name and the old one (PRO-131)", () => {
    const first = (query: string) => searchSettings(query)[0]?.id;
    expect(first("worktree folder")).toBe("repositories.workspacesPath");
    expect(first("workspaces path")).toBe("repositories.workspacesPath");
    expect(first("root path")).toBe("repositories.rootPath");
    expect(first("project templates")).toBe("projects.templates");
    for (const query of ["preview urls", "files to copy"]) {
      const [match] = searchSettings(query);
      expect(match.sectionTitle).toBe("Projects");
    }
    expect(searchSettings("project templates")[0].sectionTitle).toBe("Project templates");
    // Every row a project or the templates page holds is still found by its title.
    for (const row of SETTINGS_ROWS.filter((row) => (row.section === "repositories" || row.section === "projects") && settingOffered(row))) {
      expect(searchSettings(row.title).map((match) => match.id), row.id).toContain(row.id);
    }
  });

  it("returns the row, its page and highlight ranges for title and description", () => {
    const [sounds] = searchSettings("sounds");
    expect(sounds.id).toBe("general.sounds");
    expect(sounds.section).toBe("general");
    expect(sounds.sectionTitle).toBe("General");
    expect(sounds.row.title).toBe("Sounds");
    expect(sounds.titleRanges).toEqual([{ start: 0, end: 6 }]);

    const tone = searchSettings("tone").find((match) => match.id === "general.sounds")!;
    expect(tone.titleRanges).toEqual([]);
    expect(tone.descriptionRanges.map(({ start, end }) => tone.row.description.slice(start, end))).toEqual(["tone"]);
  });

  it("returns at most 30 rows", () => {
    expect(SETTINGS_SEARCH_LIMIT).toBe(30);
    expect(SETTINGS_ROWS.filter((row) => row.title.toLowerCase().includes("a")).length).toBeGreaterThan(30);
    expect(searchSettings("a")).toHaveLength(30);
  });

  it("finds nothing for a blank or unmatched query", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
    expect(searchSettings("zzzz-no-such-setting")).toEqual([]);
  });

  it("finds Orchestrator rows only while the Experimental switch is on", () => {
    expect(searchSettings("budget").some((match) => match.section === "orchestrator")).toBe(false);
    // The switch itself, in Experimental, is always found.
    expect(searchSettings("orchestration runs")[0].id).toBe("experimental.orchestratorRuns");
    orchestratorRuns(true);
    const ids = searchSettings("budget").map((match) => match.id);
    expect(ids.slice(0, 2)).toEqual(["orchestrator.budgetDollars", "orchestrator.budgetPoints"]);
  });

  it("does not find a repository's Orchestrator row while the switch is off, and finds it the moment it is on", () => {
    // The row is on the Repositories page, which is always offered: the switch gates the row itself.
    const named = () => searchSettings("orchestrator").map((match) => match.id);
    expect(named()).not.toContain("repositories.orchestrator");
    expect(searchSettings("orchestrator").some((match) => match.row.title.startsWith("Orchestrator") || match.section === "orchestrator")).toBe(false);
    expect(named()).toContain("experimental.orchestratorRuns");
    orchestratorRuns(true);
    expect(named()).toContain("repositories.orchestrator");
    expect(searchSettings("orchestrator")[0].row.title).toBe("Orchestrator");
    orchestratorRuns(false);
    expect(named()).not.toContain("repositories.orchestrator");
  });

  it("offers every row behind a switch only while that switch is on, and every other row always", () => {
    const behind = SETTINGS_ROWS.filter((row) => "requires" in row && row.requires);
    expect(behind.map((row) => row.id)).toEqual(["repositories.orchestrator"]);
    expect(behind.every((row) => !settingOffered(row))).toBe(true);
    orchestratorRuns(true);
    expect(behind.every((row) => settingOffered(row))).toBe(true);
    orchestratorRuns(false);
    // Off until the switches are read, as for a section.
    expect(SETTINGS_ROWS.filter((row) => !("requires" in row && row.requires) && row.section !== "orchestrator").every((row) => settingOffered(row))).toBe(true);
  });

  it("groups matches by page in order of their best match and counts them", () => {
    const matches = searchSettings("sidebar");
    const pages = groupSettingsByPage(matches);
    expect(pages.map((page) => page.section)).toEqual([...new Set(matches.map((match) => match.section))]);
    expect(pages.flatMap((page) => page.matches)).toHaveLength(matches.length);
    for (const page of pages) for (const match of page.matches) expect(match.section).toBe(page.section);
    expect(pages.find((page) => page.section === "appearance")?.title).toBe("Appearance");
    expect(settingsSearchSummary(matches)).toBe(`${matches.length} settings on ${pages.length} pages`);
    expect(settingsSearchSummary(searchSettings("sounds").slice(0, 1))).toBe("1 setting on 1 page");
    expect(settingsSearchSummary([])).toBe("0 settings on 0 pages");
  });
});
