import { describe, expect, it } from "vitest";
import { searchSettingsSections } from "./settingsSections";

describe("settings section search", () => {
  it("ranks a title ahead of descriptions and search terms", () => {
    const matches = searchSettingsSections("agents");
    expect(matches[0].item.tab).toBe("agents");
    expect(matches[0].primaryRanges).toEqual([{ start: 0, end: 6 }]);
    expect(matches.some((match) => match.item.tab === "organizations")).toBe(true);
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
    expect(searchSettingsSections("local vms")[0].item.tab).toBe("localVms");
    expect(searchSettingsSections("zzzz-no-such-setting")).toEqual([]);
  });
});
