import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { ENVIRONMENT_CHECK_PROMPT, loadSetups, newSetup, saveSetup } from "@/lib/organizationSetup";
import { createCloudAgentTab, sendToCloudAgent } from "@/lib/cloudAgents";
import { SetupWorkspaceDraft } from "./SetupWorkspaceDraft";

vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: { identity: { email: "admin@example.com" }, organizations: [{ id: "org", role: "owner" }] } }) }));
vi.mock("@/lib/cloudAgents", () => ({ createCloudAgentTab: vi.fn(), sendToCloudAgent: vi.fn() }));
const client = {} as WorkspaceRpcClient;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  saveSetup("admin@example.com", { ...newSetup("Team", "key"), organizationId: "org", workspace: { id: "ws", pending: null }, draft: { text: ENVIRONMENT_CHECK_PROMPT, agent: "codex" } });
  vi.mocked(createCloudAgentTab).mockResolvedValue("tab"); vi.mocked(sendToCloudAgent).mockResolvedValue({} as never);
});
afterEach(cleanup);
const mount = (ready = true) => render(<SetupWorkspaceDraft orgId="org" workspaceId="ws" client={client} ready={ready} />);
it("keeps the prefilled draft unsent until Send, and sends the edited text", async () => {
  mount(); expect((screen.getByLabelText("Environment-check draft") as HTMLTextAreaElement).value).toBe(ENVIRONMENT_CHECK_PROMPT);
  expect(createCloudAgentTab).not.toHaveBeenCalled(); expect(sendToCloudAgent).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Environment-check draft"), { target: { value: "Check Node only" } });
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(sendToCloudAgent).toHaveBeenCalledWith({ organizationId: "org", workspaceId: "ws" }, "tab", "Check Node only", client));
  await waitFor(() => expect(screen.queryByLabelText("Setup workspace draft")).toBeNull());
});
it("shows the coach once and preserves the draft across reopening", () => {
  const view = mount(); fireEvent.click(screen.getByText("Got it")); view.unmount(); mount();
  expect(screen.queryByText(/Edit this draft/)).toBeNull();
  expect(screen.getByLabelText("Environment-check draft")).toBeTruthy();
});
it("does not start an agent while the workspace is connecting", () => {
  mount(false); fireEvent.click(screen.getByText("Send")); expect(createCloudAgentTab).not.toHaveBeenCalled();
});
it("reuses the created agent after a failed send and retains the editable draft", async () => {
  vi.mocked(sendToCloudAgent).mockRejectedValueOnce(new Error("Offline")); mount(); fireEvent.click(screen.getByText("Send"));
  await screen.findByText("Offline"); expect(loadSetups("admin@example.com")[0].draft?.tabId).toBe("tab");
  fireEvent.click(screen.getByText("Send")); await waitFor(() => expect(sendToCloudAgent).toHaveBeenCalledTimes(2));
  expect(createCloudAgentTab).toHaveBeenCalledOnce();
});
