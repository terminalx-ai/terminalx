import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SHORTCUT_ACTIONS } from "@/lib/shortcuts";
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

  it("keeps metadata-only descriptions out of controls that had no help text", () => {
    render(<RegisteredSetting setting="appearance.theme" control={<button>Theme picker</button>} />);
    expect(screen.queryByText(resolveSetting("appearance.theme").description)).toBeNull();
  });
});

it("keeps standard settings rows in the registry; organization internals register as sections", () => {
  // Per-item editors have their own fields, rather than global settings rows.
  // RepositoryActionsSettings edits one action's draft in a dialog, just as
  // WorkStatusSettings edits individual statuses inside its registered section.
  const adapters = import.meta.glob(["./*.tsx", "!./*.test.tsx", "!./settingsRegistry.tsx", "!./WorkStatusSettings.tsx", "!./RepositoryActionsSettings.tsx"], { query: "?raw", import: "default", eager: true });
  for (const [path, source] of Object.entries(adapters)) expect(source, path).not.toMatch(/<SettingRow\b/);
});
