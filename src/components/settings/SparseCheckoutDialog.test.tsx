import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryFolders } from "@/types/repositoryFolders";
import type { Project } from "@/types/session";
import { SparseCheckoutDialog, sparseCheckoutValue } from "./SparseCheckoutDialog";

const mock = vi.hoisted(() => ({ folders: vi.fn(), repo: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { repositoryFolders: mock.folders }, issues: { githubRepo: mock.repo }, errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)) }));
vi.mock("@/lib/configuration", () => ({ configuration: { write: mock.write, resolve: vi.fn(), watch: vi.fn() } }));

const MB = 1_000_000;
const project: Project = { path: "/repo", name: "example" };
const listing = (measured: boolean): RepositoryFolders => {
  const size = (bytes: number) => (measured ? bytes : null);
  return {
    folders: [
      // 4 MB of its own files beside its two subfolders' 96 MB.
      { path: "apps", description: "Console and web", size: size(100 * MB), children: [
        { path: "apps/console", description: "Web console", size: size(61 * MB), children: [] },
        { path: "apps/web", description: "Marketing site", size: size(35 * MB), children: [] },
      ] },
      { path: "src", description: "React app", size: size(18 * MB), children: [] },
      { path: "docs", description: null, size: size(6 * MB), children: [] },
    ],
    rootFiles: { count: 4, size: size(2 * MB) },
    totalSize: size(126 * MB),
    sizesError: null,
  };
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const box = (name: string) => screen.getByRole("checkbox", { name });
const summary = () => document.querySelector("[data-sparse-summary]")?.textContent ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  mock.folders.mockImplementation(async (_path: string, measure: boolean) => listing(measure));
  mock.repo.mockResolvedValue("example-org/example");
  mock.write.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function openDialog(value: string[] | null = null, onClose = vi.fn(), onSaved = vi.fn()) {
  render(<SparseCheckoutDialog project={project} value={value} onClose={onClose} onSaved={onSaved} />);
  await screen.findByRole("checkbox", { name: "src/" });
  await waitFor(() => expect(summary()).toContain("about"));
  return { onClose, onSaved };
}

describe("SparseCheckoutDialog", () => {
  it("lists the folders at once, then asks for sizes, and names the project, repository and full size", async () => {
    await openDialog();
    expect(mock.folders.mock.calls).toEqual([["/repo", false], ["/repo", true]]);
    expect(screen.getByRole("dialog", { name: "Check out only some folders" })).toBeTruthy();
    expect(screen.getByText("example · example-org/example · 126 MB when checked out in full")).toBeTruthy();
    expect(screen.getByText("Files at the root")).toBeTruthy();
    expect(screen.getByText("always checked out")).toBeTruthy();
    expect(summary()).toBe("3 of 3 folders· about 126 MB of 126 MB");
    expect(screen.getByText(/Agents can’t open folders that aren’t checked out; they ask you to add one\./)).toBeTruthy();
    expect(screen.getByText("for everyone on this project", { exact: false }).textContent).toBe("Saved in .terminalx/settings.json for everyone on this project");
  });

  it("updates the summary as boxes are ticked, counting a parent with any chosen child", async () => {
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(summary()).toBe("0 of 3 folders· about 2 MB of 126 MB");
    fireEvent.click(box("src/"));
    expect(summary()).toBe("1 of 3 folders· about 20 MB of 126 MB");
    fireEvent.click(screen.getByRole("button", { name: "Show folders in apps/" }));
    fireEvent.click(box("apps/console/"));
    // Cone mode checks out apps/'s own 4 MB of files with any of its subfolders.
    expect(summary()).toBe("2 of 3 folders· about 85 MB of 126 MB");
    expect(box("apps/").getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(box("apps/web/"));
    expect(summary()).toBe("2 of 3 folders· about 120 MB of 126 MB");
    fireEvent.click(box("docs/"));
    // Everything ticked adds up to the full size: the root files and every listed folder.
    expect(summary()).toBe("3 of 3 folders· about 126 MB of 126 MB");
  });

  it("offers a folder whose name the setting cannot hold only as part of a full checkout, and says which", async () => {
    mock.folders.mockImplementation(async (_path: string, measure: boolean) => {
      const base = listing(measure);
      const size = (bytes: number) => (measure ? bytes : null);
      base.folders.push(
        { path: "glob*", description: "Odd name", size: size(1 * MB), children: [] },
        { path: "pages", description: null, size: size(3 * MB), children: [
          { path: "pages/[locale]", description: null, size: size(1 * MB), children: [] },
          { path: "pages/what?", description: null, size: size(1 * MB), children: [] },
        ] },
      );
      base.totalSize = size(130 * MB);
      return base;
    });
    await openDialog();
    expect(screen.getByText(/Only with all folders: its name has \*, \? or \\/)).toBeTruthy();
    // A subfolder the setting cannot name makes its parent a single choice.
    expect(screen.queryByRole("button", { name: "Show folders in pages/" })).toBeNull();
    fireEvent.click(box("docs/"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("glob*/ can’t be checked out on its own");
    expect(mock.write).not.toHaveBeenCalled();
    fireEvent.click(box("glob*/"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mock.write).toHaveBeenLastCalledWith("/repo", "repositoryShared", "sparseCheckout", ["apps", "src", "pages"]));
  });

  it("expands a parent and shows checked, partial and empty boxes", async () => {
    await openDialog(["apps/web", "src"]);
    // A partly chosen parent opens on its own.
    expect(screen.getByRole("button", { name: "Hide folders in apps/" }).getAttribute("aria-expanded")).toBe("true");
    expect(box("apps/").getAttribute("aria-checked")).toBe("mixed");
    expect(box("apps/web/").getAttribute("aria-checked")).toBe("true");
    expect(box("apps/console/").getAttribute("aria-checked")).toBe("false");
    expect(box("docs/").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box("apps/"));
    expect(box("apps/").getAttribute("aria-checked")).toBe("true");
    expect(box("apps/console/").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(box("apps/"));
    expect(box("apps/").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Hide folders in apps/" }));
    expect(screen.queryByRole("checkbox", { name: "apps/web/" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show folders in apps/" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("Select all and Clear choose every folder or none", async () => {
    await openDialog(["docs"]);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    for (const name of ["apps/", "src/", "docs/"]) expect(box(name).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    for (const name of ["apps/", "src/", "docs/"]) expect(box(name).getAttribute("aria-checked")).toBe("false");
  });

  it("filters folders by path or description, showing a parent's matching children", async () => {
    await openDialog();
    const filter = screen.getByRole("searchbox", { name: "Filter folders" });
    fireEvent.change(filter, { target: { value: "marketing" } });
    expect(screen.getByRole("checkbox", { name: "apps/" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "apps/web/" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "apps/console/" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "src/" })).toBeNull();
    fireEvent.change(filter, { target: { value: "SRC" } });
    expect(screen.getByRole("checkbox", { name: "src/" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "apps/" })).toBeNull();
    fireEvent.change(filter, { target: { value: "nothing-like-this" } });
    expect(screen.getByText("No folders match.")).toBeTruthy();
    // The root files row is always listed.
    expect(screen.getByText("Files at the root")).toBeTruthy();
  });

  it("shows the list while sizes are measured, then the sizes", async () => {
    const measured = deferred<RepositoryFolders>();
    mock.folders.mockImplementation((_path: string, measure: boolean) => (measure ? measured.promise : Promise.resolve(listing(false))));
    render(<SparseCheckoutDialog project={project} value={null} onClose={vi.fn()} />);
    await screen.findByRole("checkbox", { name: "src/" });
    expect(summary()).toBe("3 of 3 folders· measuring sizes…");
    expect(screen.getAllByLabelText("Measuring size").length).toBe(4);
    expect(screen.getByText(/measuring size…/)).toBeTruthy();
    await act(async () => measured.resolve(listing(true)));
    expect(screen.queryAllByLabelText("Measuring size")).toHaveLength(0);
    expect(within(document.querySelector('[data-folder-row="src"]') as HTMLElement).getByText("18 MB")).toBeTruthy();
    expect(summary()).toBe("3 of 3 folders· about 126 MB of 126 MB");
  });

  it("keeps listing folders and says so when sizes cannot be read", async () => {
    mock.folders.mockImplementation(async (_path: string, measure: boolean) => ({ ...listing(false), sizesError: measure ? "git ls-tree failed" : null }));
    render(<SparseCheckoutDialog project={project} value={null} onClose={vi.fn()} />);
    await screen.findByText("Sizes could not be read: git ls-tree failed");
    expect(screen.getByRole("checkbox", { name: "src/" })).toBeTruthy();
    expect(summary()).toBe("3 of 3 folders");
    expect(screen.getByText("example · example-org/example")).toBeTruthy();
  });

  it("says sizes could not be read when they stay empty or the measuring call fails", async () => {
    mock.folders.mockImplementation(async (_path: string, measure: boolean) => { if (measure) throw new Error("timed out"); return listing(false); });
    render(<SparseCheckoutDialog project={project} value={null} onClose={vi.fn()} />);
    await screen.findByText("Sizes could not be read: timed out");
    cleanup();
    mock.folders.mockImplementation(async () => listing(false));
    render(<SparseCheckoutDialog project={project} value={null} onClose={vi.fn()} />);
    await screen.findByText("Sizes could not be read.");
    expect(screen.getByRole("checkbox", { name: "docs/" })).toBeTruthy();
  });

  it("saves null for every folder, so the row goes back to a full checkout", async () => {
    const { onClose, onSaved } = await openDialog(["src"]);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mock.write).toHaveBeenCalledWith("/repo", "repositoryShared", "sparseCheckout", null));
    expect(onSaved).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalled();
  });

  it("saves a fully chosen parent as the parent and a partial one as its chosen children", async () => {
    await openDialog();
    fireEvent.click(box("docs/"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mock.write).toHaveBeenLastCalledWith("/repo", "repositoryShared", "sparseCheckout", ["apps", "src"]));
    cleanup();
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Show folders in apps/" }));
    fireEvent.click(box("apps/web/"));
    // Cmd+Enter saves too.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mock.write).toHaveBeenLastCalledWith("/repo", "repositoryShared", "sparseCheckout", ["apps/console", "src", "docs"]));
    cleanup();
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(mock.write).toHaveBeenLastCalledWith("/repo", "repositoryShared", "sparseCheckout", []));
  });

  it("keeps saved paths the list does not show unless a chosen folder covers them", () => {
    const folders = listing(true).folders;
    expect(sparseCheckoutValue(folders, new Set(["docs"]), ["vendor/deep/one", "docs/inner"])).toEqual(["docs", "vendor/deep/one"]);
    expect(sparseCheckoutValue(folders, new Set(["apps/console", "apps/web", "src", "docs"]), ["vendor"])).toBeNull();
  });

  it("Cancel and the close button write nothing", async () => {
    const { onClose } = await openDialog(["src"]);
    fireEvent.click(box("docs/"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("shows a write error in the dialog and stays open", async () => {
    mock.write.mockRejectedValue(new Error("settings file is not valid JSON"));
    const { onClose } = await openDialog();
    fireEvent.click(box("docs/"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save: settings file is not valid JSON");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says when the folders cannot be listed and offers nothing to save", async () => {
    mock.folders.mockRejectedValue(new Error("not a git repository"));
    render(<SparseCheckoutDialog project={project} value={null} onClose={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not list this repository's folders: not a git repository");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
