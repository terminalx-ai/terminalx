import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type CloudTeardown, type CloudTeardownResource } from "@/lib/api";
import { OrganizationCloudTeardown, teardownResourceText } from "./OrganizationCloudTeardown";

vi.mock("@/lib/api", () => ({ api: { cloudTeardownStatus: vi.fn(), cloudTeardownRequest: vi.fn() } }));
vi.mock("@/lib/cloudCatalog", () => ({ cloudOrgArg: (orgId: string | null) => orgId }));
vi.mock("@/lib/cloudSession", () => ({ cloudProviderName: (provider: string) => (provider === "box" ? "Boat" : provider) }));

const mocked = vi.mocked(api);
const DAY = 86_400_000;

const resource = (id: string, fields: Partial<CloudTeardownResource> = {}): CloudTeardownResource => ({
  provider: "box",
  id,
  kind: "workspace",
  state: "archived",
  releaseDisposition: "destroyed",
  cleanupRequired: false,
  deleteAfter: null,
  ...fields,
});

function teardown(fields: Partial<CloudTeardown> = {}): CloudTeardown {
  const remaining = [resource("ws-1", { deleteAfter: Date.now() + 29.5 * DAY })];
  return { organizationId: "org-1", disposition: "archive", requestedAt: Date.now(), retentionDeadline: Date.now() + 29.5 * DAY, completedAt: null, resources: remaining, remaining, ...fields };
}

const mount = (props: Partial<Parameters<typeof OrganizationCloudTeardown>[0]> = {}) => render(<OrganizationCloudTeardown contextRevision="rev-1" organizationName="Acme" {...props} />);
const button = (name: RegExp | string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const typeName = (value: string) => fireEvent.change(screen.getByLabelText("Organization name"), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  mocked.cloudTeardownStatus.mockResolvedValue(null);
});

afterEach(cleanup);

