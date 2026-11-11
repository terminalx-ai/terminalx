import { describe, expect, it } from "vitest";
import { searchSettingsSections } from "./settingsSections";

describe("settings section search", () => {
  it("finds the privacy control in General", () => {
    expect(searchSettingsSections("data privacy")[0].item.tab).toBe("general");
  });
  it("lists each section once when independent settings features are combined", () => {
    const sections = searchSettingsSections("").map((match) => match.item.tab);
    expect(new Set(sections).size).toBe(sections.length);
    expect(sections.filter((section) => section === "repositories")).toHaveLength(1);
    expect(sections).toContain("environment");
  });

  it("ranks a title ahead of descriptions and search terms", () => {
    const matches = searchSettingsSections("agents");
    expect(matches[0].item.tab).toBe("agents");
    expect(matches[0].primaryRanges).toEqual([{ start: 0, end: 6 }]);
    expect(matches.some((match) => match.item.tab === "organizations")).toBe(true);
  });

  it("finds repository scripts from their lifecycle purpose", () => {
    expect(searchSettingsSections("archive script")[0].item.tab).toBe("repositories");
    expect(searchSettingsSections("setup script")[0].item.tab).toBe("repositories");
  });

  it("finds font size by description and highlights the matching word", () => {
    const [match] = searchSettingsSections("FONT");
    expect(match.item.tab).toBe("appearance");
    expect(match.secondaryRanges.map(({ start, end }) => match.item.secondary.slice(start, end))).toEqual(["font"]);
  });

  it("matches fuzzy titles, aliases, and terms across fields", () => {
    expect(searchSettingsSections("apprnc")[0].item.tab).toBe("appearance");
    expect(searchSettingsSections("hotkeys")[0].item.tab).toBe("shortcuts");
    expect(searchSettingsSections("environment")[0].item.tab).toBe("environment");
    expect(searchSettingsSections("variables")[0].item.tab).toBe("environment");
    expect(searchSettingsSections("appearance text")[0].item.tab).toBe("appearance");
    expect(searchSettingsSections("zzzz-no-such-setting")).toEqual([]);
  });

  it("finds the user settings file in General", () => {
    expect(searchSettingsSections("json")[0].item.tab).toBe("general");
    expect(searchSettingsSections("settings file")[0].item.tab).toBe("general");
  });

  it("finds repository copy settings by their include-file name", () => {
    expect(searchSettingsSections("worktreeinclude")[0].item.tab).toBe("repositories");
    expect(searchSettingsSections("files to copy")[0].item.tab).toBe("repositories");
  });
});
