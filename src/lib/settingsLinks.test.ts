import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_ROWS } from "@/components/settings/settingsRegistry";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { forgetSettingToasts, getSettingToasts } from "@/lib/settingsToasts";
import { buildSettingLink, enableSetting, followSettingLink, forgetAgentLoginsRequest, onOpenOrganizationSettings, onOpenSettingRow, openAgentLogins, openOrganizationSettings, parseSettingLink, takeAgentLoginsRequest, takeAgentLoginsSignIn, takeOrganizationRequest } from "./settingsLinks";

afterEach(() => { takeOrganizationRequest(); forgetAgentLoginsRequest(); });

describe("settings row links", () => {
  it("maps organization and agent-login entry points to stable rows while preserving sign-in consent", () => {
    const listener = vi.fn();
    const stop = onOpenOrganizationSettings(listener);
    try {
      openOrganizationSettings("org-a");
      expect(listener).toHaveBeenLastCalledWith("organizations.overview");
      expect(takeOrganizationRequest()).toBe("org-a");
      openAgentLogins("org-b", "codex");
      expect(listener).toHaveBeenLastCalledWith("organizations.agentLogins");
      expect(takeOrganizationRequest()).toBe("org-b");
      expect(takeAgentLoginsRequest("org-a")).toBe(false);
      expect(takeAgentLoginsRequest("org-b")).toBe(true);
      expect(takeAgentLoginsSignIn("org-b")).toBe("codex");
      expect(takeAgentLoginsSignIn("org-b")).toBeNull();
    } finally { stop(); }
    const before = listener.mock.calls.length;
    openOrganizationSettings(null);
    expect(listener).toHaveBeenCalledTimes(before);
  });
});

describe("setting links", () => {
  it("builds terminalx://settings/<row-id> and parses it back", () => {
    expect(buildSettingLink("general.sounds")).toBe("terminalx://settings/general.sounds");
    expect(parseSettingLink(buildSettingLink("general.sounds"))).toEqual({ id: "general.sounds", enable: false });
    expect(parseSettingLink("terminalx://settings/repositories.scripts?enable=1")).toEqual({ id: "repositories.scripts", enable: true });
    for (const row of SETTINGS_ROWS) expect(parseSettingLink(buildSettingLink(row.id))?.id).toBe(row.id);
    // A scheme and host are not case-sensitive; the row id is.
    expect(parseSettingLink("TerminalX://Settings/general.sounds?enable=1")).toEqual({ id: "general.sounds", enable: true });
  });

  it.each([
    "terminalx://settings/no.such.row",
    "terminalx://settings/general",
    "terminalx://settings/",
    "terminalx://settings",
    "terminalx://settings/general.sounds/extra",
    "terminalx://settings//general.sounds",
    "terminalx://settings/general.sounds?enable=0",
    "terminalx://settings/general.sounds?enable=1&x=1",
    "terminalx://settings/general.sounds?enable=true",
    "terminalx://settings/general.sounds?",
    "terminalx://settings/general.sounds#top",
    "terminalx://settings/general.sounds?enable=1#",
    "terminalx://other/general.sounds",
    "terminalx://user@settings/general.sounds",
    "terminalx://settings:1/general.sounds",
    "https://settings/general.sounds",
    "terminalx:settings/general.sounds",
    "terminalx://settings/toString",
    " terminalx://settings/general.sounds",
    "terminalx://settings/general.sounds ",
    "terminalx://settings/general.\nsounds",
    "terminalx://settings/general%2Esounds",
    "terminalx://settings/General.Sounds",
    "terminalx://settings/general.sounds?enable=1\n",
    "terminalx://settings/general.sounds?ENABLE=1",
    "terminalx://settings/general.sounds\\..\\x",
    "not a url",
  ])("rejects %s", (url) => {
    expect(parseSettingLink(url)).toBeNull();
  });
});

describe("enableSetting allowlist", () => {
  beforeEach(() => { setPrefs({ sounds: false, animations: false }); forgetSettingToasts(); });
  afterEach(() => { setPrefs({ sounds: true, animations: true }); forgetSettingToasts(); });

  it("turns every linkable row on in the preference its storage names", async () => {
    const linkable = SETTINGS_ROWS.filter((row) => "linkable" in row && row.linkable);
    expect(linkable.length).toBeGreaterThan(0);
    const before = getPrefs();
    try {
      for (const row of linkable) {
        const key = row.storage.location.split("#preferences.")[1] as keyof ReturnType<typeof getPrefs>;
        setPrefs({ [key]: false });
        expect(await enableSetting(row.id)).toBe("enabled");
        expect(getPrefs()[key], row.id).toBe(true);
      }
    } finally { setPrefs({ turnChanges: before.turnChanges, promptMap: before.promptMap }); }
  });

  it("turns a linkable row on through its existing setter", async () => {
    expect(await enableSetting("general.sounds")).toBe("enabled");
    expect(getPrefs().sounds).toBe(true);
  });

  it("changes nothing for a row that is not linkable", async () => {
    const before = getPrefs();
    expect(await enableSetting("general.animations")).toBe("not-linkable");
    expect(await enableSetting("agents.readOnlyCommands")).toBe("not-linkable");
    expect(await enableSetting("experimental.orchestratorRuns")).toBe("not-linkable");
    expect(getPrefs()).toBe(before);
    expect(getPrefs().animations).toBe(false);
  });

  it("changes nothing for an unknown row", async () => {
    const before = getPrefs();
    for (const id of ["no.such.row", "general", "", "toString", "__proto__"]) expect(await enableSetting(id)).toBe("unknown");
    expect(getPrefs()).toBe(before);
  });

  it("follows a link: opens the row, turns on only a linkable one, and says which", async () => {
    const opened = vi.fn();
    const stop = onOpenSettingRow(opened);
    try {
      expect(await followSettingLink("terminalx://settings/general.sounds?enable=1")).toBe(true);
      expect(opened).toHaveBeenLastCalledWith("general.sounds");
      expect(getPrefs().sounds).toBe(true);
      expect(getSettingToasts().map((toast) => toast.message)).toEqual(["Turned on Sounds"]);

      expect(await followSettingLink("terminalx://settings/general.animations?enable=1")).toBe(true);
      expect(opened).toHaveBeenLastCalledWith("general.animations");
      expect(getPrefs().animations).toBe(false);
      expect(getSettingToasts().at(-1)?.message).toBe("That link can’t turn on Pixel raccoon from outside the app");

      forgetSettingToasts();
      expect(await followSettingLink("terminalx://settings/general.promptMap")).toBe(true);
      expect(opened).toHaveBeenLastCalledWith("general.promptMap");
      expect(getSettingToasts()).toEqual([]);

      const calls = opened.mock.calls.length;
      expect(await followSettingLink("terminalx://settings/no.such.row?enable=1")).toBe(false);
      expect(opened).toHaveBeenCalledTimes(calls);
    } finally { stop(); }
  });
});
