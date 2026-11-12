import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));

const { CommandPalette } = await import("./CommandPalette");
const store = await import("@/lib/sessions");
const { searchSettings } = await import("@/lib/settingsSearch");
const { onProjectSettingsRequest } = await import("@/lib/projectAdded");

beforeEach(async () => {
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects: [{ path: "/alpha", name: "Alpha" }], lastSelected: "/alpha" };
    if (command === "list_sessions" || command === "list_workspaces" || command === "list_harnesses") return [];
    return null;
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  await act(async () => {
    await store.refreshEverything();
    store.selectSession(null);
  });
});

afterEach(async () => {
  cleanup();
  // Radix FocusScope dispatches its unmount event from a 0 ms timer. Let it run
  // while jsdom is still installed: after the file's environment is torn down
  // it throws an uncaught "parameter 1 is not of type 'Event'".
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function palette() {
  const props = { onOpenChange: vi.fn(), onOpenSettings: vi.fn(), onCreated: vi.fn() };
  const view = render(<CommandPalette open {...props} />);
  return { ...view, ...props, props, input: screen.getByLabelText("Command palette search") };
}

async function narrowToSettings(input: HTMLElement) {
  fireEvent.change(input, { target: { value: "Search settings" } });
  fireEvent.click(await screen.findByRole("option", { name: /Search settings…/ }));
  await waitFor(() => expect(input.getAttribute("placeholder")).toBe("Search settings…"));
}

function groupIds() {
  return screen.getAllByRole("group").map((group) => group.getAttribute("aria-labelledby"));
}

describe("settings in the command palette", () => {
  it("opens the copy-pattern row in repository settings", async () => {
    const { input, onOpenSettings } = palette();
    await narrowToSettings(input);
    fireEvent.change(input, { target: { value: "worktreeinclude" } });
    await screen.findByRole("option", { name: /Files to copy/ });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledWith("repositories.filesToCopy"));
  });

  it("lists rows from the registry, not sections, and opens the chosen row with Enter", async () => {
    const { input, onOpenSettings, onOpenChange } = palette();
    fireEvent.change(input, { target: { value: "text size" } });
    const group = await screen.findByRole("group", { name: "Settings" });
    const rows = within(group).getAllByRole("option");
    // The rows are the registry's own, best first, each saying the page it is on.
    expect(rows.map((row) => row.id)).toEqual(searchSettings("text size").slice(0, rows.length).map((match) => `palette:setting:${match.id}`));
    expect(rows[0].id).toBe("palette:setting:appearance.textSize");
    expect(rows[0].textContent).toContain("Text size");
    expect(rows[0].textContent).toContain("Appearance · Scales the transcript and composer.");
    expect(rows[0].querySelector("mark")?.textContent).toBe("Text");
    // No section entry stands in for the row.
    expect(within(group).queryByRole("option", { name: /^Appearance/ })).toBeNull();
    // The best match is the first row in the list, so Enter opens it.
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledWith("appearance.textSize"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each(["font", "theme", "worktree"])("lists for %s the rows the row search finds, in its order", async (query) => {
    const { input } = palette();
    fireEvent.change(input, { target: { value: query } });
    const rows = within(await screen.findByRole("group", { name: "Settings" })).getAllByRole("option");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.id)).toEqual(searchSettings(query).slice(0, rows.length).map((match) => `palette:setting:${match.id}`));
  });

  it("puts a strong settings match ahead of the commands, and an exact command ahead of settings", async () => {
    const { input } = palette();
    fireEvent.change(input, { target: { value: "status bar" } });
    await screen.findByRole("group", { name: "Settings" });
    expect(screen.getByRole("option", { name: /Toggle status bar/ })).toBeTruthy();
    expect(groupIds().indexOf("palette-group-settings")).toBeLessThan(groupIds().indexOf("palette-group-commands"));
    expect(screen.getAllByRole("option")[0].id).toBe("palette:setting:appearance.statusBar");
    fireEvent.change(input, { target: { value: "home" } });
    await waitFor(() => expect(screen.getAllByRole("option")[0].id).toBe("command:shortcut:app.home"));
    expect(groupIds().indexOf("palette-group-commands")).toBeLessThan(groupIds().indexOf("palette-group-settings"));
  });

  it("highlights a description match after the row's page", async () => {
    const { input } = palette();
    await narrowToSettings(input);
    fireEvent.change(input, { target: { value: "tone" } });
    const sounds = await screen.findByRole("option", { name: /^Sounds/ });
    expect(sounds.querySelector("mark")?.textContent).toBe("tone");
  });

  it("shows the five tabs, and Search settings… narrows to settings with the Settings tab selected", async () => {
    const { input, onOpenChange } = palette();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["All", "Sessions", "Projects", "Actions", "Settings"]);
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
    await narrowToSettings(input);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("false");
    // With nothing typed: the Settings pages and each project's settings, and nothing else.
    expect(groupIds()).toEqual(["palette-group-settings-pages", "palette-group-settings-projects"]);
    expect(screen.getByRole("group", { name: "Settings pages" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "sounds" } });
    await screen.findByRole("option", { name: /^Sounds/ });
    // Typed for: only setting rows, no command, session or project, though commands match "sounds" too.
    expect(groupIds()).toEqual(["palette-group-settings"]);
    expect(screen.getAllByRole("option").every((option) => option.id.startsWith("palette:setting:"))).toBe(true);
  });

  it("lists every Settings page on one line with nothing typed, opens one, and moves with the arrows", async () => {
    const { input, onOpenSettings } = palette();
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(input.getAttribute("placeholder")).toBe("Search settings…");
    const results = screen.getAllByRole("option");
    const pages = within(screen.getByRole("group", { name: "Settings pages" })).getAllByRole("option");
    // Orchestrator is behind its Experimental switch, which is off.
    expect(pages).toHaveLength(15);
    expect(results).toHaveLength(pages.length + 1);
    expect(results.map((row) => row.id)).not.toContain("palette:settings-page:orchestrator");
    expect(screen.getByRole("option", { name: /^Environment/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Projects/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Repositories/ }).textContent).toBe("RepositoriesRepository paths, files to copy, scripts and workspace cleanup");
    // The footer says the pages are not all there is (design 07.05).
    expect(screen.getByText("Type to search every setting, not only pages")).toBeTruthy();
    expect(screen.getByText("↑↓ to move")).toBeTruthy();
    expect(screen.getByText("↵ to open")).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(results.at(-1)!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(results[0].id);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledWith("account"));
  });

  it("lists each project under the pages, and opens that project's settings", async () => {
    const { input, onOpenChange, onOpenSettings } = palette();
    const requested = vi.fn();
    const stop = onProjectSettingsRequest(requested);
    try {
      fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
      const projects = within(screen.getByRole("group", { name: "Projects" })).getAllByRole("option");
      expect(projects.map((row) => row.textContent)).toEqual(["AlphaScripts, files to copy and workspace cleanup"]);
      fireEvent.click(projects[0]);
      await waitFor(() => expect(requested).toHaveBeenCalledWith("/alpha"));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onOpenSettings).not.toHaveBeenCalled();
    } finally { stop(); }
    // Typed for, a project's settings are found as rows; the project list is gone.
    fireEvent.change(input, { target: { value: "scripts" } });
    await screen.findByRole("option", { name: /^Scripts/ });
    expect(groupIds()).toEqual(["palette-group-settings"]);
  });

  it("drops the pages hint once a setting is typed for, and outside the Settings tab", async () => {
    const { input } = palette();
    expect(screen.queryByText("Type to search every setting, not only pages")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByText("Type to search every setting, not only pages")).toBeTruthy();
    fireEvent.change(input, { target: { value: "theme" } });
    await screen.findByRole("option", { name: /^Theme/ });
    expect(screen.queryByText("Type to search every setting, not only pages")).toBeNull();
  });

  it("leaves the settings scope with Backspace or the All tab", async () => {
    const { input } = palette();
    await narrowToSettings(input);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(await screen.findByRole("group", { name: "Views and commands" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
    await narrowToSettings(input);
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(input.getAttribute("placeholder")).not.toBe("Search settings…");
    expect(await screen.findByRole("group", { name: "Views and commands" })).toBeTruthy();
  });

  it("narrows to commands under Actions and keeps the query across tabs", async () => {
    const { input } = palette();
    fireEvent.change(input, { target: { value: "theme" } });
    await screen.findByRole("group", { name: "Settings" });
    expect(screen.getByRole("group", { name: "Views and commands" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    expect((input as HTMLInputElement).value).toBe("theme");
    expect(input.getAttribute("placeholder")).toBe("Search views and commands…");
    await waitFor(() => expect(groupIds()).toEqual(["palette-group-commands"]));
    expect(screen.getAllByRole("option").every((option) => option.id.startsWith("command:"))).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(await screen.findByRole("option", { name: /^Theme/ })).toBeTruthy();
    expect(groupIds()).toEqual(["palette-group-settings"]);
  });

  it("keeps settings searches out of file and issue lookups and reports no matches", async () => {
    const { input } = palette();
    await narrowToSettings(input);
    mocks.invoke.mockClear();
    fireEvent.change(input, { target: { value: "text size" } });
    await screen.findByRole("option", { name: /Text size/ });
    // The ordinary file lookup is debounced for 45 ms.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(mocks.invoke).not.toHaveBeenCalledWith("search_files", expect.anything());
    fireEvent.change(input, { target: { value: "https://github.com/acme/app/issues/127" } });
    expect((await screen.findByRole("status")).textContent).toBe("No settings match https://github.com/acme/app/issues/127");
    expect(screen.queryByRole("group", { name: "Smart input" })).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("issue_details", expect.anything());
  });

  it("closes with Escape and resets the scope on the next opening", async () => {
    const { input, onOpenChange, props, rerender } = palette();
    await narrowToSettings(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<CommandPalette open={false} {...props} />);
    rerender(<CommandPalette open {...props} />);
    expect(await screen.findByRole("group", { name: "Views and commands" })).toBeTruthy();
    expect(screen.getByLabelText("Command palette search").getAttribute("placeholder")).not.toBe("Search settings…");
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
  });
});
