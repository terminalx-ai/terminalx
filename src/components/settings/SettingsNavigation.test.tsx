import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as settingsFile from "@/lib/settingsFile";
import { configuration } from "@/lib/configuration";
import type { Project } from "@/types/session";
import type { SettingId } from "./settingsRegistry";

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  updateProject: vi.fn(),
  saveOrder: vi.fn(async (patch: object) => ({ custom: false, sessions: ["second", "first"], projects: ["/repos/two", "/repos/one"], revision: 1, ...patch })),
  environmentList: vi.fn(async (_project: string | null) => []),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  preview: vi.fn(),
}));
vi.mock("@/lib/sessions", async (original) => {
  const actual = await original<typeof import("@/lib/sessions")>();
  return { ...actual, updateProject: mocks.updateProject, useSessionStore: () => ({ ...actual.useSessionStore(), projects: mocks.projects }) };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => { if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name); };
  }),
}));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual,
    invoke: (command: string, args?: { patch?: object }) => {
      if (command === "sidebar_order") return Promise.resolve({ custom: false, sessions: ["second", "first"], projects: ["/repos/two", "/repos/one"], revision: 0 });
      if (command === "set_sidebar_order") return mocks.saveOrder(args?.patch ?? {});
      if (command === "configuration_watch") return Promise.reject(new Error("no watcher in tests"));
      if (command === "configuration_resolve") return Promise.resolve({ registry: [], warnings: [], trust: null, values: {
        setupScript: { value: "", source: "defaults", locked: false, redacted: false },
        archiveScript: { value: "", source: "defaults", locked: false, redacted: false },
        archiveTimeoutMinutes: { value: 5, source: "defaults", locked: false, redacted: false },
      } });
      return actual.invoke(command, args);
    },
    api: { ...actual.api, repositoryFilesPreview: mocks.preview },
    experimental: { ...actual.experimental, settings: vi.fn(async () => ({ nativeCodex: false })) },
  };
});
vi.mock("@/lib/localEnvironment", async (original) => {
  const actual = await original<typeof import("@/lib/localEnvironment")>();
  return { ...actual, environment: { ...actual.environment, list: mocks.environmentList } };
});
vi.mock("@/icons", () => new Proxy({}, { has: () => true, get: (_, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : prop === "__esModule" ? true : (props: Record<string, unknown>) => <svg {...props} />) }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  WithTooltip: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
  Kbd: ({ children }: { children: React.ReactNode }) => <kbd data-slot="kbd">{children}</kbd>,
  KbdGroup: ({ keys }: { keys: string[] }) => <span data-slot="kbd">{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>,
}));
const { SettingsPage } = await import("./SettingsPage");

beforeEach(() => {
  mocks.updateProject.mockReset().mockResolvedValue(undefined);
  mocks.preview.mockReset().mockImplementation(async (path, patterns) => ({
    rootPath: path, workspacesPath: `${path}/.raccoon/worktrees`, fromIncludeFile: false,
    patterns: patterns.map((pattern: string) => ({ pattern, matches: [".env.local"], error: null })),
  }));
  mocks.environmentList.mockClear();
  mocks.projects = [
    { path: "/repos/one", name: "One", kind: "git" },
    { path: "/repos/two", name: "Two", kind: "git" },
    { path: "/notes", name: "Notes", kind: "folder" },
    { path: "/repos/old", name: "Archived", archived: true },
  ];
});
afterEach(cleanup);
/** A project's pages, nested under its row while it is open (PRO-387). */
const projectPages = (name: string) => within(screen.getByRole("group", { name: `${name} settings` }));
const breadcrumb = () => screen.getByRole("navigation", { name: "Breadcrumb" }).textContent;

