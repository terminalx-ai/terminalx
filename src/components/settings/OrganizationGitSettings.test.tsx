import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), saveIdentity: vi.fn(), saveToken: vi.fn(), removeToken: vi.fn(), gitIdentity: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { gitIdentity: mocks.gitIdentity } }));
vi.mock("@/lib/account", () => ({ useAccount: vi.fn() }));
vi.mock("@/lib/organizationGit", async (original) => ({ ...(await original<typeof import("@/lib/organizationGit")>()), organizationGit: mocks }));
const { OrganizationGitSettings } = await import("./OrganizationGitSettings");
const settings = { identity: { name: "Work", email: "work@example.com" }, tokenConfigured: false, tokenSharedUse: null, canManage: true, contextRevision: "org-one" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue(settings);
  mocks.gitIdentity.mockResolvedValue({ name: "Personal", email: "personal@example.com" });
});
afterEach(cleanup);
it("shows the replaced default, validates input and removes only the organisation override", async () => {
  render(<OrganizationGitSettings contextRevision="one" />);
  await screen.findByText(/Personal <personal@example.com>/);
  fireEvent.change(screen.getByLabelText("Organization commit email"), { target: { value: "invalid" } });
  expect((screen.getByRole("button", { name: "Save commit author" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Use default" }));
  await waitFor(() => expect(mocks.saveIdentity).toHaveBeenCalledWith(null, "org-one"));
  expect(mocks.gitIdentity).toHaveBeenCalledTimes(1);
});
it("requires both sharing confirmations, sends the PAT once and clears it from the input", async () => {
  render(<OrganizationGitSettings contextRevision="one" tokenOnly />);
  await waitFor(() => expect((screen.getByLabelText("GitHub personal access token") as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("Advanced: GitHub personal access token"));
  fireEvent.change(screen.getByLabelText("GitHub personal access token"), { target: { value: "synthetic-token" } });
  expect(screen.getByText("Clones and pushes will act as the token's owner.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save token" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I may share this token/));
  fireEvent.click(screen.getByLabelText(/I allow this token/));
  fireEvent.click(screen.getByRole("button", { name: "Save token" }));
  await waitFor(() => expect(mocks.saveToken).toHaveBeenCalledWith("synthetic-token", "managers", "org-one"));
  expect((screen.getByLabelText("GitHub personal access token") as HTMLInputElement).value).toBe("");
});
it("keeps members read-only and drops late results after the account changes", async () => {
  let resolve!: (value: typeof settings) => void;
  mocks.get.mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValue({ ...settings, identity: null, canManage: false, contextRevision: "org-two" });
  const view = render(<OrganizationGitSettings contextRevision="one" />);
  view.rerender(<OrganizationGitSettings contextRevision="two" />);
  await screen.findByText(/Only organization owners and admins/);
  resolve(settings);
  await waitFor(() => expect((screen.getByLabelText("Organization commit name") as HTMLInputElement).value).toBe(""));
  fireEvent.click(screen.getByText("Advanced: GitHub personal access token"));
  expect((screen.getByRole("button", { name: "Save token" }) as HTMLButtonElement).disabled).toBe(true);
});
