import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LayeredConfiguration } from "./LayeredConfiguration";
const { resolve, write, review } = vi.hoisted(() => ({ resolve: vi.fn(), write: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/configuration", async (original) => ({ ...await original<typeof import("@/lib/configuration")>(), configuration: { resolve, write, review } }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: [{ path: "/repo", name: "App", kind: "git" }, { path: "cloud:o:w", name: "Remote", kind: "git" }] }) }));
const fixture = (locked = false) => ({ values: { branchPrefix: { value: "team/", source: locked ? "managed" : "repositoryShared", locked, redacted: false } }, registry: [{ key: "branchPrefix", repositoryConfigurable: true, managedLockable: true, requiresTrust: true }], warnings: [], trust: null });
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); resolve.mockResolvedValue(fixture()); write.mockResolvedValue(undefined); review.mockResolvedValue(false); });

it("defaults every editor to user writes and explicitly selects repository local or shared", async () => {
  render(<LayeredConfiguration />);
  await screen.findByDisplayValue("team/");
  expect(screen.queryByText("Remote")).toBeNull();
  expect((screen.getByLabelText("Save to") as HTMLSelectElement).value).toBe("user");
  fireEvent.change(screen.getByLabelText("Branch prefix"), { target: { value: "mine/" } });
  fireEvent.click(screen.getByRole("button", { name: "Save prefix" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(null, "user", "branchPrefix", "mine/"));
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "/repo" } });
  await waitFor(() => expect(resolve).toHaveBeenCalledWith("/repo"));
  await screen.findByDisplayValue("team/");
  fireEvent.change(screen.getByLabelText("Save to"), { target: { value: "repositoryLocal" } });
  fireEvent.click(screen.getByRole("button", { name: "Save prefix" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith("/repo", "repositoryLocal", "branchPrefix", "team/"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Reset selected layer" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Save to"), { target: { value: "repositoryShared" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset selected layer" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith("/repo", "repositoryShared", "branchPrefix", null));
});

it("shows managed source and locks editing, saving and resetting", async () => {
  resolve.mockResolvedValue(fixture(true));
  render(<LayeredConfiguration />);
  await screen.findByText(/Locked by managed configuration/);
  for (const name of ["Save prefix", "Reset selected layer"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Branch prefix") as HTMLInputElement).disabled).toBe(true);
});

it("a declined native trust review leaves shared values blocked", async () => {
  const pending = { ...fixture(), trust: { hash: "file-hash", required: true, keys: ["environment.API_URL"] } };
  resolve.mockResolvedValueOnce(fixture()).mockResolvedValue(pending);
  render(<LayeredConfiguration />);
  await screen.findByDisplayValue("team/");
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "/repo" } });
  fireEvent.click(await screen.findByRole("button", { name: "Review repository trust" }));
  await screen.findByText("Not trusted. Nothing was started.");
  expect(review).toHaveBeenCalledWith("/repo");
  expect(write).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Review repository trust" })).toBeTruthy();
});

it("displays a failed save and never claims it succeeded", async () => {
  write.mockRejectedValue(new Error("This setting is locked by managed configuration."));
  render(<LayeredConfiguration />);
  await screen.findByDisplayValue("team/");
  fireEvent.click(screen.getByRole("button", { name: "Save prefix" }));
  expect((await screen.findByRole("alert")).textContent).toContain("locked");
  expect(screen.queryByText("Saved to User.")).toBeNull();
});


it("loads in React StrictMode after the first effect is cancelled", async () => {
  render(<StrictMode><LayeredConfiguration /></StrictMode>);
  await screen.findByDisplayValue("team/");
  await waitFor(() => expect((screen.getByRole("button", { name: "Save prefix" }) as HTMLButtonElement).disabled).toBe(false));
});