describe("registry navigation", () => {
  // PRO-375: the row moved from General to Account; a link to its old id still opens it there.
  it.each(["account.dataPrivacy", "general.dataPrivacy"])("opens the registered privacy row through a stable row link (%s)", (link) => {
    const view = render(<SettingsPage initialTab={link as "account.dataPrivacy"} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
    const row = view.container.querySelector('[data-setting-id="account.dataPrivacy"]');
    expect(row).toBeTruthy();
    expect(row?.contains(screen.getByRole("switch", { name: "Data privacy mode" }))).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it("leaves data privacy mode off General", () => {
    const view = render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(view.container.querySelector('[data-setting-id="account.dataPrivacy"]')).toBeNull();
    expect(screen.queryByRole("switch", { name: "Data privacy mode" })).toBeNull();
  });

  it("opens a repository's cleanup controls, then saves its Scripts from the Scripts page", async () => {
    render(<SettingsPage onBack={vi.fn()} />);
    // Projects is one row, closed when Settings opens (PRO-464).
    expect(screen.queryByRole("group", { name: "Projects" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Projects/ }));
    const group = within(screen.getByRole("group", { name: "Projects" }));
    fireEvent.click(group.getByRole("button", { name: "Two" }));
    expect(group.getByRole("button", { name: "Two" }).getAttribute("aria-expanded")).toBe("true");
    expect(projectPages("Two").getAllByRole("button").map((button) => button.textContent)).toEqual(["General", "Scripts", "Actions", "Environment", "Settings files"]);
    expect(projectPages("Two").getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(breadcrumb()).toBe("ProjectsTwoGeneral");
    expect(screen.getByRole("radiogroup", { name: "Delete merged workspaces of Two" })).toBeTruthy();
    expect(screen.queryByLabelText("Archive script")).toBeNull();
    fireEvent.click(projectPages("Two").getByRole("button", { name: "Scripts" }));
    // A page chosen in the sidebar opens at its top, with no row marked as a search hit.
    expect(screen.getByRole("heading", { name: "Scripts", level: 2 })).toBeTruthy();
    expect(breadcrumb()).toBe("ProjectsTwoScripts");
    expect(document.querySelector("[data-setting-highlight]")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Scripts", level: 2 }));
    fireEvent.change(await screen.findByLabelText("Archive script"), { target: { value: "docker compose down" } });
    fireEvent.blur(screen.getByLabelText("Archive script"));
    await screen.findByText("Archive script saved.");
    expect(mocks.updateProject).toHaveBeenCalledWith("/repos/two", { scripts: { setup: "", archive: "docker compose down" } });
  });

  it("opens Environment from its group, keeps repository overrides, and resolves its row link", async () => {
    const view = render(<SettingsPage onBack={vi.fn()} />);
    const group = within(screen.getByRole("group", { name: "Agents & environment" }));
    fireEvent.click(group.getByRole("button", { name: "Environment" }));
    expect(screen.getByRole("heading", { name: "Environment" })).toBeTruthy();
    await waitFor(() => expect(mocks.environmentList).toHaveBeenLastCalledWith(null));
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "/repos/two" } });
    await waitFor(() => expect(mocks.environmentList).toHaveBeenLastCalledWith("/repos/two"));
    expect(screen.getByRole("button", { name: "Load from .env file" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    view.rerender(<SettingsPage initialTab="environment.variables" openRequest={1} onBack={vi.fn()} />);
    const row = view.container.querySelector('[data-setting-id="environment.variables"]');
    expect(row).toBeTruthy();
    expect(document.activeElement).toBe(row);
    expect(screen.getByRole("heading", { name: "Environment" })).toBeTruthy();
  });

  it("opens each repository's cleanup controls from its one row", () => {
    const view = render(<SettingsPage onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Projects/ }));
    const group = within(screen.getByRole("group", { name: "Projects" }));
    expect(group.queryByRole("button", { name: "Archived" })).toBeNull();
    expect(group.getByRole("button", { name: "Notes" })).toBeTruthy();
    // A row a repository, no expander holding a single item.
    expect(group.queryByRole("button", { name: "Workspace cleanup" })).toBeNull();
    expect(group.getByRole("button", { name: "One" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(group.getByRole("button", { name: "One" }));
    expect(group.getByRole("button", { name: "One" }).getAttribute("aria-expanded")).toBe("true");
    expect(group.getByRole("button", { name: "Two" }).getAttribute("aria-expanded")).toBe("false");
    expect(breadcrumb()).toBe("ProjectsOneGeneral");
    expect(view.container.querySelector('[data-setting-id="repositories.mergedCleanup"]')?.getAttribute("data-setting-instance")).toBe("/repos/one");
    expect(screen.getByRole("radiogroup", { name: "Delete merged workspaces of One" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Delete merged workspaces of Two" })).toBeNull();
    mocks.projects = mocks.projects.filter((project) => project.path !== "/repos/one");
    view.rerender(<SettingsPage onBack={vi.fn()} />);
    expect(screen.queryByRole("radiogroup", { name: "Delete merged workspaces of One" })).toBeNull();
    expect(screen.getByText("Choose a project to view its settings.")).toBeTruthy();
  });

  it("opens Projects, and the project, when a project page is opened from outside the menu (PRO-464)", () => {
    const toggle = () => screen.getByRole("button", { name: /^Projects/ });
    const view = render(<SettingsPage onBack={vi.fn()} />);
    // One row with the number of projects, archived ones not counted.
    expect(toggle().textContent).toContain("3");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    view.rerender(<SettingsPage initialTab="repositories.scripts" initialProjectPath="/repos/two" openRequest={1} onBack={vi.fn()} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const group = within(screen.getByRole("group", { name: "Projects" }));
    expect(group.getAllByRole("button").map((button) => button.textContent)).toEqual(["Project templates", "One", "Two", "General", "Scripts", "Actions", "Environment", "Settings files", "Notes"]);
    expect(projectPages("Two").getByRole("button", { name: "Scripts" }).getAttribute("aria-current")).toBe("page");
    // Closed by hand, it stays closed while the person moves about Settings.
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // Search finds project rows while the group is closed, and its result opens the group.
    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), { target: { value: "project templates" } });
    fireEvent.click(document.getElementById("settings-result-projects.templates")!);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(within(screen.getByRole("group", { name: "Projects" })).getByRole("button", { name: "Project templates" }).getAttribute("aria-current")).toBe("page");
  });

  it("updates an open registry page when the paired phone changes an experimental setting", async () => {
    const view = render(<SettingsPage initialTab="experimental.nativeCodex" onBack={vi.fn()} />);
    const toggle = () => screen.getByRole("switch", { name: "Native Codex" });
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    act(() => mocks.listeners.get("experimental_settings_changed")!({ payload: { nativeCodex: true } }));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    view.unmount();
    await waitFor(() => expect(mocks.listeners.has("experimental_settings_changed")).toBe(false));
  });
});

it("opens a repository row link on the named project and marks its row", () => {
  const view = render(<SettingsPage initialTab="repositories.mergedCleanup" initialProjectPath="/repos/two" onBack={vi.fn()} />);
  expect(breadcrumb()).toBe("ProjectsTwoGeneral");
  expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-expanded")).toBe("true");
  expect(view.container.querySelector('[data-setting-id="repositories.mergedCleanup"]')?.getAttribute("data-setting-instance")).toBe("/repos/two");
});

// ⌘K, a toast's Open setting and a terminalx://settings/<row-id> link name a row, not a repository (PRO-127).
it("opens a repository row that names no repository on the first listed one, and marks the row", () => {
  const view = render(<SettingsPage initialTab="repositories.mergedCleanup" onBack={vi.fn()} />);
  expect(breadcrumb()).toBe("ProjectsOneGeneral");
  expect(screen.getByRole("button", { name: "One" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByText("Choose a project to view its settings.")).toBeNull();
  expect(view.container.querySelector('[data-setting-id="repositories.mergedCleanup"]')?.getAttribute("data-setting-instance")).toBe("/repos/one");
});

it("opens a repository row that names no repository on the one already open", () => {
  const view = render(<SettingsPage initialTab="repositories.mergedCleanup" initialProjectPath="/repos/two" onBack={vi.fn()} />);
  view.rerender(<SettingsPage initialTab="repositories.scripts" openRequest={1} onBack={vi.fn()} />);
  expect(breadcrumb()).toBe("ProjectsTwoScripts");
  expect(view.container.querySelector('[data-setting-id="repositories.scripts"]')?.getAttribute("data-setting-instance")).toBe("/repos/two");
});

it("does not choose a repository for the person when no row was asked for", () => {
  render(<SettingsPage initialTab="repositories" onBack={vi.fn()} />);
  expect(screen.getByText("Choose a project to view its settings.")).toBeTruthy();
});

it("lists folder projects and explains why Git cleanup does not apply to them", () => {
  render(<SettingsPage initialTab="repositories.mergedCleanup" initialProjectPath="/notes" onBack={vi.fn()} />);
  expect(breadcrumb()).toBe("ProjectsNotesGeneral");
  expect(projectPages("Notes").getAllByRole("button").map((button) => button.textContent)).toEqual(["General"]);
  expect(screen.getByText("Workspace cleanup is available for Git repositories. This project is a folder.")).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Delete merged workspaces of Notes" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull();
});

it("opens a Scripts row link on its repository's page and focuses its registered editor", () => {
  const view = render(<SettingsPage initialTab="repositories.scripts" initialProjectPath="/repos/two" onBack={vi.fn()} />);
  const row = view.container.querySelector('[data-setting-id="repositories.scripts"]');
  expect(row?.getAttribute("data-setting-instance")).toBe("/repos/two");
  expect(document.activeElement).toBe(row);
  expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-expanded")).toBe("true");
  expect(projectPages("Two").getByRole("button", { name: "Scripts" }).getAttribute("aria-current")).toBe("page");
});

it("opens the custom order registry row and keeps the window choice independent of shared order events", async () => {
  const view = render(<SettingsPage initialTab="general.customOrder" onBack={vi.fn()} />);
  const row = view.container.querySelector('[data-setting-id="general.customOrder"]');
  expect(row).not.toBeNull();
  expect(document.activeElement).toBe(row);
  const toggle = screen.getByRole("switch", { name: "Custom order" });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(mocks.saveOrder).toHaveBeenCalledWith({ custom: true });
  act(() => mocks.listeners.get("sidebar_order_changed")!({ payload: { custom: false, sessions: ["first", "second"], projects: [], revision: 2 } }));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect((await import("@/lib/sidebarOrder")).getSidebarOrder().sessions).toEqual(["first", "second"]);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(mocks.saveOrder).toHaveBeenCalledWith({ custom: false });
  expect((await import("@/lib/prefs")).getPrefs().sidebarSort).toBe("updated");
});

it("folder repositories have no file-copy navigation", () => {
  render(<SettingsPage initialTab="repositories.mergedCleanup" initialProjectPath="/notes" onBack={vi.fn()} />);
  expect(screen.queryByRole("navigation", { name: "Project settings" })).toBeNull();
});

it("opens registered project paths and files on General, and isolates drafts across projects", async () => {
  const view = render(<SettingsPage initialTab="repositories.workspacesPath" initialProjectPath="/repos/one" onBack={vi.fn()} />);
  const group = projectPages("One");
  const workspace = await screen.findByText("/repos/one/.raccoon/worktrees");
  expect(document.activeElement).toBe(workspace.closest('[data-setting-id="repositories.workspacesPath"]'));
  expect(group.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
  // Files to copy is a section of General: no nav entry of its own.
  expect(group.queryByRole("button", { name: "Files to copy" })).toBeNull();
  const textarea = screen.getByRole("textbox", { name: "Files to copy" });
  fireEvent.change(textarea, { target: { value: ".env*" } });
  await screen.findByText(".env.local");
  expect(view.container.querySelector('[data-setting-id="repositories.filesToCopy"]')?.getAttribute("data-setting-instance")).toBe("/repos/one");
  view.rerender(<SettingsPage initialTab="repositories.filesToCopy" initialProjectPath="/repos/two" onBack={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-expanded")).toBe("true");
  const row = view.container.querySelector('[data-setting-id="repositories.filesToCopy"]');
  expect(row?.getAttribute("data-setting-instance")).toBe("/repos/two");
  expect(document.activeElement).toBe(row);
  expect((screen.getByRole("textbox", { name: "Files to copy" }) as HTMLTextAreaElement).value).toBe("");
  expect(projectPages("Two").getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
});

it("follows an old terminalx://settings/repositories.filesToCopy or .previewUrls link to its section on General (PRO-131)", async () => {
  const { followSettingDeepLink } = await import("@/lib/settingsDeepLink");
  for (const id of ["repositories.filesToCopy", "repositories.previewUrls"] as const) {
    const opened: (SettingId | null)[] = [];
    // The native side hands over what follows terminalx://settings/: the row id, unchanged.
    await followSettingDeepLink({ id, enable: false }, (row) => opened.push(row));
    expect(opened).toEqual([id]);
    const view = render(<SettingsPage initialTab={opened[0]!} onBack={vi.fn()} />);
    const nav = projectPages("One");
    expect(nav.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(nav.getAllByRole("button").map((button) => button.textContent)).toEqual(["General", "Scripts", "Actions", "Environment", "Settings files"]);
    expect(screen.getByText("Root path")).toBeTruthy();
    const row = view.container.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);
    expect(row?.getAttribute("data-setting-instance")).toBe("/repos/one");
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(row?.dataset.settingHighlight).toBe("on");
    view.unmount();
  }
});

describe("row search over repository rows (PRO-127)", () => {
  it("opens a repository row on the repository already open, else the first listed, and highlights it", () => {
    const view = render(<SettingsPage onBack={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search settings" });
    fireEvent.change(input, { target: { value: "worktreeinclude" } });
    const result = screen.getByRole("row", { name: /Files to copy/ });
    expect(result.closest('[role="rowgroup"]')?.textContent).toContain("Projects");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "One" }).getAttribute("aria-expanded")).toBe("true");
    let row = view.container.querySelector<HTMLElement>('[data-setting-id="repositories.filesToCopy"]');
    expect(row?.getAttribute("data-setting-instance")).toBe("/repos/one");
    expect(document.activeElement).toBe(row);
    expect(row?.dataset.settingHighlight).toBe("on");

    fireEvent.click(within(screen.getByRole("group", { name: "Projects" })).getByRole("button", { name: "Two" }));
    fireEvent.change(input, { target: { value: "worktreeinclude" } });
    fireEvent.click(screen.getByRole("row", { name: /Files to copy/ }));
    expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-expanded")).toBe("true");
    row = view.container.querySelector<HTMLElement>('[data-setting-id="repositories.filesToCopy"]');
    expect(row?.getAttribute("data-setting-instance")).toBe("/repos/two");
    expect(document.activeElement).toBe(row);
  });
});


it("labels the title-bar fallback as personal when the selected project has neither settings file (#1090)", async () => {
  const personalPath = "/Users/me/.raccoon/settings.json";
  const status = vi.spyOn(settingsFile, "useSettingsFile").mockReturnValue({
    file: { path: personalPath, displayPath: "~/.raccoon/settings.json", exists: true, error: null, problem: null, setKeys: [], preferences: {} },
    error: null, revision: 0, saveFailure: null,
  });
  const files = vi.spyOn(configuration, "files").mockResolvedValue([
    { layer: "repositoryShared", path: "/repos/two/.terminalx/settings.json", displayPath: "/repos/two/.terminalx/settings.json", exists: false, keys: 0, git: null, problem: null },
    { layer: "repositoryLocal", path: "/repos/two/.terminalx/settings.local.json", displayPath: "/repos/two/.terminalx/settings.local.json", exists: false, keys: 0, git: null, problem: null },
  ]);
  const open = vi.spyOn(configuration, "openFile").mockResolvedValue(undefined);
  try {
    render(<SettingsPage initialTab="repositories" initialProjectPath="/repos/two" onBack={vi.fn()} />);
    await waitFor(() => expect(files).toHaveBeenCalledWith("/repos/two"));
    fireEvent.click(screen.getByRole("button", { name: "Open personal settings.json" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(personalPath, null));
    expect(screen.queryByRole("button", { name: "Open settings.json" })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More ways to open personal settings.json" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Project · shared.*none yet/ }).getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: /Project · local.*none yet/ }).getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: /Your settings/ }).hasAttribute("data-current")).toBe(true);
  } finally {
    cleanup();
    status.mockRestore();
    files.mockRestore();
    open.mockRestore();
  }
});
