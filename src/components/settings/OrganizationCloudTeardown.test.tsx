import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type CloudTeardown, type CloudTeardownPreview, type CloudTeardownResource } from "@/lib/api";
import { OrganizationCloudTeardown, teardownPreviewText, teardownResourceText } from "./OrganizationCloudTeardown";

vi.mock("@/lib/api", () => ({ api: { cloudTeardownStatus: vi.fn(), cloudTeardownPreview: vi.fn(), cloudTeardownRequest: vi.fn() } }));
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

const view = (props: Partial<Parameters<typeof OrganizationCloudTeardown>[0]> = {}) => <OrganizationCloudTeardown contextRevision="rev-1" organizationId="org-1" organizationName="Acme" {...props} />;
const mount = (props: Partial<Parameters<typeof OrganizationCloudTeardown>[0]> = {}) => render(view(props));
const counts = (fields: Partial<CloudTeardownPreview> = {}): CloudTeardownPreview => ({ organizationId: "org-1", workspaces: 7, privateWorkspaces: 3, archivedWorkspaces: 2, ...fields });
const button = (name: RegExp | string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const typeName = (value: string) => fireEvent.change(screen.getByLabelText("Organization name"), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  mocked.cloudTeardownStatus.mockResolvedValue(null);
  mocked.cloudTeardownPreview.mockResolvedValue(counts());
});

afterEach(cleanup);

