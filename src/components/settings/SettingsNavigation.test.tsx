import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types/session";

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  updateProject: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
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
  return { ...actual, experimental: { ...actual.experimental, settings: vi.fn(async () => ({ nativeCodex: false })) } };
});
const { SettingsPage } = await import("./SettingsPage");

beforeEach(() => {
  mocks.updateProject.mockReset().mockResolvedValue(undefined);
  mocks.projects = [
    { path: "/repos/one", name: "One", kind: "git" },
    { path: "/repos/two", name: "Two", kind: "git" },
    { path: "/notes", name: "Notes", kind: "folder" },
    { path: "/repos/old", name: "Archived", archived: true },
  ];
});
afterEach(cleanup);

describe("registry navigation", () => {
  it("opens and saves Scripts for the chosen repository alongside its cleanup controls", async () => {
    render(<SettingsPage onBack={vi.fn()} />);
    const group = within(screen.getByRole("group", { name: "Repositories" }));
    fireEvent.click(group.getByRole("button", { name: "Two" }));
    fireEvent.click(group.getByRole("button", { name: "Scripts" }));
    expect(group.getByRole("button", { name: "Scripts" }).getAttribute("aria-current")).toBe("page");
    expect(group.getByRole("button", { name: "Workspace cleanup" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Archive script"), { target: { value: "docker compose down" } });
    fireEvent.click(screen.getByRole("button", { name: "Save scripts" }));
    await screen.findByText("Scripts saved.");
    expect(mocks.updateProject).toHaveBeenCalledWith("/repos/two", { scripts: { setup: "", archive: "docker compose down" } });
    fireEvent.click(group.getByRole("button", { name: "Workspace cleanup" }));
    expect(screen.getByRole("radiogroup", { name: "Delete merged workspaces of Two" })).toBeTruthy();
    expect(screen.queryByLabelText("Archive script")).toBeNull();
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
  expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull();
});

it("opens a Scripts row link for its repository and focuses its registered editor", () => {
  const view = render(<SettingsPage initialTab="repositories.scripts" initialProjectPath="/repos/two" onBack={vi.fn()} />);
  const row = view.container.querySelector('[data-setting-id="repositories.scripts"]');
  expect(row?.getAttribute("data-setting-instance")).toBe("/repos/two");
  expect(document.activeElement).toBe(row);
  expect(screen.getByRole("button", { name: "Scripts" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("radiogroup", { name: "Delete merged workspaces of Two" })).toBeNull();
});
