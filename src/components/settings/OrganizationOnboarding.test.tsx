import { StrictMode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { refreshAccount } from "@/lib/account";
import { OrganizationOnboarding } from "./OrganizationOnboarding";

vi.mock("@/lib/api", () => ({
  api: { organizationCreate: vi.fn(), organizationSelect: vi.fn() },
  errorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/account", () => ({ refreshAccount: vi.fn() }));
vi.mock("./ProviderControls", () => ({
  ProviderControls: () => <div>Provider setup</div>,
}));
const props = {
  accountEmail: "owner@example.test",
  contextRevision: "session-1",
  organizationName: null,
  organizations: [],
};
const organization = { id: "org-1", name: "Team", role: "owner" };
const start = () => {
  fireEvent.change(screen.getByRole("textbox", { name: "Organization name" }), {
    target: { value: "Team" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
};
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});
afterEach(cleanup);

it("continues first-time creation into provider setup under StrictMode", async () => {
  vi.mocked(api.organizationCreate).mockResolvedValue(organization);
  const view = render(
    <StrictMode>
      <OrganizationOnboarding {...props} />
    </StrictMode>,
  );
  start();
  await waitFor(() => expect(refreshAccount).toHaveBeenCalledOnce());
  view.rerender(
    <StrictMode>
      <OrganizationOnboarding
        {...props}
        contextRevision="session-2"
        organizationName="Team"
        organizations={[organization]}
      />
    </StrictMode>,
  );
  expect(screen.getByText("Provider setup")).toBeTruthy();
  expect(
    localStorage.getItem("terminalx.organization-setup.v1.owner@example.test"),
  ).toBeNull();
  expect(api.organizationCreate).toHaveBeenCalledOnce();
});

it("replays the same creation after profile selection fails and the session revision changes", async () => {
  vi.mocked(api.organizationCreate).mockRejectedValueOnce(
    new Error("Profile selection timed out"),
  );
  render(<OrganizationOnboarding {...props} />);
  start();
  await screen.findByText("Profile selection timed out");
  const original = vi.mocked(api.organizationCreate).mock.calls[0];
  cleanup();
  vi.mocked(api.organizationCreate).mockResolvedValue(organization);
  render(
    <OrganizationOnboarding
      {...props}
      contextRevision="session-after-restart"
    />,
  );
  expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Resume setup" }));
  await waitFor(() => expect(refreshAccount).toHaveBeenCalledOnce());
  expect(vi.mocked(api.organizationCreate).mock.calls[1]).toEqual(original);
});

it("resumes the returned organization after back navigation without creating again", async () => {
  vi.mocked(api.organizationCreate).mockResolvedValue(organization);
  render(<OrganizationOnboarding {...props} />);
  start();
  await waitFor(() => expect(refreshAccount).toHaveBeenCalledOnce());
  cleanup();
  render(<OrganizationOnboarding {...props} contextRevision="new-session" />);
  fireEvent.click(screen.getByRole("button", { name: "Resume setup" }));
  await waitFor(() =>
    expect(api.organizationSelect).toHaveBeenCalledWith("org-1", "new-session"),
  );
  expect(api.organizationCreate).toHaveBeenCalledOnce();
});

it("does not expose another account's pending creation", async () => {
  vi.mocked(api.organizationCreate).mockRejectedValue(new Error("Timeout"));
  render(<OrganizationOnboarding {...props} />);
  start();
  await screen.findByText("Timeout");
  cleanup();
  render(
    <OrganizationOnboarding {...props} accountEmail="member@example.test" />,
  );
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  expect(screen.queryByRole("button", { name: "Resume setup" })).toBeNull();
});

it("keeps a second organization's recovery separate from the existing provider controls", async () => {
  vi.mocked(api.organizationCreate).mockRejectedValue(
    new Error("Selection timeout"),
  );
  const existing = { id: "existing", name: "Existing", role: "owner" };
  render(
    <OrganizationOnboarding
      {...props}
      organizationName="Existing"
      organizations={[existing]}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Create or switch organization" }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "New organization name" }),
    { target: { value: "Second" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("Selection timeout");
  expect(screen.queryByText("Provider setup")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Hide organization creation" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Create or switch organization" }),
  );
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
    "Second",
  );
  expect(
    (screen.getByRole("button", { name: "Resume setup" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
