import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryFolders } from "@/types/repositoryFolders";
import type { Project } from "@/types/session";
import { RegisteredSetting } from "./settingsRegistry";
import { SparseCheckoutRow } from "./SparseCheckoutRow";

const mock = vi.hoisted(() => ({ folders: vi.fn(), repo: vi.fn(), resolve: vi.fn(), write: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), changed: null as null | (() => void), value: undefined as unknown }));
vi.mock("@/lib/api", () => ({ api: { repositoryFolders: mock.folders }, issues: { githubRepo: mock.repo }, errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)) }));
vi.mock("@/lib/configuration", () => ({ configuration: { resolve: mock.resolve, write: mock.write, watch: mock.watch } }));

const project: Project = { path: "/repo", name: "example" };
const listing = (measure: boolean): RepositoryFolders => ({
  folders: [
    { path: "apps", description: null, size: measure ? 10 : null, children: [
      { path: "apps/console", description: null, size: measure ? 6 : null, children: [] },
      { path: "apps/web", description: null, size: measure ? 4 : null, children: [] },
    ] },
    { path: "src", description: null, size: measure ? 5 : null, children: [] },
    { path: "docs", description: null, size: measure ? 1 : null, children: [] },
    { path: "e2e", description: null, size: measure ? 2 : null, children: [] },
  ],
  rootFiles: { count: 1, size: measure ? 1 : null }, totalSize: measure ? 19 : null, sizesError: null,
});
const resolved = () => ({ values: mock.value === undefined ? {} : { sparseCheckout: { value: mock.value, source: "repositoryShared", locked: false, redacted: false } }, registry: [], warnings: [], trust: null });
const choice = () => document.querySelector("[data-sparse-choice]")?.textContent;

beforeEach(() => {
  vi.clearAllMocks();
  mock.value = undefined;
  mock.changed = null;
  mock.folders.mockImplementation(async (_path: string, measure: boolean) => listing(measure));
  mock.repo.mockResolvedValue(null);
  mock.resolve.mockImplementation(async () => resolved());
  mock.watch.mockImplementation(async (_path: string, changed: () => void) => { mock.changed = changed; return mock.unwatch; });
  mock.write.mockImplementation(async (_path: string, _layer: string, _key: string, value: unknown) => { mock.value = value ?? undefined; });
});
afterEach(cleanup);

describe("SparseCheckoutRow", () => {
  it("says all folders for a full checkout", async () => {
    render(<SparseCheckoutRow project={project} />);
    await waitFor(() => expect(choice()).toBe("All 4 folders"));
    expect(mock.resolve).toHaveBeenCalledWith("/repo");
    expect(screen.getByText("Check out only some folders")).toBeTruthy();
    expect(screen.getByText("New workspaces check out only the folders you pick. Useful in a large repository. Existing workspaces are unaffected.")).toBeTruthy();
  });

  it("counts the chosen top-level folders, a parent with a chosen child among them", async () => {
    mock.value = ["apps/web", "src"];
    render(<SparseCheckoutRow project={project} />);
    await waitFor(() => expect(choice()).toBe("2 of 4 folders"));
  });

  it("reads the value again when the settings files change, and stops watching on unmount", async () => {
    const view = render(<SparseCheckoutRow project={project} />);
    await waitFor(() => expect(choice()).toBe("All 4 folders"));
    await waitFor(() => expect(mock.changed).not.toBeNull());
    mock.value = ["docs"];
    await act(async () => mock.changed?.());
    await waitFor(() => expect(choice()).toBe("1 of 4 folders"));
    view.unmount();
    expect(mock.unwatch).toHaveBeenCalled();
  });

  it("opens the dialog, and Select all then Save returns the row to all folders", async () => {
    mock.value = ["src"];
    render(<SparseCheckoutRow project={project} />);
    await waitFor(() => expect(choice()).toBe("1 of 4 folders"));
    fireEvent.click(screen.getByRole("button", { name: "Choose folders…" }));
    await screen.findByRole("checkbox", { name: "docs/" });
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mock.write).toHaveBeenCalledWith("/repo", "repositoryShared", "sparseCheckout", null));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(choice()).toBe("All 4 folders");
  });

  it("Cancel leaves the row and the file as they were", async () => {
    mock.value = ["src", "docs"];
    render(<SparseCheckoutRow project={project} />);
    await waitFor(() => expect(choice()).toBe("2 of 4 folders"));
    fireEvent.click(screen.getByRole("button", { name: "Choose folders…" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "e2e/" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mock.write).not.toHaveBeenCalled();
    expect(choice()).toBe("2 of 4 folders");
  });

  it("shows why the setting cannot be read", async () => {
    mock.resolve.mockRejectedValue(new Error("settings file is not valid JSON"));
    render(<SparseCheckoutRow project={project} />);
    expect((await screen.findByRole("status")).textContent).toBe("Could not read this setting: settings file is not valid JSON");
    expect((screen.getByRole("button", { name: "Choose folders…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is the registered row's anchor", async () => {
    const view = render(<RegisteredSetting setting="repositories.sparseCheckout" instance="/repo"><SparseCheckoutRow project={project} /></RegisteredSetting>);
    await waitFor(() => expect(choice()).toBe("All 4 folders"));
    expect(view.container.querySelector('[data-setting-id="repositories.sparseCheckout"]')?.getAttribute("data-setting-instance")).toBe("/repo");
  });
});