describe("OrganizationCloudTeardown", () => {
  it("sends nothing until a disposition is chosen and the organization's name is typed", async () => {
    mocked.cloudTeardownRequest.mockResolvedValue(teardown());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    const confirm = button("Delete every workspace");
    expect(confirm.disabled).toBe(true);
    typeName("Acme");
    // The name alone is not enough: what happens to the data must be chosen.
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Archive everything/ }));
    typeName("acme");
    expect(button("Archive every workspace").disabled).toBe(true);
    typeName(" Acme ");
    fireEvent.click(button("Archive every workspace"));
    await waitFor(() => expect(mocked.cloudTeardownRequest).toHaveBeenCalledWith("archive", null));
    expect(mocked.cloudTeardownRequest).toHaveBeenCalledTimes(1);

    const status = await screen.findByTestId("cloud-teardown-status");
    expect(status.getAttribute("data-disposition")).toBe("archive");
    expect(status.textContent).toMatch(/every workspace is archived, and deleted on .* \(in 29 days\)/);
    expect(status.textContent).toMatch(/Nobody in the organization can create, resume or unarchive.*cannot be cancelled/);
    expect(screen.getAllByTestId("cloud-teardown-remaining")).toHaveLength(1);
    expect(screen.queryByTestId("cloud-teardown-confirm")).toBeNull();
  });

  it("deletes everything now only after the same confirmation, and offers nothing more once it runs", async () => {
    mocked.cloudTeardownRequest.mockResolvedValue(teardown({ disposition: "destroy", retentionDeadline: Date.now() }));
    mount({ orgId: "org-1" });
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    fireEvent.click(screen.getByRole("radio", { name: /Delete everything now/ }));
    typeName("Acme");
    fireEvent.click(button("Delete every workspace"));
    await waitFor(() => expect(mocked.cloudTeardownRequest).toHaveBeenCalledWith("destroy", "org-1"));
    expect((await screen.findByTestId("cloud-teardown-status")).textContent).toMatch(/every workspace is being deleted/);
    expect(screen.queryByRole("button", { name: /Shut down cloud workspaces|Delete everything now/ })).toBeNull();
  });

  it("a pending archive can only be escalated to deleting now", async () => {
    mocked.cloudTeardownStatus.mockResolvedValue(teardown());
    mocked.cloudTeardownRequest.mockResolvedValue(teardown({ disposition: "destroy" }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Delete everything now…" }));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByTestId("cloud-teardown-confirm").textContent).toMatch(/deletes every archived workspace now instead of at the deadline/);
    expect(button("Delete every workspace").disabled).toBe(true);
    typeName("Acme");
    fireEvent.click(button("Delete every workspace"));
    await waitFor(() => expect(mocked.cloudTeardownRequest).toHaveBeenCalledWith("destroy", null));
  });

  it("lists what remains, names what a shutdown does not remove, and what the provider kept", async () => {
    const runtime = resource("rt-1", { kind: "session-runtime", state: "ready", releaseDisposition: null });
    const stuck = resource("ws-2", { state: "attention-required", cleanupRequired: true });
    const kept = resource("ws-3", { state: "destroyed", releaseDisposition: "archived" });
    mocked.cloudTeardownStatus.mockResolvedValue(teardown({ disposition: "destroy", resources: [runtime, stuck, kept], remaining: [runtime, stuck] }));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("cloud-teardown-remaining")).toHaveLength(2));
    expect(screen.getByText("2 things remain at the providers:")).toBeTruthy();
    expect(screen.getByText("Boat · Workspace ws-2: attention-required, cleanup unresolved")).toBeTruthy();
    expect(screen.getByText(/removes workspaces only\. Session runtimes and build templates/)).toBeTruthy();
    expect(screen.getByTestId("cloud-teardown-kept").textContent).toMatch(/1 released workspace is still listed because the provider kept it/);
    expect(teardownResourceText(resource("ws-9", { deleteAfter: 5 * DAY }), 0)).toBe("Boat · Workspace ws-9: archived, deleted in 5 days");
  });

  it("says when a shutdown finished, and that workspaces can be created again", async () => {
    mocked.cloudTeardownStatus.mockResolvedValue(teardown({ completedAt: Date.now(), resources: [], remaining: [] }));
    mount();
    const status = await screen.findByTestId("cloud-teardown-status");
    expect(status.getAttribute("data-disposition")).toBe("completed");
    expect(status.textContent).toMatch(/nothing that blocks closing the organization remains.*can be created again/);
    expect(screen.queryByTestId("cloud-teardown-remaining")).toBeNull();
    expect(button("Shut down cloud workspaces…")).toBeTruthy();
  });

  it("asks nothing for a member, and offers nothing when the status cannot be read", async () => {
    const view = mount({ member: true });
    expect(view.container.textContent).toBe("");
    expect(mocked.cloudTeardownStatus).not.toHaveBeenCalled();
    cleanup();

    // The server says it is not theirs: the section goes, without an error.
    mocked.cloudTeardownStatus.mockRejectedValue({ code: "organization_admin_required" });
    const refused = mount();
    await waitFor(() => expect(refused.container.textContent).toBe(""));
    cleanup();

    mocked.cloudTeardownStatus.mockRejectedValue({ code: "cloud_workspace_unavailable" });
    mount();
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not offer an organization-wide shutdown/);
    // Whether one is already running is not known: starting one is not offered.
    expect(screen.queryByRole("button", { name: /Shut down cloud workspaces/ })).toBeNull();
  });

  it("keeps the confirmation open and says so when the request's outcome is unknown", async () => {
    mocked.cloudTeardownRequest.mockRejectedValue({ code: "cloud_workspace_request_outcome_unknown" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    fireEvent.click(screen.getByRole("radio", { name: /Delete everything now/ }));
    typeName("Acme");
    fireEvent.click(button("Delete every workspace"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/may or may not have gone through\. Refresh/);
    expect(screen.getByTestId("cloud-teardown-confirm")).toBeTruthy();
    // Refresh reads the truth.
    mocked.cloudTeardownStatus.mockResolvedValue(teardown({ disposition: "destroy" }));
    fireEvent.click(button("Refresh shutdown status"));
    expect((await screen.findByTestId("cloud-teardown-status")).textContent).toMatch(/being deleted/);
  });
});
