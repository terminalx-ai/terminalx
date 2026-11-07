import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project } from "@/types/session";
const state = vi.hoisted(() => ({ projects: [] as Project[], update: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => state, updateProject: state.update }));
import { RepositoryScriptsTab } from "./RepositoryScriptsTab";
afterEach(cleanup);
beforeEach(() => {
  state.projects = [{ path: "/a", name: "a", scripts: { setup: "npm ci", archive: "" } }, { path: "/b", name: "b" }];
  state.update.mockReset().mockResolvedValue(undefined);
});
it("loads and saves both scripts for the selected repository", async () => {
  const view = render(<RepositoryScriptsTab projectPath="/a" />);
  expect((screen.getByLabelText("Setup script") as HTMLTextAreaElement).value).toBe("npm ci");
  fireEvent.change(screen.getByLabelText("Archive script"), { target: { value: "docker compose down\nexit 0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save scripts" }));
  await screen.findByText("Scripts saved.");
  expect(state.update).toHaveBeenCalledWith("/a", { scripts: { setup: "npm ci", archive: "docker compose down\nexit 0" } });
  view.rerender(<RepositoryScriptsTab projectPath="/b" />);
  expect((screen.getByLabelText("Archive script") as HTMLTextAreaElement).value).toBe("");
  expect((screen.getByLabelText("Setup script") as HTMLTextAreaElement).value).toBe("");
  expect(screen.getByText(/not available in this version/)).toBeTruthy();
});
it("preserves the draft and offers retry when saving fails", async () => {
  state.update.mockRejectedValueOnce(new Error("Disk unavailable"));
  render(<RepositoryScriptsTab projectPath="/a" />);
  fireEvent.change(screen.getByLabelText("Archive script"), { target: { value: "cleanup" } });
  fireEvent.click(screen.getByRole("button", { name: "Save scripts" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Disk unavailable");
  await waitFor(() => expect((screen.getByRole("button", { name: "Save scripts" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Archive script") as HTMLTextAreaElement).value).toBe("cleanup");
  fireEvent.click(screen.getByRole("button", { name: "Save scripts" }));
  await screen.findByText("Scripts saved.");
});
it("does not offer scripts for ordinary folders", () => {
  state.projects = [{ path: "/folder", name: "folder", kind: "folder" }];
  render(<RepositoryScriptsTab projectPath="/folder" />);
  expect(screen.getByText("Open a repository to configure its scripts.")).toBeTruthy();
});

it("does not fall back to another repository when the requested project is unavailable", () => {
  state.projects[0].archived = true;
  const view = render(<RepositoryScriptsTab projectPath="/a" />);
  expect(screen.queryByLabelText("Archive script")).toBeNull();
  view.rerender(<RepositoryScriptsTab projectPath="/missing" />);
  expect(screen.queryByLabelText("Archive script")).toBeNull();
});
