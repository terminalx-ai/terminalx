import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_ROWS } from "@/components/settings/settingsRegistry";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { forgetSettingToasts } from "@/lib/settingsToasts";
import { buildSettingLink, enableSetting, forgetAgentLoginsRequest, onOpenOrganizationSettings, openAgentLogins, openOrganizationSettings, takeAgentLoginsRequest, takeAgentLoginsSignIn, takeOrganizationRequest } from "./settingsLinks";

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
  it("builds terminalx://settings/<row-id>", () => {
    expect(buildSettingLink("general.sounds")).toBe("terminalx://settings/general.sounds");
  });

  it("builds a link the native validator takes for every row: ids are letters, digits, '.', '-' and '_', at most 64", () => {
    for (const row of SETTINGS_ROWS) {
      expect(row.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
      expect(buildSettingLink(row.id)).toBe(`terminalx://settings/${row.id}`);
    }
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
});
