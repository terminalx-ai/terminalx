import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type AccountStatus, type AgentLogin } from "@/lib/api";

vi.mock("@/lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/platform")>()), hasSecureDialog: true }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => undefined) }));
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyText } from "@/lib/clipboard";
import { agentLoginStatus, OrganizationAgentLogins } from "./OrganizationAgentLogins";
import { bedrockModelId } from "./BedrockLoginDialog";

const account = vi.hoisted(() => ({ status: {} as AccountStatus }));
vi.mock("@/lib/account", () => ({ useAccount: () => account, getAccount: () => account }));
vi.mock("@/lib/cloudCatalog", () => ({ refreshCloudCatalog: vi.fn(async () => undefined) }));
vi.mock("@/lib/api", () => ({
  api: {
    cloudAgentLogins: vi.fn(),
    cloudAgentBedrockConnect: vi.fn(),
    cloudAgentLoginConnect: vi.fn(),
    cloudAgentLoginRemove: vi.fn(),
    cloudAgentLoginAffectedWorkspaces: vi.fn(),
    cloudWorkspacePreflight: vi.fn(),
  },
}));

const BEDROCK = "cloud.agent-logins.bedrock.v1";
let stored: AgentLogin[];
const login = (fields: Partial<AgentLogin>): AgentLogin => ({ provider: "claude", authKind: "api-key", fingerprint: "sha256:ab", version: 1, updatedAt: 1_790_000_000_000, state: "connected", sharedUse: "organization", ...fields });
const claudeRow = () => screen.getAllByTestId("agent-login").find((item) => item.dataset.agent === "claude")!;
const show = async (ready = true) => {
  account.status = { state: "signed-in", context: { revision: "rev" }, phase2Readiness: ready ? { "org-1": [BEDROCK] } : {} } as unknown as AccountStatus;
  render(<OrganizationAgentLogins contextRevision="rev" organizationId="org-1" organizationName="Acme Robotics" />);
  await screen.findAllByTestId("agent-login");
};

beforeEach(() => {
  vi.clearAllMocks();
  stored = [];
  vi.mocked(api.cloudAgentLogins).mockImplementation(async () => ({ credentials: structuredClone(stored) }));
});
afterEach(cleanup);