describe("OrganizationCloudTeardown", () => {
  it("shows how many workspaces it takes, private ones included, and sends nothing until the name is typed", async () => {
    mocked.cloudTeardownRequest.mockResolvedValue(teardown());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    // The safer choice is the one preselected.
    expect((screen.getByRole("radio", { name: /Archive everything/ }) as HTMLInputElement).checked).toBe(true);
    const confirm = button("Archive every workspace");
    typeName("Acme");
    // Not before the server's count is on screen.
    expect(confirm.disabled).toBe(true);
    const count = await screen.findByTestId("cloud-teardown-count");
    expect(mocked.cloudTeardownPreview).toHaveBeenCalledWith("org-1");
    expect(count.textContent).toBe(
      "This takes every cloud workspace of Acme: 7 cloud workspaces, including 3 private ones that belong to other people and may not appear in your own list. 2 are already archived.",
    );
    expect(confirm.disabled).toBe(false);
    typeName("acme");
    expect(confirm.disabled).toBe(true);
    typeName(" Acme ");
    fireEvent.click(confirm);
    // For the organization and the context the confirmation was opened at.
    await waitFor(() => expect(mocked.cloudTeardownRequest).toHaveBeenCalledWith("org-1", "rev-1", "archive"));
    expect(mocked.cloudTeardownRequest).toHaveBeenCalledTimes(1);

    const status = await screen.findByTestId("cloud-teardown-status");
    expect(status.getAttribute("data-disposition")).toBe("archive");
    expect(status.textContent).toMatch(/every workspace is archived, and deleted on .* \(in 29 days\)/);
    expect(status.textContent).toMatch(/Nobody in the organization can create, resume or unarchive.*cannot be cancelled/);
    expect(screen.getAllByTestId("cloud-teardown-remaining")).toHaveLength(1);
    expect(screen.queryByTestId("cloud-teardown-confirm")).toBeNull();
  });

  it("words the count for one workspace, none private, and for an organization with none", () => {
    expect(teardownPreviewText(counts({ workspaces: 1, privateWorkspaces: 0, archivedWorkspaces: 0 }), "Acme")).toBe("This takes every cloud workspace of Acme: 1 cloud workspace.");
    expect(teardownPreviewText(counts({ workspaces: 2, privateWorkspaces: 1, archivedWorkspaces: 1 }), "Acme")).toMatch(/2 cloud workspaces, including 1 private one that belongs to other people.*1 is already archived/);
    expect(teardownPreviewText(counts({ workspaces: 0, privateWorkspaces: 0, archivedWorkspaces: 0 }), "Acme")).toMatch(/has no cloud workspaces now/);
  });

  it("cannot be started when the count cannot be read", async () => {
    mocked.cloudTeardownPreview.mockRejectedValue({ code: "cloud_workspace_unavailable" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/number of workspaces this would take could not be read.*cannot be started from here/);
    typeName("Acme");
    expect(button("Archive every workspace").disabled).toBe(true);
    expect(mocked.cloudTeardownRequest).not.toHaveBeenCalled();
  });

  it("a confirmation opened for one organization is void once the active organization changes", async () => {
    const shown = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    await screen.findByTestId("cloud-teardown-count");
    typeName("Acme");
    expect(button("Archive every workspace").disabled).toBe(false);
    // The active organization changes (another window, a switch in Settings): the page re-renders for it.
    mocked.cloudTeardownPreview.mockResolvedValue(counts({ organizationId: "org-2", workspaces: 40 }));
    shown.rerender(view({ contextRevision: "rev-2", organizationId: "org-2", organizationName: "Beta" }));
    await waitFor(() => expect(screen.queryByTestId("cloud-teardown-confirm")).toBeNull());
    expect(mocked.cloudTeardownRequest).not.toHaveBeenCalled();
    // Starting again asks about, and names, the organization now active; the name typed before is gone.
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    expect((await screen.findByTestId("cloud-teardown-count")).textContent).toMatch(/every cloud workspace of Beta: 40 cloud workspaces/);
    expect((screen.getByLabelText("Organization name") as HTMLInputElement).value).toBe("");
    expect(button("Archive every workspace").disabled).toBe(true);
  });

  it("says nothing was sent when the native side refuses for a changed context, before the page has re-rendered", async () => {
    mocked.cloudTeardownRequest.mockRejectedValue({ code: "account_context_changed" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    await screen.findByTestId("cloud-teardown-count");
    typeName("Acme");
    fireEvent.click(button("Archive every workspace"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/active organization changed after this was opened, so nothing was sent/);
    // What was sent named the organization the confirmation was for.
    expect(mocked.cloudTeardownRequest).toHaveBeenCalledWith("org-1", "rev-1", "archive");
  });

  it("shows counts only for the organization the confirmation names", async () => {
    mocked.cloudTeardownPreview.mockResolvedValue(counts({ organizationId: "org-2" }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/active organization changed/);
    expect(screen.queryByTestId("cloud-teardown-count")).toBeNull();
  });

  it("deletes everything now only after the same confirmation, and offers nothing more once it runs", async () => {
    mocked.cloudTeardownRequest.mockResolvedValue(teardown({ disposition: "destroy", retentionDeadline: Date.now() }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Shut down cloud workspaces…" }));
    await screen.findByTestId("cloud-teardown-count");
    fireEvent.click(screen.getByRole("radio", { name: /Delete everything now/ }));
    typeName("Acme");
    fireEvent.click(button("Delete every workspace"));
    await waitFor(() => expect(mocked.cloudTeardownRequest).toHaveBeenCalledWith("org-1", "rev-1", "destroy"));
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
    await screen.findByTestId("cloud-teardown-count");
    typeName("Acme");
    fireEvent.click(button("Delete every workspace"));
    await waitFor(() => expect(mocked.cloudTeardownRequest).toHaveBeenCalledWith("org-1", "rev-1", "destroy"));
  });

  it("lists what remains, names what a shutdown does not remove, and what the provider kept", async () => {
    const runtime = resource("rt-1", { kind: "session-runtime", state: "ready", releaseDisposition: null });
    const stuck = resource("ws-2", { state: "attention-required", cleanupRequired: true });
    const kept = resource("ws-3", { state: "destroyed", releaseDisposition: "archived" });
    mocked.cloudTeardownStatus.mockResolvedValue(teardown({ disposition: "destroy", resources: [runtime, stuck, kept], remaining: [runtime, stuck] }));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("cloud-teardown-remaining")).toHaveLength(2));
    expect(screen.getByText("2 things remain at the providers:")).toBeTruthy();
    expect(screen.getByText("Boat · Workspace ws-2: needs attention, cleanup unresolved")).toBeTruthy();
    expect(screen.getByText("Boat · Session runtime rt-1: running")).toBeTruthy();
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
    await screen.findByTestId("cloud-teardown-count");
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
