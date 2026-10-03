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
vi.mock("./OrganizationSetupSteps", () => ({
  OrganizationSetupSteps: ({ record }: { record: { organizationId: string; step: string } }) => (
    <div data-testid="steps">
      {record.organizationId}:{record.step}
    </div>
  ),
}));
const KEY = "terminalx.organization-setup.v2.owner%40example%2Etest";
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as { v: number; records: Record<string, unknown>[] } | null;
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

it("names the selector for what it decides once every organization is live (CS-18)", () => {
  const organizations = [
    { id: "org-a", name: "Acme", role: "owner" },
    { id: "org-b", name: "Beta", role: "member" },
  ];
  const view = render(<OrganizationOnboarding {...props} organizationName="Acme" organizations={organizations} />);
  expect(screen.getByRole("combobox", { name: "Organization" })).toBeTruthy();
  view.rerender(<OrganizationOnboarding {...props} organizationName="Acme" organizations={organizations} multiOrg />);
  expect(screen.getByRole("combobox", { name: "Default organization for new cloud work" })).toBeTruthy();
});


it("keeps a created organization that could not be selected, and only selects it on resume (PRO-16)", async () => {
  vi.mocked(api.organizationCreate).mockResolvedValue({ ...organization, selected: false, selectionError: "account context changed" });
  render(<OrganizationOnboarding {...props} />);
  start();
  await screen.findByText(/was created, but could not be selected \(account context changed\)/);
  const [record] = stored()!.records;
  expect(record).toMatchObject({ v: 2, organizationId: "org-1", step: "select", name: "Team", requestId: vi.mocked(api.organizationCreate).mock.calls[0]![1] });
  cleanup();

  vi.mocked(api.organizationSelect).mockRejectedValueOnce(new Error("Still offline"));
  render(<OrganizationOnboarding {...props} contextRevision="later" />);
  fireEvent.click(screen.getByRole("button", { name: "Resume setup" }));
  await screen.findByText("Still offline");
  fireEvent.click(screen.getByRole("button", { name: "Resume setup" }));
  await waitFor(() => expect(api.organizationSelect).toHaveBeenCalledTimes(2));
  expect(api.organizationSelect).toHaveBeenLastCalledWith("org-1", "later");
  // Selection failing never runs creation again.
  expect(api.organizationCreate).toHaveBeenCalledOnce();
  await waitFor(() => expect(stored()!.records[0]).toMatchObject({ organizationId: "org-1", step: "compute" }));
});

it("never applies a setup record to a different active organization, and keeps it through a profile switch (PRO-16)", async () => {
  vi.mocked(api.organizationCreate).mockResolvedValue(organization);
  const other = { id: "org-other", name: "Team", role: "owner" };
  const view = render(<OrganizationOnboarding {...props} />);
  start();
  await waitFor(() => expect(refreshAccount).toHaveBeenCalledOnce());
  // Another organization with the same name is active: the record is not its.
  view.rerender(<OrganizationOnboarding {...props} organizationName="Team" organizationId="org-other" organizations={[other, organization]} />);
  expect(screen.queryByTestId("steps")).toBeNull();
  expect(screen.getByText("Provider setup")).toBeTruthy();
  expect(stored()!.records).toHaveLength(1);
  // Back on the organization it was made for, its setup carries on.
  view.rerender(<OrganizationOnboarding {...props} organizationName="Team" organizationId="org-1" organizations={[other, organization]} />);
  expect(screen.getByTestId("steps").textContent).toBe("org-1:compute");
});

it("reads the record left by the previous version once, as the same creation request", async () => {
  localStorage.setItem("terminalx.organization-setup.v1.owner@example.test", JSON.stringify({ name: "Team", key: "key-from-v1" }));
  vi.mocked(api.organizationCreate).mockResolvedValue(organization);
  render(<OrganizationOnboarding {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Resume setup" }));
  await waitFor(() => expect(api.organizationCreate).toHaveBeenCalledWith("Team", "key-from-v1"));
  expect(localStorage.getItem("terminalx.organization-setup.v1.owner@example.test")).toBeNull();
});
