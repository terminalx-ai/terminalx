import { describe, expect, it } from "vitest";
import type { ConfigurationLayerValue, ConfigurationValue } from "@/types/configuration";
import type { SettingsFileLayer, SettingsFileProblem } from "@/types/settingsSources";
import {
  badgeForValue, cantSaveCopy, cantSaveEffect, cantSaveTitle, fileChips, layerRows, problemText, resetFor, setUserKeys, SOURCE_BADGES, userFileKeys,
} from "./settingSources";

const layer = (name: ConfigurationLayerValue["layer"], value: unknown): ConfigurationLayerValue => ({ layer: name, value, redacted: false });
const resolved = (...layers: ConfigurationLayerValue[]): ConfigurationValue => ({
  value: layers[0].value, source: layers[0].layer, locked: layers[0].layer === "managed", redacted: false, layers,
});

describe("badge per resolver layer", () => {
  it("names managed, local over shared, local alone, shared, user and defaults", () => {
    expect(badgeForValue(resolved(layer("managed", "corp/"), layer("user", "me/")))).toBe("managed");
    expect(badgeForValue(resolved(layer("repositoryLocal", "tx/"), layer("repositoryShared", "team/"), layer("defaults", "")))).toBe("overridesProject");
    expect(badgeForValue(resolved(layer("repositoryLocal", "tx/"), layer("user", "me/")))).toBe("yours");
    expect(badgeForValue(resolved(layer("repositoryShared", "team/"), layer("user", "me/")))).toBe("project");
    expect(badgeForValue(resolved(layer("user", "me/"), layer("defaults", "")))).toBe("yours");
    expect(badgeForValue(resolved(layer("defaults", "")))).toBeNull();
  });

  it("uses the labels of the design screens", () => {
    expect(Object.values(SOURCE_BADGES).map((badge) => badge.label)).toEqual(["Managed · locked", "Project value", "Your value · overrides project", "Your value"]);
  });

  it("still names the winner when an older runtime sends no layers", () => {
    const old = { value: "team/", source: "repositoryShared", locked: false, redacted: false } as unknown as ConfigurationValue;
    expect(badgeForValue(old)).toBe("project");
    expect(layerRows(old, true).find((row) => row.winning)?.value).toBe("team/");
  });
});

describe("where a value comes from", () => {
  it("lists every layer highest first, checks the winner and strikes the overridden", () => {
    const rows = layerRows(resolved(layer("repositoryLocal", "tx/"), layer("repositoryShared", "team/"), layer("user", "me/"), layer("defaults", "")), true);
    expect(rows.map((row) => [row.title, row.value, row.winning, row.overridden])).toEqual([
      ["Managed", null, false, false],
      ["Project · local", "tx/", true, false],
      ["Project · shared", "team/", false, true],
      ["Your settings", "me/", false, true],
      ["Default", "empty", false, true],
    ]);
  });

  it("leaves the project layers out without a repository and hides redacted values", () => {
    const rows = layerRows({ ...resolved(layer("user", "x")), layers: [{ layer: "user", value: null, redacted: true }] }, false);
    expect(rows.map((row) => row.layer)).toEqual(["managed", "user", "defaults"]);
    expect(rows[1].value).toBe("hidden");
  });

  it("offers the reset that removes the winning value, named for what applies next", () => {
    expect(resetFor(resolved(layer("repositoryLocal", "tx/"), layer("repositoryShared", "team/")))).toEqual({ layer: "repositoryLocal", label: "Reset to project value" });
    expect(resetFor(resolved(layer("repositoryLocal", "tx/"), layer("user", "me/")))).toEqual({ layer: "repositoryLocal", label: "Reset to your value" });
    expect(resetFor(resolved(layer("user", "me/"), layer("defaults", "")))).toEqual({ layer: "user", label: "Reset to default" });
    expect(resetFor(resolved(layer("repositoryShared", "team/")))).toBeNull();
    expect(resetFor(resolved(layer("managed", "corp/")))).toBeNull();
    expect(resetFor(resolved(layer("defaults", "")))).toBeNull();
  });
});

