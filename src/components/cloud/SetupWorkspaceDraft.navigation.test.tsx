import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CloudWorkspaceLaunch } from "@/lib/api";
import { newSetup, saveSetup, loadSetups } from "@/lib/organizationSetup";
import { getSessionStore, useSessionStore, openIssues, openHome, openAgents, selectCloudWorkspace } from "@/lib/sessions";
import { sendToCloudAgent } from "@/lib/cloudAgents";
import { SetupWorkspaceDraft } from "./SetupWorkspaceDraft";

vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-in", identity: { email: "admin@example.com" }, context: { account: "account", revision: "1" }, organizations: [{ id: "org", role: "owner" }] } };
  return { useAccount: () => account, getAccount: () => account, subscribeAccount: () => () => {} };
});
vi.mock("@/lib/cloudAgents", async (original) => ({ ...(await original<typeof import("@/lib/cloudAgents")>()), sendToCloudAgent: vi.fn() }));
const launch = { tabId: "tab", sessionId: "session", hasPrompt: false } as CloudWorkspaceLaunch;
const client = {} as WorkspaceRpcClient;
function View() {
  const store = useSessionStore();
  const [settings, setSettings] = useState(false);
  return <>
    <button onClick={openIssues}>Issues</button><button onClick={openHome}>Home</button><button onClick={openAgents}>Agents</button>
    <button onClick={() => selectCloudWorkspace("cloud:org:other")}>Other computer</button><button onClick={() => setSettings(true)}>Settings</button>
    {!settings && store.selectedCloudWorkspace === "cloud:org:ws" && <SetupWorkspaceDraft orgId="org" workspaceId="ws" client={client} launch={launch} ready />}
    {settings && <h1>Settings page</h1>}
  </>;
}
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); selectCloudWorkspace("cloud:org:ws");
  saveSetup("admin@example.com", { ...newSetup("Team", "navigation"), organizationId: "org", workspace: { id: "ws", pending: null }, draft: { text: "Check environment", agent: "codex" } });
});
afterEach(cleanup);
it.each(["Issues", "Home", "Agents", "Other computer", "Settings"])("a late successful receipt preserves %s using the real navigation store", async (destination) => {
  let finish!: (value: never) => void;
  vi.mocked(sendToCloudAgent).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<View />); fireEvent.click(screen.getByText("Send")); await waitFor(() => expect(sendToCloudAgent).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText(destination)); expect(screen.queryByLabelText("Setup workspace draft")).toBeNull();
  const selected = getSessionStore();
  await act(async () => finish({ clientCommandId: "command" } as never));
  expect(getSessionStore()).toBe(selected);
  expect(loadSetups("admin@example.com")[0].draft?.sent).toBe(true);
  if (destination === "Settings") expect(screen.getByText("Settings page")).toBeTruthy();
});
