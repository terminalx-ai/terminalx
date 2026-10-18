import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type AgentLogin } from "@/lib/api";
import { takeAgentLoginsRequest, takeOrganizationRequest } from "@/lib/settingsLinks";
import { organizationGithubApp } from "@/lib/organizationGithubApp";
import { ENVIRONMENT_CHECK_PROMPT, newSetup, type OrganizationSetupRecord } from "@/lib/organizationSetup";
import { OrganizationSetupSteps } from "./OrganizationSetupSteps";

vi.mock("@/lib/api", () => ({
  api: {
    cloudProviders: vi.fn(),
    cloudWorkspaces: vi.fn(),
    cloudWorkspaceSetup: vi.fn(),
    cloudWorkspaceQuote: vi.fn(),
    cloudWorkspaceCreate: vi.fn(),
    cloudWorkspacePreflight: vi.fn(),
    cloudAgentLogins: vi.fn(),
    cloudAgentLoginConnect: vi.fn(),
    cloudAgentCodexLoginCancel: vi.fn(),
  },
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
let stored: AgentLogin[];
const history: OrganizationSetupRecord[] = [];
const view = () => (
  <OrganizationSetupSteps
    record={record}
    organizationId="org-1"
    organizationName="Team"
    contextRevision="rev-1"
    onRecord={(next) => {
      record = next;
      history.push(next);
    }}
  />
);

beforeEach(() => {
  vi.resetAllMocks();
  history.length = 0;
  // Past the agent logins step unless a test is about it (PRO-107).
  record = { ...newSetup("Team", "request-1", 1), organizationId: "org-1", step: "compute", logins: "connected" };
  stored = [{ provider: "claude", authKind: "api-key", fingerprint: "sha256:ab", version: 1, updatedAt: 1, state: "connected" }];
  vi.mocked(api.cloudAgentLogins).mockImplementation(async () => ({ credentials: structuredClone(stored) }));
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
  // GitHub is on the organization's page (PRO-107), not in the setup's own section.
  const step = screen.getByTestId("organization-setup-repository");
  expect(step.textContent).toContain("on Team's page in Settings → Organizations, under GitHub");
  fireEvent.click(within(step).getByRole("button", { name: "Open Team's GitHub settings" }));
  expect(takeOrganizationRequest()).toBe("org-1");
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

it("does not offer to resend a create request older than a day (the server no longer replays it)", async () => {
  const stale = { idempotencyKey: "k", createdAt: Date.now() - 25 * 60 * 60 * 1000, request: { name: "Setup check" } as never };
  record = { ...record, step: "workspace", workspace: { pending: stale, id: null } };
  const shown = render(view());
  await waitFor(() => expect(record.workspace).toBeNull());
  shown.rerender(view());
  expect(screen.queryByRole("button", { name: "Resume creating the setup workspace" })).toBeNull();
  expect(screen.getByRole("button", { name: "Prepare setup workspace" })).toBeTruthy();
  expect(api.cloudWorkspaceCreate).not.toHaveBeenCalled();
});

it("offers no new setup workspace while an expired request is unsettled because the list cannot be read", async () => {
  const stale = { idempotencyKey: "k", createdAt: Date.now() - 25 * 60 * 60 * 1000, request: { name: "Setup check" } as never };
  record = { ...record, step: "workspace", workspace: { pending: stale, id: null } };
  vi.mocked(api.cloudWorkspaces).mockRejectedValue(new Error("offline"));
  const shown = render(view());
  await screen.findByTestId("organization-setup-unsettled");
  await waitFor(() => expect(api.cloudWorkspaces).toHaveBeenCalled());
  shown.rerender(view());
  expect(screen.queryByRole("button", { name: "Prepare setup workspace" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Terminal only, no agent" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Resume creating the setup workspace" })).toBeNull();
  // The old request is kept, not dropped on a guess.
  expect(record.workspace).toEqual({ pending: stale, id: null });

  // The list loads and has the workspace that request made: it is adopted, and nothing is created.
  vi.mocked(api.cloudWorkspaces).mockResolvedValue({ workspaces: [{ workspace: { id: "ws-made", name: "Setup check", createdAt: stale.createdAt + 1000, state: "provisioning" }, latestOperation: null }] } as never);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(record.workspace).toEqual({ pending: null, id: "ws-made" }));
  expect(api.cloudWorkspaceCreate).not.toHaveBeenCalled();
  expect(api.cloudWorkspaceQuote).not.toHaveBeenCalled();
});

it("runs the create preflight before quoting, and a missing agent login stops it there (PRO-78)", async () => {
  vi.mocked(api.cloudWorkspacePreflight).mockResolvedValue({
    ready: false,
    checks: [{ kind: "agent-credential", cloneUrl: null, agent: "claude", status: "failed", errorCode: "cloud_workspace_agent_credential_required", retryable: false }],
  });
  const shown = render(view());
  await waitFor(() => expect(record.step).toBe("workspace"));
  shown.rerender(view());
  fireEvent.click(screen.getByRole("button", { name: "Prepare setup workspace" }));
  await screen.findByText(/Claude Code has no working login for this organization/);
  expect(api.cloudWorkspacePreflight).toHaveBeenCalledWith([{ cloneUrl: "https://github.com/acme/app.git", ref: null }], null, "claude");
  expect(api.cloudWorkspaceQuote).not.toHaveBeenCalled();
  expect(screen.queryByTestId("organization-setup-confirm")).toBeNull();

  // Terminal only asks for no agent login: the repository is still checked.
  vi.mocked(api.cloudWorkspacePreflight).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Terminal only, no agent" }));
  await screen.findByTestId("organization-setup-confirm");
  expect(api.cloudWorkspacePreflight).toHaveBeenCalledWith([{ cloneUrl: "https://github.com/acme/app.git", ref: null }], null, null);
});

// PRO-107: an organization's agent logins are set right after its cloud is chosen, or later.
describe("the agent logins step", () => {
  const key = (agent: string) => {
    const row = screen.getAllByTestId("agent-login").find((item) => item.dataset.agent === agent)!;
    fireEvent.click(within(row).getByRole("button", { name: "Connect with an API key" }));
    const panel = within(row).getByTestId("agent-login-consent");
    within(panel).getAllByRole("checkbox").forEach((box) => fireEvent.click(box));
    fireEvent.click(within(panel).getByRole("button", { name: "Enter the key" }));
  };

  beforeEach(() => {
    record = { ...record, logins: undefined };
    stored = [];
  });

  it("comes right after the compute connection, and goes on once a login is connected", async () => {
    vi.mocked(api.cloudAgentLoginConnect).mockImplementation(async (provider) => {
      stored = [{ provider, authKind: "api-key", fingerprint: "sha256:cd", version: 1, updatedAt: 2, state: "connected" }];
      return stored[0]!;
    });
    const shown = render(view());
    await waitFor(() => expect(record.step).toBe("logins"));
    shown.rerender(view());
    const step = screen.getByTestId("organization-setup-logins");
    expect(step.textContent).toContain("Claude Code (Log in with Claude or an API key), Codex (Log in with ChatGPT or an API key) or Cursor (an API key), or lend this Mac's sign-in");
    expect(screen.getByTestId("agent-logins-title").textContent).toBe("Agent logins for Team");
    // Every way to connect each agent is offered here, as on the organization's page.
    await screen.findAllByTestId("agent-login");
    expect(screen.getByRole("button", { name: "Log in with Claude" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log in with ChatGPT" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lend this Mac's Codex sign-in (temporary)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);

    key("codex");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    expect(api.cloudAgentLoginConnect).toHaveBeenCalledWith("codex", "api-key", expect.objectContaining({ organizationId: "org-1", contextRevision: "rev-1" }));
    // Connecting does not leave the step by itself: another agent can be connected too.
    expect(record.step).toBe("logins");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect([record.logins, record.step]).toEqual(["connected", "workspace"]);
  });

  it("stays on the step after a failed connect, and goes on after a retry", async () => {
    vi.mocked(api.cloudAgentLoginConnect)
      .mockRejectedValueOnce({ code: "cloud_workspace_credential_invalid" })
      .mockImplementationOnce(async (provider) => {
        stored = [{ provider, authKind: "api-key", fingerprint: "sha256:cd", version: 1, updatedAt: 2, state: "connected" }];
        return stored[0]!;
      });
    const shown = render(view());
    await waitFor(() => expect(record.step).toBe("logins"));
    shown.rerender(view());
    await screen.findAllByTestId("agent-login");
    key("claude");
    expect((await screen.findByRole("alert")).textContent).toBe("The provider did not accept that login. Nothing was changed.");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(record.step).toBe("logins");

    await waitFor(() => expect(screen.getAllByTestId("agent-login").find((item) => item.dataset.agent === "claude")!.querySelector("button")!.hasAttribute("disabled")).toBe(false));
    key("claude");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(record.step).toBe("workspace");
  });

  it("can be set up later, and then says which agents have no login, with the way to the organization's page", async () => {
    const shown = render(view());
    await waitFor(() => expect(record.step).toBe("logins"));
    shown.rerender(view());
    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
    expect([record.logins, record.step]).toEqual(["later", "workspace"]);
    expect(api.cloudAgentLoginConnect).not.toHaveBeenCalled();
    shown.rerender(view());
    const missing = screen.getByTestId("organization-setup-missing-logins");
    expect(missing.textContent).toContain("No agent login yet for Claude Code, Codex and Cursor in Team");
    fireEvent.click(within(missing).getByRole("button", { name: "Open Team's agent logins" }));
    expect(takeOrganizationRequest()).toBe("org-1");
    expect(takeAgentLoginsRequest("org-1")).toBe(true);
  });

  it("says nothing about other agents once setup went on with a login, or finished before the step", async () => {
    for (const logins of ["connected", undefined] as const) {
      record = { ...record, step: "done", completedAt: 5, logins, workspace: { pending: null, id: "ws-1" } };
      stored = [{ provider: "claude", authKind: "api-key", fingerprint: "sha256:ab", version: 1, updatedAt: 1, state: "connected" }];
      render(view());
      await waitFor(() => expect(api.cloudAgentLogins).toHaveBeenCalled());
      // The list has answered and been read.
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(screen.getByTestId("organization-setup-done")).toBeTruthy();
      expect(screen.queryByTestId("organization-setup-missing-logins")).toBeNull();
      cleanup();
      vi.mocked(api.cloudAgentLogins).mockClear();
    }
  });

  it("names the agents still without a login at setup completion", async () => {
    record = { ...record, step: "done", completedAt: 5, logins: "later", agent: "terminal-only", workspace: { pending: null, id: "ws-1" } };
    stored = [{ provider: "claude", authKind: "api-key", fingerprint: "sha256:ab", version: 1, updatedAt: 1, state: "connected" }];
    render(view());
    expect((await screen.findByTestId("organization-setup-missing-logins")).textContent).toContain("No agent login yet for Codex and Cursor in Team");
    expect(screen.getByTestId("organization-setup-done").textContent).toContain("Cloud setup is complete");
  });
});