describe("rows kept in the user file", () => {
  it("reads the dotted keys from a registry location and nothing from other stores", () => {
    expect(userFileKeys("$TERMINALX_HOME/settings.json#preferences.theme")).toEqual(["preferences.theme"]);
    expect(userFileKeys("$TERMINALX_HOME/settings.json#preferences.linkBrowser, preferences.linkBrowserChosen")).toEqual(["preferences.linkBrowser", "preferences.linkBrowserChosen"]);
    expect(userFileKeys("$TERMINALX_HOME/settings.json#diagnostics.recoveryIncidents, $TERMINALX_HOME/diagnostics/recovery-incidents.jsonl")).toEqual(["diagnostics.recoveryIncidents"]);
    expect(userFileKeys("$TERMINALX_HOME/settings.json")).toEqual([]);
    expect(userFileKeys("raccoon.prefs#followUps")).toEqual([]);
    expect(userFileKeys("$TERMINALX_HOME/data-privacy.json#enabled")).toEqual([]);
  });

  it("is Your value only for keys the file sets itself", () => {
    expect(setUserKeys(["preferences.theme"], ["preferences.theme", "agents.idleStopMinutes"])).toEqual(["preferences.theme"]);
    expect(setUserKeys(["preferences.mode"], ["preferences.theme"])).toEqual([]);
    expect(setUserKeys(["preferences"], ["preferences.theme"])).toEqual([]);
  });
});

describe("settings files and their errors", () => {
  const file = (patch: Partial<SettingsFileLayer>): SettingsFileLayer => ({ layer: "repositoryShared", path: "/r/.terminalx/settings.json", displayPath: "~/r/.terminalx/settings.json", exists: true, keys: 3, git: null, problem: null, ...patch });
  it("chips say whether the file exists, how many keys it sets and what Git does with it", () => {
    expect(fileChips(file({ layer: "managed", exists: false, keys: 0, path: "/Library/Managed Preferences/x.plist" }))).toEqual(["none on this Mac"]);
    expect(fileChips(file({ git: "committed" }))).toEqual(["3 keys", "committed"]);
    expect(fileChips(file({ layer: "repositoryLocal", git: "ignored", keys: 1 }))).toEqual(["1 key", "ignored by Git"]);
    expect(fileChips(file({ layer: "user", git: null, keys: 14 }))).toEqual(["14 keys"]);
    expect(fileChips(file({ layer: "defaults", path: null, displayPath: null }))).toEqual([]);
  });

  const problem: SettingsFileProblem = { key: "preferences.theme", line: 7, message: "unknown option", effect: "lastGood" };
  it("an error names file, line and key in one sentence with what stays in effect", () => {
    expect(problemText("~/.raccoon/settings.json", problem)).toBe("~/.raccoon/settings.json line 7: preferences.theme unknown option. The last good values stay in effect.");
    expect(problemText("~/r/.terminalx/settings.json", { key: null, line: null, message: "Unexpected “,” before “}”", effect: "fileIgnored" }))
      .toBe("~/r/.terminalx/settings.json: Unexpected “,” before “}”. None of this file’s values apply until it is fixed.");
  });

  it("Can’t save names the file and line, and its copy holds the whole toast", () => {
    expect(cantSaveTitle("~/.raccoon/settings.json", problem)).toBe("Can’t save: ~/.raccoon/settings.json has an error on line 7");
    expect(cantSaveTitle("~/.raccoon/settings.json", { ...problem, line: null })).toBe("Can’t save: ~/.raccoon/settings.json has an error");
    expect(cantSaveCopy("~/.raccoon/settings.json", problem)).toBe(
      `Can’t save: ~/.raccoon/settings.json has an error on line 7\npreferences.theme: unknown option\n${cantSaveEffect(problem)}`);
  });
});
