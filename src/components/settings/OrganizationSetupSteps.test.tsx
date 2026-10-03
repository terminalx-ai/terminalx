import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { organizationGithubApp } from "@/lib/organizationGithubApp";
import { ENVIRONMENT_CHECK_PROMPT, newSetup, type OrganizationSetupRecord } from "@/lib/organizationSetup";
import { OrganizationSetupSteps } from "./OrganizationSetupSteps";

vi.mock("@/lib/api", () => ({
  api: { cloudProviders: vi.fn(), cloudWorkspaces: vi.fn(), cloudWorkspaceSetup: vi.fn(), cloudWorkspaceQuote: vi.fn(), cloudWorkspaceCreate: vi.fn(), cloudWorkspacePreflight: vi.fn() },
  errorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/organizationGithubApp", () => ({ organizationGithubApp: { summary: vi.fn() } }));

const snapshot = { workspace: { id: "ws-1", name: "Setup check", state: "provisioning" }, operation: { id: "op", state: "running", type: "create", stage: "queued" } };
/** The create answers, and from then on the list has the workspace. */
const creates = () => {
  vi.mocked(api.cloudWorkspaces).mockResolvedValue({ workspaces: [{ workspace: snapshot.workspace, latestOperation: snapshot.operation }] } as never);
  return snapshot as never;
};
let record: OrganizationSetupRecord;
const history: OrganizationSetupRecord[] = [];
const view = () => (
  <OrganizationSetupSteps
    record={record}
    organizationId="org-1"
    onRecord={(next) => {
      record = next;
      history.push(next);
    }}
  />
);

beforeEach(() => {
  vi.resetAllMocks();
  history.length = 0;
  record = { ...newSetup("Team", "request-1", 1), organizationId: "org-1", step: "compute" };
  vi.mocked(api.cloudProviders).mockResolvedValue({ providers: [{ id: "box", displayName: "Box", availability: "available" }] } as never);
  vi.mocked(organizationGithubApp.summary).mockResolvedValue({ repositories: [{ fullName: "acme/app", cloneUrl: "https://github.com/acme/app.git", state: "accessible" }] } as never);
  vi.mocked(api.cloudWorkspaces).mockResolvedValue({ workspaces: [] } as never);
  vi.mocked(api.cloudWorkspacePreflight).mockResolvedValue({ ready: true, checks: [] });
  vi.mocked(api.cloudWorkspaceSetup).mockResolvedValue({ defaults: { sourceId: "s", locationId: "l", machineClassId: "m", idleSuspendMinutes: 30, retentionDays: 7 } } as never);
  vi.mocked(api.cloudWorkspaceQuote).mockResolvedValue({ id: "quote-1", currency: "USD", activeHourlyMicros: 120_000 } as never);
});
afterEach(cleanup);

it("reconciles against the server when shown, and says what is missing", async () => {
  vi.mocked(organizationGithubApp.summary).mockResolvedValue({ repositories: [] } as never);
  const shown = render(view());
  await waitFor(() => expect(record.step).toBe("repository"));
  shown.rerender(view());
  expect(screen.getByText(/choose at least one repository/)).toBeTruthy();
  expect(api.cloudWorkspaceCreate).not.toHaveBeenCalled();
});

it("reads the server once when shown, not on every render", async () => {
  const shown = render(view());
  await waitFor(() => expect(record.step).toBe("workspace"));
  shown.rerender(view());
  shown.rerender(view());
  await screen.findByRole("button", { name: "Prepare setup workspace" });
  expect(api.cloudProviders).toHaveBeenCalledOnce();
  expect(api.cloudWorkspaces).toHaveBeenCalledOnce();
});

it("shows the price and the prepared prompt before creating one setup workspace", async () => {
  vi.mocked(api.cloudWorkspaceCreate).mockImplementation(async () => creates());
  const shown = render(view());
  await waitFor(() => expect(record.step).toBe("workspace"));
  shown.rerender(view());
  fireEvent.click(screen.getByRole("button", { name: "Prepare setup workspace" }));
  const confirm = await screen.findByTestId("organization-setup-confirm");
  expect(confirm.textContent).toContain("acme/app");
  expect(confirm.textContent).toContain("per hour");
  expect(confirm.textContent).toContain("Do not change any files");
  // Nothing is created, and nothing is stored, until it is confirmed.
  expect(api.cloudWorkspaceCreate).not.toHaveBeenCalled();
  expect(record.workspace).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Create setup workspace" }));
  await waitFor(() => expect(record.step).toBe("runtime"));
  expect(record.workspace).toEqual({ pending: null, id: "ws-1" });
  expect(api.cloudWorkspaceCreate).toHaveBeenCalledOnce();
  const request = vi.mocked(api.cloudWorkspaceCreate).mock.calls[0]![0];
  expect(request.launch).toMatchObject({ agent: "claude", prompt: ENVIRONMENT_CHECK_PROMPT });
  expect(request.repositories).toEqual([{ cloneUrl: "https://github.com/acme/app.git", ref: null }]);
  // The request was stored before it was sent.
  expect(history.find((entry) => entry.workspace?.pending)?.workspace?.pending?.idempotencyKey).toBe(request.idempotencyKey);
  expect(record.agent).toBe("required");
});

it("resends the same request after an unknown outcome: one workspace, the prompt once", async () => {
  const unknown = { code: "cloud_workspace_create_outcome_unknown", retryWithSameIdempotencyKey: true };
  vi.mocked(api.cloudWorkspaceCreate).mockRejectedValueOnce(unknown).mockImplementationOnce(async () => creates());
  const shown = render(view());
  await waitFor(() => expect(record.step).toBe("workspace"));
  shown.rerender(view());
  fireEvent.click(screen.getByRole("button", { name: "Prepare setup workspace" }));
  await screen.findByTestId("organization-setup-confirm");
  fireEvent.click(screen.getByRole("button", { name: "Create setup workspace" }));
  await screen.findByText(/may have created the workspace/);
  expect(record.workspace?.pending).not.toBeNull();
  const first = vi.mocked(api.cloudWorkspaceCreate).mock.calls[0]![0];

  // The app is closed and opened again: only the stored record is left.
  cleanup();
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Resume creating the setup workspace" }));
  await waitFor(() => expect(record.workspace).toEqual({ pending: null, id: "ws-1" }));
  expect(api.cloudWorkspaceCreate).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.cloudWorkspaceCreate).mock.calls[1]![0]).toEqual(first);
  expect(api.cloudWorkspaceQuote).toHaveBeenCalledOnce();
});

it("starts over with a new request after a definite refusal", async () => {
  vi.mocked(api.cloudWorkspaceCreate).mockRejectedValue({ code: "cloud_workspace_quote_expired", retryWithSameIdempotencyKey: false });
  const shown = render(view());
  await waitFor(() => expect(record.step).toBe("workspace"));
  shown.rerender(view());
  fireEvent.click(screen.getByRole("button", { name: "Prepare setup workspace" }));
  await screen.findByTestId("organization-setup-confirm");
  fireEvent.click(screen.getByRole("button", { name: "Create setup workspace" }));
  await screen.findByText("The price quote expired. Try again.");
  expect(record.workspace).toBeNull();
});

it("offers terminal only as an explicit choice: no agent, no prompt", async () => {
  vi.mocked(api.cloudWorkspaceCreate).mockImplementation(async () => creates());
  const shown = render(view());
  await waitFor(() => expect(record.step).toBe("workspace"));
  shown.rerender(view());
  fireEvent.click(screen.getByRole("button", { name: "Terminal only, no agent" }));
  const confirm = await screen.findByTestId("organization-setup-confirm");
  expect(confirm.textContent).toContain("No agent is started");
  fireEvent.click(screen.getByRole("button", { name: "Create setup workspace" }));
  await waitFor(() => expect(record.workspace?.id).toBe("ws-1"));
  expect(vi.mocked(api.cloudWorkspaceCreate).mock.calls[0]![0].launch?.prompt).toBeNull();
  expect(record.agent).toBe("terminal-only");
});

it("completes once the workspace is healthy and its agent took the prompt, and lets a stuck agent step finish terminal-only", async () => {
  record = { ...record, step: "runtime", workspace: { pending: null, id: "ws-1" } };
  const item = (launch: Record<string, unknown>) => ({ workspaces: [{ workspace: { id: "ws-1", state: "ready", runtimeActivity: { online: true }, launch }, latestOperation: null }] });
  vi.mocked(api.cloudWorkspaces).mockResolvedValue(item({ category: "agent-start-failed", sessionId: null }) as never);
  const shown = render(view());
  await waitFor(() => expect(record.step).toBe("agent"));
  shown.rerender(view());
  expect(screen.getByText("The agent could not be started.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Finish without an agent (terminal only)" }));
  expect([record.step, record.agent]).toEqual(["done", "terminal-only"]);
  expect(record.completedAt).not.toBeNull();
  shown.rerender(view());
  expect(screen.getByTestId("organization-setup-done").textContent).toContain("terminal only");
});
