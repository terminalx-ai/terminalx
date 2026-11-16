import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { createWorkspace } from "@/lib/cloudCreate";
import { newSetup, type OrganizationSetupRecord } from "@/lib/organizationSetup";
import { selectCloudWorkspace } from "@/lib/sessions";
import { startSetupCheckDraft } from "@/lib/setupCheckDraft";
import { FinishActions } from "./FinishActions";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      cloudProviders: vi.fn(),
      cloudAgentLogins: vi.fn(),
      cloudWorkspaceSetup: vi.fn(),
      cloudWorkspaceQuote: vi.fn(),
      cloudWorkspaces: vi.fn(),
      cloudWorkspacePreflight: vi.fn(),
    },
  };
});
vi.mock("@/lib/cloudCreate", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/cloudCreate")>()), preflightCreate: vi.fn().mockResolvedValue(undefined), createWorkspace: vi.fn() }));
vi.mock("@/lib/organizationGithubApp", () => ({
  organizationGithubApp: { summary: vi.fn().mockResolvedValue({ repositories: [{ fullName: "acme/app", state: "accessible", cloneUrl: "https://github.com/acme/app.git" }] }) },
}));
vi.mock("@/lib/sessions", () => ({ selectCloudWorkspace: vi.fn() }));
vi.mock("@/lib/setupCheckDraft", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/setupCheckDraft")>()), startSetupCheckDraft: vi.fn() }));
vi.mock("@/components/settings/OrganizationAgentLogins", () => ({ agentLoginUsable: () => true }));

const organization = { id: "org-1", name: "Team", role: "owner" };
const record: OrganizationSetupRecord = { ...newSetup("Team", "request-1"), organizationId: "org-1", step: "workspace", flow: { step: "invite", passed: [], finishedAt: null } };
const defaults = { sourceId: "img", locationId: "fsn1", machineClassId: "cx32", idleSuspendMinutes: 30, retentionDays: 7, networkPolicy: "open" };

beforeEach(() => {
  vi.mocked(api.cloudProviders).mockResolvedValue({ providers: [{ id: "hetzner", displayName: "Hetzner Cloud", availability: "available", canManage: true, connection: { state: "connected" } }] } as never);
  vi.mocked(api.cloudAgentLogins).mockResolvedValue({ credentials: [{ provider: "codex" }] } as never);
  vi.mocked(api.cloudWorkspaceSetup).mockResolvedValue({ sources: [{ id: "img" }], locations: [{ id: "fsn1" }], machineClasses: [{ id: "cx32" }], defaults } as never);
  vi.mocked(api.cloudWorkspaceQuote).mockResolvedValue({ id: "quote-1", activeHourlyMicros: 12300, currency: "EUR", configuration: { machineClassLabel: "CX32", locationLabel: "fsn1" } } as never);
  vi.mocked(createWorkspace).mockImplementation(async (_api, _form, options) => {
    const made = { workspace: { id: "ws-1" } } as never;
    options?.onCreated?.(made, undefined as never);
    return made;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("finishing the cloud setup", () => {
  it("creates the setup check once, keeps its id with the finish, and opens it with the check message waiting", async () => {
    const onRecord = vi.fn();
    const onDone = vi.fn();
    render(<FinishActions organization={organization} record={record} onRecord={onRecord} accountEmail="ada@example.com" contextRevision="r1" onContinue={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /Finish and open the setup check/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Create and open/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(createWorkspace).toHaveBeenCalledOnce();
    expect(vi.mocked(createWorkspace).mock.calls[0]![1]).toMatchObject({ name: "Setup check", prompt: "", agent: "codex", repositories: [{ fullName: "acme/app" }] });
    // The last record stored has both the workspace and the finish: the earlier write is not lost.
    expect(onRecord.mock.calls.at(-1)![0]).toMatchObject({ workspace: { id: "ws-1", pending: null }, flow: { finishedAt: expect.any(Number) } });
    expect(startSetupCheckDraft).toHaveBeenCalledWith("org-1", "ws-1", expect.stringContaining("in app"));
    expect(selectCloudWorkspace).toHaveBeenCalledWith("cloud:org-1:ws-1");
  });

  it("opens the setup check made earlier instead of making a second one", async () => {
    vi.mocked(api.cloudWorkspaces).mockResolvedValue({ workspaces: [{ workspace: { id: "ws-1", state: "ready" } }] } as never);
    const onDone = vi.fn();
    render(<FinishActions organization={organization} record={{ ...record, workspace: { pending: null, id: "ws-1" } }} onRecord={vi.fn()} accountEmail="ada@example.com" contextRevision="r1" onContinue={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /Finish and open the setup check/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(selectCloudWorkspace).toHaveBeenCalledWith("cloud:org-1:ws-1");
  });
});