describe("Amazon Bedrock for Claude Code (PRO-200)", () => {
  it("is offered only where the organization's readiness key is on, and only for Claude Code", async () => {
    await show(false);
    expect(screen.queryByTestId("agent-login-bedrock")).toBeNull();
    cleanup();
    await show(true);
    expect(within(claudeRow()).getByTestId("agent-login-bedrock").textContent).toBe("Amazon Bedrock");
    expect(screen.getAllByTestId("agent-login-bedrock")).toHaveLength(1);
  });

  it("tests and saves with the page's settings only, the secret left to the app's secure dialog", async () => {
    vi.mocked(api.cloudAgentBedrockConnect).mockImplementation(async () => {
      stored = [login({ authKind: "bedrock", displayIdentity: "eu-central-1 · eu.anthropic.claude-opus-5-5" })];
      return stored[0]!;
    });
    await show();
    fireEvent.click(within(claudeRow()).getByTestId("agent-login-bedrock"));
    const dialog = await screen.findByTestId("bedrock-login");
    expect(within(dialog).getByText("Amazon Bedrock for Claude Code")).toBeTruthy();
    expect(within(dialog).getByText(/For everyone in Acme Robotics · takes precedence over members’ own Claude Code logins/)).toBeTruthy();
    expect(within(dialog).getByTestId("bedrock-secret").textContent).toMatch(/secure window/);
    expect(dialog.querySelectorAll("input[type=password]")).toHaveLength(0);
    const save = within(dialog).getByTestId("bedrock-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByTestId("bedrock-access-key-id"), { target: { value: "akiafakefakefake0000" } });
    fireEvent.change(within(dialog).getByTestId("bedrock-region"), { target: { value: "eu-central-1" } });
    expect(within(dialog).getByTestId("bedrock-model-note").textContent).toMatch(/eu\.anthropic\.claude-opus-5-5 · TerminalX sends it one short test message/);
    expect(save.textContent).toBe("Test and save");
    fireEvent.click(save);
    await waitFor(() => expect(api.cloudAgentBedrockConnect).toHaveBeenCalledWith(
      { auth: "aws-keys", region: "eu-central-1", model: "eu.anthropic.claude-opus-5-5", accessKeyId: "AKIAFAKEFAKEFAKE0000" },
      { contextRevision: "rev", organizationSharing: true, machineInstallation: true, replaceExisting: false, organizationId: "org-1" },
    ));
    await waitFor(() => expect(screen.queryByTestId("bedrock-login")).toBeNull());
    expect(within(claudeRow()).getByTestId("agent-login-status").textContent).toMatch(/^Connected · Amazon Bedrock · eu-central-1 · eu\.anthropic\.claude-opus-5-5/);
  });

  it("shows Bedrock's own error when it refuses the test call, and nothing is saved", async () => {
    vi.mocked(api.cloudAgentBedrockConnect).mockRejectedValue({
      code: "cloud_agent_bedrock_test_failed",
      bedrock: { status: 403, type: "AccessDeniedException", message: "You don't have access to the model with the specified model ID." },
    });
    await show();
    fireEvent.click(within(claudeRow()).getByTestId("agent-login-bedrock"));
    const dialog = await screen.findByTestId("bedrock-login");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Bedrock API key" }));
    fireEvent.change(within(dialog).getByTestId("bedrock-region"), { target: { value: "eu-central-1" } });
    fireEvent.click(within(dialog).getByTestId("bedrock-save"));
    const failed = await within(dialog).findByTestId("bedrock-test-failed");
    expect(api.cloudAgentBedrockConnect).toHaveBeenCalledWith({ auth: "api-key", region: "eu-central-1", model: "eu.anthropic.claude-opus-5-5" }, expect.anything());
    expect(vi.mocked(api.cloudAgentBedrockConnect).mock.calls[0]![0]).not.toHaveProperty("accessKeyId");
    expect(failed.textContent).toMatch(/Test failed · nothing was saved/);
    expect(failed.textContent).toMatch(/AccessDeniedException: You don't have access to the model with the specified model ID\./);
    expect(failed.textContent).toMatch(/Turn on access to Claude Opus 5\.5 in eu-central-1 under Bedrock › Model access/);
    expect(within(dialog).getByTestId("bedrock-model-note").textContent).toMatch(/Bedrock refused the test call with this model/);
    expect(within(dialog).getByTestId("bedrock-save").textContent).toBe("Test again");
    fireEvent.click(within(failed).getByText("Copy error"));
    expect(copyText).toHaveBeenCalledWith("AccessDeniedException: You don't have access to the model with the specified model ID.");
    fireEvent.click(within(failed).getByText("Open AWS console"));
    expect(openUrl).toHaveBeenCalledWith("https://eu-central-1.console.aws.amazon.com/bedrock/home?region=eu-central-1#/modelaccess");
  });

  it("disconnects with its own confirmation", async () => {
    stored = [login({ authKind: "bedrock", displayIdentity: "us-east-1 · us.anthropic.claude-sonnet-5-5" })];
    vi.mocked(api.cloudAgentLoginRemove).mockImplementation(async () => { stored = []; });
    await show();
    expect(within(claudeRow()).getByTestId("agent-login-bedrock").textContent).toBe("Change Amazon Bedrock");
    fireEvent.click(within(claudeRow()).getByText("Disconnect"));
    const confirm = await screen.findByTestId("bedrock-disconnect");
    expect(within(confirm).getByText("Disconnect Amazon Bedrock?")).toBeTruthy();
    expect(confirm.textContent).toMatch(/Claude Code there goes back to each member’s own login\. The AWS key is deleted from Acme Robotics\./);
    fireEvent.click(within(confirm).getByText("Disconnect Bedrock"));
    await waitFor(() => expect(api.cloudAgentLoginRemove).toHaveBeenCalledWith("claude", "rev", "org-1"));
  });

  it("names the inference profile for the region's geography", () => {
    expect(bedrockModelId("us-west-2", "claude-haiku-5-5")).toBe("us.anthropic.claude-haiku-5-5");
    expect(bedrockModelId("eu-north-1", "claude-opus-5-5")).toBe("eu.anthropic.claude-opus-5-5");
    expect(bedrockModelId("ap-northeast-1", "claude-sonnet-5-5")).toBe("apac.anthropic.claude-sonnet-5-5");
    expect(agentLoginStatus(login({ authKind: "bedrock", state: "revoked" })).text).toMatch(/^Revoked \(Amazon Bedrock\)/);
  });
});
