import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_ROWS } from "@/components/settings/settingsRegistry";
import { noteExperimentalSettings } from "@/lib/experimentalSettings";
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
