import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: "Delete Dev" }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith("/repo", { actions: [] } satisfies ProjectPatch));
    expect(screen.queryByRole("button", { name: "Reset to repository file" })).toBeNull();
  });

  it("shows a failed save inline and as a toast, keeping the stored list", async () => {
    mock.update.mockRejectedValue(new Error("disk full"));
    render(<RepositoryActionsPage projectPath="/repo" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Dev" }));
    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    expect(mock.toast).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Edit Dev" })).toBeTruthy();
  });

  it("resets to the repository file only where one supplies actions", async () => {
    mock.update.mockResolvedValue(undefined);
    const file = { ...dev, id: "f", name: "From file" };
    const { unmount } = render(<RepositoryActionsPage projectPath="/repo" readRepositoryFile={async () => [file]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reset to repository file" }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith("/repo", { actions: [file] }));
    unmount();
    for (const none of [async () => null, async () => [] as RepositoryAction[], async () => { throw new Error("unreadable"); }]) {
      const view = render(<RepositoryActionsPage projectPath="/repo" readRepositoryFile={none} />);
      await screen.findByRole("button", { name: "Edit Dev" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByRole("button", { name: "Reset to repository file" })).toBeNull();
      view.unmount();
    }
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
