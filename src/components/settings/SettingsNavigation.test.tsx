import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types/session";

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

describe("registry navigation", () => {
  it("opens the registered privacy row through a stable row link", () => {
    const view = render(<SettingsPage initialTab="general.dataPrivacy" onBack={vi.fn()} />);
    const row = view.container.querySelector('[data-setting-id="general.dataPrivacy"]');
    expect(row).toBeTruthy();
    expect(row?.contains(screen.getByRole("switch", { name: "Data privacy mode" }))).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it("opens a repository's cleanup controls, then saves its Scripts from the Scripts page", async () => {
    render(<SettingsPage onBack={vi.fn()} />);
    const group = within(screen.getByRole("group", { name: "Repositories" }));
    fireEvent.click(group.getByRole("button", { name: "Two" }));
    expect(group.getByRole("button", { name: "Two" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Delete merged workspaces of Two" })).toBeTruthy();
    expect(screen.queryByLabelText("Archive script")).toBeNull();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Repository settings" })).getByRole("button", { name: "Scripts" }));
    fireEvent.change(await screen.findByLabelText("Archive script"), { target: { value: "docker compose down" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]);
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
    const group = within(screen.getByRole("group", { name: "Repositories" }));
    expect(group.queryByRole("button", { name: "Archived" })).toBeNull();
    expect(group.getByRole("button", { name: "Notes" })).toBeTruthy();
    // A row a repository, no expander holding a single item.
    expect(group.queryByRole("button", { name: "Workspace cleanup" })).toBeNull();
    expect(group.getByRole("button", { name: "One" }).hasAttribute("aria-expanded")).toBe(false);
    fireEvent.click(group.getByRole("button", { name: "One" }));
    expect(group.getByRole("button", { name: "One" }).getAttribute("aria-current")).toBe("page");
    expect(group.getByRole("button", { name: "Two" }).hasAttribute("aria-current")).toBe(false);
    expect(screen.getByRole("heading", { name: "One" })).toBeTruthy();
    expect(view.container.querySelector('[data-setting-id="repositories.mergedCleanup"]')?.getAttribute("data-setting-instance")).toBe("/repos/one");
    expect(screen.getByRole("radiogroup", { name: "Delete merged workspaces of One" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Delete merged workspaces of Two" })).toBeNull();
    mocks.projects = mocks.projects.filter((project) => project.path !== "/repos/one");
    view.rerender(<SettingsPage onBack={vi.fn()} />);
    expect(screen.queryByRole("radiogroup", { name: "Delete merged workspaces of One" })).toBeNull();
    expect(screen.getByText("Choose a repository to view its settings.")).toBeTruthy();
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
  expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-current")).toBe("page");
  expect(view.container.querySelector('[data-setting-id="repositories.mergedCleanup"]')?.getAttribute("data-setting-instance")).toBe("/repos/two");
});

// ⌘K, a toast's Open setting and a terminalx://settings/<row-id> link name a row, not a repository (PRO-127).
it("opens a repository row that names no repository on the first listed one, and marks the row", () => {
  const view = render(<SettingsPage initialTab="repositories.mergedCleanup" onBack={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "One" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "One" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText("Choose a repository to view its settings.")).toBeNull();
  expect(view.container.querySelector('[data-setting-id="repositories.mergedCleanup"]')?.getAttribute("data-setting-instance")).toBe("/repos/one");
});

it("opens a repository row that names no repository on the one already open", () => {
  const view = render(<SettingsPage initialTab="repositories.mergedCleanup" initialProjectPath="/repos/two" onBack={vi.fn()} />);
  view.rerender(<SettingsPage initialTab="repositories.scripts" openRequest={1} onBack={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
  expect(view.container.querySelector('[data-setting-id="repositories.scripts"]')?.getAttribute("data-setting-instance")).toBe("/repos/two");
});

it("does not choose a repository for the person when no row was asked for", () => {
  render(<SettingsPage initialTab="repositories" onBack={vi.fn()} />);
  expect(screen.getByText("Choose a repository to view its settings.")).toBeTruthy();
});

it("lists folder projects and explains why Git cleanup does not apply to them", () => {
  render(<SettingsPage initialTab="repositories.mergedCleanup" initialProjectPath="/notes" onBack={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy();
  expect(screen.getByText("Workspace cleanup is available for Git repositories. This project is a folder.")).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Delete merged workspaces of Notes" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull();
});

it("opens a Scripts row link on its repository's page and focuses its registered editor", () => {
  const view = render(<SettingsPage initialTab="repositories.scripts" initialProjectPath="/repos/two" onBack={vi.fn()} />);
  const row = view.container.querySelector('[data-setting-id="repositories.scripts"]');
  expect(row?.getAttribute("data-setting-instance")).toBe("/repos/two");
  expect(document.activeElement).toBe(row);
  expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-current")).toBe("page");
});

it("opens the custom order registry row and keeps the window choice independent of shared order events", async () => {
  const view = render(<SettingsPage initialTab="appearance.customOrder" onBack={vi.fn()} />);
  const row = view.container.querySelector('[data-setting-id="appearance.customOrder"]');
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
  expect(screen.queryByRole("navigation", { name: "Repository settings" })).toBeNull();
});

it("opens registered repository paths and files, retains drafts within a repository, and isolates them across repositories", async () => {
  const view = render(<SettingsPage initialTab="repositories.workspacesPath" initialProjectPath="/repos/one" onBack={vi.fn()} />);
  const group = within(screen.getByRole("navigation", { name: "Repository settings" }));
  const workspace = await screen.findByText("/repos/one/.raccoon/worktrees");
  expect(document.activeElement).toBe(workspace.closest('[data-setting-id="repositories.workspacesPath"]'));
  expect(group.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(group.getByRole("button", { name: "Files to copy" }));
  const textarea = screen.getByRole("textbox", { name: "Glob patterns (one per line)" });
  fireEvent.change(textarea, { target: { value: ".env*" } });
  await screen.findByText(".env.local");
  expect(view.container.querySelector('[data-setting-id="repositories.filesToCopy"]')?.getAttribute("data-setting-instance")).toBe("/repos/one");
  fireEvent.click(group.getByRole("button", { name: "General" }));
  fireEvent.click(group.getByRole("button", { name: "Files to copy" }));
  expect((screen.getByRole("textbox", { name: "Glob patterns (one per line)" }) as HTMLTextAreaElement).value).toBe(".env*");
  view.rerender(<SettingsPage initialTab="repositories.filesToCopy" initialProjectPath="/repos/two" onBack={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-current")).toBe("page");
  const row = view.container.querySelector('[data-setting-id="repositories.filesToCopy"]');
  expect(row?.getAttribute("data-setting-instance")).toBe("/repos/two");
  expect(document.activeElement).toBe(row);
  expect((screen.getByRole("textbox", { name: "Glob patterns (one per line)" }) as HTMLTextAreaElement).value).toBe("");
  expect(group.getAllByRole("button", { name: "Files to copy" }).map((button) => button.getAttribute("aria-current"))).toEqual(["page"]);
});

describe("row search over repository rows (PRO-127)", () => {
  it("opens a repository row on the repository already open, else the first listed, and highlights it", () => {
    const view = render(<SettingsPage onBack={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search settings" });
    fireEvent.change(input, { target: { value: "worktreeinclude" } });
    const result = screen.getByRole("option", { name: /Files to copy/ });
    expect(result.closest('[role="group"]')?.textContent).toContain("Repositories");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "One" }).getAttribute("aria-current")).toBe("page");
    let row = view.container.querySelector<HTMLElement>('[data-setting-id="repositories.filesToCopy"]');
    expect(row?.getAttribute("data-setting-instance")).toBe("/repos/one");
    expect(document.activeElement).toBe(row);
    expect(row?.dataset.settingHighlight).toBe("on");

    fireEvent.click(within(screen.getByRole("group", { name: "Repositories" })).getByRole("button", { name: "Two" }));
    fireEvent.change(input, { target: { value: "worktreeinclude" } });
    fireEvent.click(screen.getByRole("option", { name: /Files to copy/ }));
    expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-current")).toBe("page");
    row = view.container.querySelector<HTMLElement>('[data-setting-id="repositories.filesToCopy"]');
    expect(row?.getAttribute("data-setting-instance")).toBe("/repos/two");
    expect(document.activeElement).toBe(row);
  });
});
