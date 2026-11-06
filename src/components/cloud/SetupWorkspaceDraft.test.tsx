import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CloudWorkspaceLaunch } from "@/lib/api";
import { ENVIRONMENT_CHECK_PROMPT, forgetOtherSetups, loadSetups, newSetup, saveSetup } from "@/lib/organizationSetup";
import { sendToCloudAgent } from "@/lib/cloudAgents";
import { selectCloudSession } from "@/lib/sessions";
import { SetupWorkspaceDraft } from "./SetupWorkspaceDraft";

const account = vi.hoisted(() => ({ status: { state: "signed-in", context: { account: "account", revision: "1" }, identity: { email: "admin@example.com" }, organizations: [{ id: "org", role: "owner" }] }, listeners: new Set<() => void>() }));
vi.mock("@/lib/account", () => ({ useAccount: () => account, getAccount: () => account, subscribeAccount: (listener: () => void) => { account.listeners.add(listener); return () => account.listeners.delete(listener); } }));
vi.mock("@/lib/cloudAgents", () => ({ sendToCloudAgent: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ selectCloudSession: vi.fn(), getSessionStore: () => ({ navigationVersion: 1 }) }));
const client = { createAgentTab: vi.fn() } as unknown as WorkspaceRpcClient;
// This is the real launch response contract: runtime created a tab in the selected nested checkout.
const launch = { tabId: "launch-tab", sessionId: "launch-session", hasPrompt: false } as CloudWorkspaceLaunch;
const deferred = () => { let resolve!: (value: never) => void; const promise = new Promise<never>((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  account.status = { state: "signed-in", context: { account: "account", revision: "1" }, identity: { email: "admin@example.com" }, organizations: [{ id: "org", role: "owner" }] };
  saveSetup("admin@example.com", { ...newSetup("Team", "key"), organizationId: "org", workspace: { id: "ws", pending: null }, draft: { text: ENVIRONMENT_CHECK_PROMPT, agent: "codex" } });
  vi.mocked(sendToCloudAgent).mockResolvedValue({ clientCommandId: "command" } as never);
});
afterEach(cleanup);
const mount = (ready = true, target: CloudWorkspaceLaunch | null = launch) => render(<SetupWorkspaceDraft orgId="org" workspaceId="ws" client={client} launch={target} ready={ready} />);
it("keeps the edited draft unsent, then uses and selects the repository-scoped setup launch without creating another tab", async () => {
  mount(); expect((screen.getByLabelText("Environment-check draft") as HTMLTextAreaElement).value).toBe(ENVIRONMENT_CHECK_PROMPT);
  expect(sendToCloudAgent).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Environment-check draft"), { target: { value: "Check Node only" } });
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(sendToCloudAgent).toHaveBeenCalledWith({ organizationId: "org", workspaceId: "ws" }, "launch-tab", "Check Node only", client));
  expect(client.createAgentTab).not.toHaveBeenCalled();
  expect(selectCloudSession).toHaveBeenCalledWith("cloud:org:ws:launch-session");
  await waitFor(() => expect(screen.queryByLabelText("Setup workspace draft")).toBeNull());
});
it("shows the coach once and preserves the draft across reopening", () => {
  const view = mount(); fireEvent.click(screen.getByText("Got it")); view.unmount(); mount();
  expect(screen.queryByText(/Edit this draft/)).toBeNull();
});
it.each([false, true])("waits for the existing launch tab, including while connected=%s", (ready) => {
  mount(ready, null); fireEvent.click(screen.getByText("Send")); expect(sendToCloudAgent).not.toHaveBeenCalled(); expect(client.createAgentTab).not.toHaveBeenCalled();
});
it("reopening during a send attaches to the one operation and cannot duplicate it", async () => {
  const held = deferred(); vi.mocked(sendToCloudAgent).mockReturnValue(held.promise);
  const view = mount(); fireEvent.click(screen.getByText("Send")); await waitFor(() => expect(sendToCloudAgent).toHaveBeenCalledOnce());
  view.unmount(); mount(); fireEvent.click(screen.getByText("Send")); expect(sendToCloudAgent).toHaveBeenCalledOnce();
  await act(async () => held.resolve({ clientCommandId: "command" } as never));
  expect(screen.queryByLabelText("Setup workspace draft")).toBeNull();
});
it("does not retry an uncertain send after a remount", async () => {
  vi.mocked(sendToCloudAgent).mockRejectedValueOnce(new Error("Offline")); const view = mount(); fireEvent.click(screen.getByText("Send"));
  await screen.findByRole("alert"); view.unmount(); mount(); fireEvent.click(screen.getByText("Send"));
  expect(sendToCloudAgent).toHaveBeenCalledOnce(); expect(loadSetups("admin@example.com")[0].draft?.sending).toBe(true);
});
it.each(["signout", "account", "profile", "role"])("fences a late send after %s and never resurrects cleared data", async (change) => {
  const held = deferred(); vi.mocked(sendToCloudAgent).mockReturnValue(held.promise);
  const view = mount(); fireEvent.click(screen.getByText("Send")); await waitFor(() => expect(sendToCloudAgent).toHaveBeenCalledOnce()); view.unmount();
  if (change === "signout") account.status.state = "signed-out";
  if (change === "account") account.status.context.account = "other";
  if (change === "profile") account.status.context.revision = "2";
  if (change === "role") account.status.organizations[0].role = "member";
  for (const listener of account.listeners) listener();
  if (change === "signout") forgetOtherSetups(null);
  await act(async () => held.resolve({ clientCommandId: "old-command" } as never));
  if (change === "signout") expect(loadSetups("admin@example.com")).toEqual([]);
  else expect(loadSetups("admin@example.com")[0].draft?.sent).toBeUndefined();
  expect(selectCloudSession).not.toHaveBeenCalled();
});

it.each(["cloud_agent_key_missing", "cloud_agent_command_too_large"])("restores an editable draft and visible error after definite refusal %s and reopening", async (code) => {
  vi.mocked(sendToCloudAgent).mockRejectedValueOnce(code);
  const view = mount(); fireEvent.click(screen.getByText("Send")); await screen.findByRole("alert");
  expect(selectCloudSession).not.toHaveBeenCalled(); view.unmount(); mount();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("Environment-check draft") as HTMLTextAreaElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Environment-check draft"), { target: { value: "Shorter draft" } });
  fireEvent.click(screen.getByText("Send")); await waitFor(() => expect(sendToCloudAgent).toHaveBeenCalledTimes(2));
});
it("a context change before enqueue leaves the original draft recoverable without a sending marker", async () => {
  const view = mount(); fireEvent.click(screen.getByText("Send"));
  account.status.context.revision = "2"; for (const listener of account.listeners) listener();
  await act(async () => {}); view.unmount(); mount();
  expect(sendToCloudAgent).not.toHaveBeenCalled();
  expect(loadSetups("admin@example.com")[0].draft?.sending).toBeUndefined();
  expect((screen.getByLabelText("Environment-check draft") as HTMLTextAreaElement).disabled).toBe(false);
});
