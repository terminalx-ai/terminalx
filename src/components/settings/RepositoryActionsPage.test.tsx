import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryAction } from "@/lib/repositoryActions";
import type { Project, ProjectPatch } from "@/types/session";

const mock = vi.hoisted(() => ({ projects: [] as unknown[], update: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: mock.projects }), updateProject: mock.update }));
vi.mock("@/lib/errorToasts", () => ({ showError: mock.toast }));
vi.mock("@/lib/api", () => ({ errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));

import { RepositoryActionsPage } from "./RepositoryActionsPage";
import { RepositoryPreviewUrlsPage } from "./RepositoryPreviewUrlsPage";

const dev: RepositoryAction = { id: "dev", name: "Dev", icon: "play", command: "pnpm dev", concurrent: false, runAfterSetup: false, hidden: false };
const project = (extra: Partial<Project> = {}): Project => ({ path: "/repo", name: "repo", kind: "git", ...extra }) as Project;

beforeEach(() => {
  mock.projects = [project({ actions: [dev], previewUrls: [{ id: "a", name: "App", url: "http://localhost:$PORT" }] })];
  mock.update.mockReset();
  mock.toast.mockReset();
});
afterEach(cleanup);

describe("repository settings pages", () => {
  it("lists saved actions and saves a deletion through update_project", async () => {
    mock.update.mockResolvedValue(undefined);
    render(<RepositoryActionsPage projectPath="/repo" />);
    expect(screen.getByRole("heading", { name: "Actions" })).toBeTruthy();
    expect(screen.getByText("Commands for this project's Run menu.")).toBeTruthy();
    expect(screen.queryByText("/repo")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Dev" }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith("/repo", { actions: [] } satisfies ProjectPatch));
    expect(screen.queryByRole("button", { name: "Reset all actions to terminalx.json", hidden: true })).toBeNull();
  });

  it("shows a failed save inline and as a toast, keeping the stored list", async () => {
    mock.update.mockRejectedValue(new Error("disk full"));
    render(<RepositoryActionsPage projectPath="/repo" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Dev" }));
    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    expect(mock.toast).toHaveBeenCalledOnce();
    // The dialog stays open on the stored list; closing it shows Dev still there.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Edit Dev" })).toBeTruthy();
  });

  it("resets to the repository file only where one supplies actions", async () => {
    mock.update.mockResolvedValue(undefined);
    const file = { ...dev, id: "f", name: "From file" };
    const { unmount } = render(<RepositoryActionsPage projectPath="/repo" readRepositoryFile={async () => [file]} />);
    await act(async () => undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Reset all actions to terminalx.json" }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith("/repo", { actions: [file] }));
    unmount();
    for (const none of [async () => null, async () => [] as RepositoryAction[], async () => { throw new Error("unreadable"); }]) {
      const view = render(<RepositoryActionsPage projectPath="/repo" readRepositoryFile={none} />);
      await screen.findByRole("button", { name: "Edit Dev" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
      expect(screen.queryByRole("button", { name: "Reset all actions to terminalx.json", hidden: true })).toBeNull();
      view.unmount();
    }
  });

  it("keeps reset at list level after editing two actions and deleting every action", async () => {
    const test = { ...dev, id: "test", name: "Test", command: "pnpm test" };
    const fileActions = [dev, test];
    const readRepositoryFile = vi.fn(async () => fileActions);
    mock.projects = [project({ actions: fileActions })];
    const view = render(<RepositoryActionsPage projectPath="/repo" readRepositoryFile={readRepositoryFile} />);
    mock.update.mockImplementation(async (_path: string, patch: ProjectPatch) => {
      mock.projects = [project(patch)];
      view.rerender(<RepositoryActionsPage projectPath="/repo" readRepositoryFile={readRepositoryFile} />);
    });
    await screen.findByRole("button", { name: "Reset all actions to terminalx.json" });
    for (const name of ["Dev", "Test"]) {
      fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
      expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /Reset/ })).toBeNull();
      fireEvent.change(screen.getByRole("textbox", { name: "Command" }), { target: { value: `echo custom ${name}` } });
      fireEvent.click(screen.getByRole("button", { name: "Save action" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(mock.update).toHaveBeenLastCalledWith("/repo", { actions: [
      { ...dev, command: "echo custom Dev" }, { ...test, command: "echo custom Test" },
    ] });
    fireEvent.click(screen.getByRole("button", { name: "Reset all actions to terminalx.json" }));
    await waitFor(() => expect(mock.update).toHaveBeenLastCalledWith("/repo", { actions: fileActions }));
    for (const name of ["Dev", "Test"]) {
      fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
      fireEvent.click(screen.getByRole("button", { name: `Delete ${name}` }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(screen.queryByRole("list", { name: "Saved actions" })).toBeNull();
    expect(mock.update).toHaveBeenLastCalledWith("/repo", { actions: [] });
    fireEvent.click(screen.getByRole("button", { name: "Reset all actions to terminalx.json" }));
    await screen.findByRole("button", { name: "Edit Dev" });
    expect(screen.getByRole("button", { name: "Edit Test" })).toBeTruthy();
    expect(mock.update).toHaveBeenLastCalledWith("/repo", { actions: fileActions });
    expect(readRepositoryFile).toHaveBeenCalledExactlyOnceWith("/repo");
  });

  it("saves preview URLs and asks to open a repository when none matches", async () => {
    mock.update.mockResolvedValue(undefined);
    const { unmount } = render(<RepositoryPreviewUrlsPage projectPath="/repo" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete App" }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith("/repo", { previewUrls: [] }));
    unmount();
    render(<RepositoryPreviewUrlsPage projectPath="/other" />);
    expect(screen.getByText(/Open a repository/)).toBeTruthy();
  });
});
