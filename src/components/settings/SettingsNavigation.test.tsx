import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types/session";

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  environmentList: vi.fn(async (_project: string | null) => []),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@/lib/sessions", async (original) => {
  const actual = await original<typeof import("@/lib/sessions")>();
  return { ...actual, useSessionStore: () => ({ ...actual.useSessionStore(), projects: mocks.projects }) };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => { if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name); };
  }),
}));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, experimental: { ...actual.experimental, settings: vi.fn(async () => ({ nativeCodex: false })) } };
});
vi.mock("@/lib/localEnvironment", async (original) => {
  const actual = await original<typeof import("@/lib/localEnvironment")>();
  return { ...actual, environment: { ...actual.environment, list: mocks.environmentList } };
});
const { SettingsPage } = await import("./SettingsPage");

beforeEach(() => {
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

  it("expands each repository independently and opens its existing cleanup controls", () => {
    const view = render(<SettingsPage onBack={vi.fn()} />);
    const group = within(screen.getByRole("group", { name: "Repositories" }));
    expect(group.queryByRole("button", { name: "Archived" })).toBeNull();
    expect(group.getByRole("button", { name: "Notes" })).toBeTruthy();
    expect(group.queryByRole("button", { name: "Workspace cleanup" })).toBeNull();
    fireEvent.click(group.getByRole("button", { name: "One" }));
    expect(group.getByRole("button", { name: "One" }).getAttribute("aria-expanded")).toBe("true");
    expect(group.getByRole("button", { name: "Two" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(group.getByRole("button", { name: "Workspace cleanup" }));
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

it("opens a repository row link on the named project and expands its navigation entry", () => {
  const view = render(<SettingsPage initialTab="repositories.mergedCleanup" initialProjectPath="/repos/two" onBack={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-expanded")).toBe("true");
  expect(view.container.querySelector('[data-setting-id="repositories.mergedCleanup"]')?.getAttribute("data-setting-instance")).toBe("/repos/two");
});

it("lists folder projects and explains why Git cleanup does not apply to them", () => {
  render(<SettingsPage initialTab="repositories.mergedCleanup" initialProjectPath="/notes" onBack={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy();
  expect(screen.getByText("Workspace cleanup is available for Git repositories. This project is a folder.")).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Delete merged workspaces of Notes" })).toBeNull();
});
