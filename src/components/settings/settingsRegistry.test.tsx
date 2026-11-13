import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SHORTCUT_ACTIONS } from "@/lib/shortcuts";
import preferenceDefaults from "@/lib/userPreferenceDefaults.json";
import { RegisteredSetting, resolveSetting, SETTINGS_GROUPS, SETTINGS_ROWS, SETTINGS_SECTIONS, settingsInSection, type SettingsSection } from "./settingsRegistry";

afterEach(cleanup);

describe("settings registry", () => {
  it("keeps a reviewable inventory of stable, unique row ids", () => {
    const ids = SETTINGS_ROWS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toMatchSnapshot();
  });

  it.each(Object.keys(SETTINGS_SECTIONS) as SettingsSection[])("declares and renders every %s row", (section) => {
    const rows = settingsInSection(section);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.id.startsWith(`${section}.`)).toBe(true);
      expect(row.title.trim()).not.toBe("");
      expect(row.description.trim()).not.toBe("");
      expect(row.searchTerms.length).toBeGreaterThan(0);
      expect(row.storage.location.trim()).not.toBe("");
      expect(["user", "repository", "organization"]).toContain(row.scope);
      const child = <section aria-label={row.title}><button>Edit</button></section>;
      const view = render(<>{row.render(row.layout === "content" ? { children: child } : { control: <button>Edit</button> })}</>);
      expect(view.container.querySelector("[data-setting-id]")?.getAttribute("data-setting-id")).toBe(row.id);
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
      if (row.layout !== "content") expect(screen.getByText(row.title)).toBeTruthy();
      view.unmount();
    }
    expect(resolveSetting(section).id).toBe(SETTINGS_SECTIONS[section].entry);
    expect(SETTINGS_GROUPS).toContain(SETTINGS_SECTIONS[section].group);
  });

  it("uses each keyboard action's own id instead of an array index", () => {
    for (const action of SHORTCUT_ACTIONS) expect(resolveSetting(`shortcuts.${action.id}`).title).toBe(action.label);
  });

  it("registers the file locator and records migrated preferences in their current store", () => {
    expect(resolveSetting("general.settingsFile").storage).toEqual({ kind: "file", location: "$TERMINALX_HOME/settings.json" });
    expect(resolveSetting("appearance.theme").storage.location).toBe("$TERMINALX_HOME/settings.json#preferences.theme");
    expect(resolveSetting("appearance.mode").storage.location).toBe("$TERMINALX_HOME/settings.json#preferences.mode");
    for (const row of SETTINGS_ROWS) {
      const legacyKeys = row.storage.location.startsWith("raccoon.prefs#")
        ? row.storage.location.slice("raccoon.prefs#".length).split(/,\s*/).map((key) => key.split(".")[0]) : [];
      for (const key of legacyKeys) expect(key in preferenceDefaults, row.id).toBe(false);
      if (row.storage.location.startsWith("$TERMINALX_HOME/settings.json#preferences.")) expect(row.storage.kind).toBe("file");
    }
  });

  it("preserves native list semantics and ref ownership for custom editors", () => {
    const ref = { current: null as HTMLLIElement | null };
    const view = render(<ul><RegisteredSetting setting="shortcuts.app.settings"><li ref={ref}>Settings shortcut</li></RegisteredSetting></ul>);
    expect(view.container.querySelector("ul > li")).toBe(ref.current);
    expect(ref.current?.dataset.settingId).toBe("shortcuts.app.settings");
  });

  it("resolves row links and safely defaults unknown legacy targets", () => {
    expect(resolveSetting("appearance.textSize").section).toBe("appearance");
    for (const value of [undefined, null, "missing", "toString", { type: "click" }]) expect(resolveSetting(value).id).toBe("account.identity");
  });

  it("keeps the linkable allowlist to reversible, local display and sound switches", () => {
    // A link from another app can turn these on, and nothing else. Review any change here as a security boundary.
    expect(SETTINGS_ROWS.filter((row) => "linkable" in row && row.linkable).map((row) => row.id)).toEqual(["general.sounds", "general.turnChanges", "general.promptMap"]);
    for (const id of ["agents.readOnlyCommands", "orchestrator.workerMode", "orchestrator.requireApproval", "general.cloudControl", "general.computerUse", "general.dataPrivacy", "general.websiteLinks", "general.linkActions", "general.useWorktree", "account.workStatus", "account.sharing", "integrations.linear", "experimental.orchestratorRuns", "experimental.nativeCodex", "experimental.sessionCost", "transcription.remoteContext"]) {
      // resolveSetting falls back to account.identity for an unknown id, so check the row is the one named.
      expect(resolveSetting(id).id).toBe(id);
      expect("linkable" in resolveSetting(id) && resolveSetting(id).linkable, id).toBeFalsy();
    }
  });

  it("keeps every linkable row a per-person on/off preference in settings.json", () => {
    for (const row of SETTINGS_ROWS) {
      if (!("linkable" in row && row.linkable)) continue;
      expect(row.scope, row.id).toBe("user");
      expect(row.storage, row.id).toEqual({ kind: "file", location: expect.stringMatching(/^\$TERMINALX_HOME\/settings\.json#preferences\.[a-zA-Z]+$/) });
      const key = row.storage.location.split("#preferences.")[1];
      expect(typeof (preferenceDefaults as Record<string, unknown>)[key], row.id).toBe("boolean");
    }
  });

  it("has no Desktop notifications row to link yet, and never links Send key", () => {
    // Design 09.04/09.33 link "Desktop notifications" (general.notifications) and refuse "Send key". Neither row
    // exists: the Rust `notifications` flag has no webview setter. When that row lands, mark it linkable and
    // replace this assertion with one that it is; Send key (any row so titled) must stay off the allowlist.
    expect(SETTINGS_ROWS.some((row) => (row.id as string) === "general.notifications" || /desktop notifications/i.test(row.title))).toBe(false);
    for (const row of SETTINGS_ROWS.filter((row) => /send key/i.test(row.title))) expect("linkable" in row && row.linkable, row.id).toBeFalsy();
  });

  it("gives every row-layout setting an actions menu, and content rows none", () => {
    for (const row of SETTINGS_ROWS) {
      const view = render(<>{row.render(row.layout === "content" ? { children: <section>Editor</section> } : { control: <span>Control</span> })}</>);
      const actions = screen.queryByRole("button", { name: `Actions for ${row.title}` });
      if (row.layout === "content") expect(actions, row.id).toBeNull();
      else expect(actions, row.id).toBeTruthy();
      view.unmount();
    }
  });

  it("keeps metadata-only descriptions out of controls that had no help text", () => {
    render(<RegisteredSetting setting="appearance.theme" control={<button>Theme picker</button>} />);
    expect(screen.queryByText(resolveSetting("appearance.theme").description)).toBeNull();
  });
});

it("keeps global settings rows in the registry", () => {
  // Custom organization fields register as a section.
  // PRO-155's action editor is mounted as one registered row (repositories.actions),
  // but its dialog switches edit an unsaved action draft; registering them would
  // advertise row links that cannot open.
  const adapters = import.meta.glob(["./*.tsx", "!./*.test.tsx", "!./settingsRegistry.tsx", "!./WorkStatusSettings.tsx", "!./RepositoryActionsSettings.tsx"], { query: "?raw", import: "default", eager: true });
  for (const [path, source] of Object.entries(adapters)) expect(source, path).not.toMatch(/<SettingRow\b/);
});
