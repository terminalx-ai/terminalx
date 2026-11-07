import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type AgentRoute, type AgentRoutes, type AgentRouteTemplate } from "@/lib/api";
import { OrganizationAgentRoutes } from "./OrganizationAgentRoutes";

vi.mock("@/lib/api", () => ({
  api: {
    cloudAgentRoutes: vi.fn(),
    cloudAgentRouteSave: vi.fn(),
    cloudAgentRouteRemove: vi.fn(),
  },
}));

const templates: AgentRouteTemplate[] = [
  {
    id: "claude-gateway",
    version: 1,
    provider: "claude",
    mode: "custom-endpoint",
    label: "LLM gateway (Anthropic Messages format)",
    description: "Your gateway.",
    fields: [
      { key: "baseUrl", kind: "url", required: true, label: "Base URL", help: "" },
      { key: "authScheme", kind: "choice", required: true, label: "Header", help: "", choices: [{ value: "bearer", label: "Bearer" }, { value: "x-api-key", label: "x-api-key" }], default: "bearer" },
      { key: "model", kind: "model", required: false, label: "Model", help: "" },
    ],
    credential: { label: "Gateway credential", help: "Stored encrypted." },
    capabilities: { modelList: "anthropic", modelPicker: true },
    docs: "",
  },
  {
    id: "claude-key-helper",
    version: 1,
    provider: "claude",
    mode: "user-managed",
    label: "Credential helper (user managed)",
    description: "A helper.",
    fields: [{ key: "helperPath", kind: "path", required: true, label: "Credential helper", help: "" }],
    credential: null,
    capabilities: { modelList: "anthropic", modelPicker: true },
    docs: "",
  },
  {
    id: "codex-provider",
    version: 1,
    provider: "codex",
    mode: "custom-endpoint",
    label: "Model provider",
    description: "A provider.",
    fields: [
      { key: "baseUrl", kind: "url", required: true, label: "Base URL", help: "" },
      { key: "model", kind: "model", required: true, label: "Model", help: "" },
    ],
    credential: { label: "Provider key", help: "" },
    capabilities: { modelList: "openai", modelPicker: false },
    docs: "",
  },
  { id: "claude-bedrock", version: 1, provider: "claude", mode: "custom-endpoint", label: "Amazon Bedrock", description: "AWS model access", fields: [
    { key: "region", kind: "region", required: true, label: "AWS region", help: "" },
    { key: "authScheme", kind: "choice", required: true, label: "AWS authentication", help: "", choices: [{ value: "bedrock-api-key", label: "Bedrock API key" }], default: "bedrock-api-key" },
    { key: "model", kind: "model", required: true, label: "Test model", help: "" },
  ], credential: { label: "AWS credentials", help: "One billable test request." }, capabilities: { modelList: "bedrock", modelPicker: false }, docs: "" },
];

let routes: AgentRoute[];
const view = (): AgentRoutes => ({ catalogVersion: 1, agents: ["claude", "codex", "cursor"], templates, routes: structuredClone(routes) });
const gatewayRoute = (fields: Partial<AgentRoute> = {}): AgentRoute => ({
  id: "route_1",
  provider: "claude",
  mode: "custom-endpoint",
  templateId: "claude-gateway",
  templateVersion: 1,
  templateCurrent: true,
  settings: { baseUrl: "https://llm.example.com", authScheme: "bearer", model: "gw-opus" },
  credentialStored: true,
  version: 3,
  updatedAt: 1,
  status: "not-checked",
  ...fields,
});

const row = (agent: string) => screen.getAllByTestId("agent-route").find((item) => item.dataset.agent === agent)!;
const show = async () => {
  render(<OrganizationAgentRoutes contextRevision="rev-1" organizationId="org-2" organizationName="Acme Robotics" />);
  await screen.findAllByTestId("agent-route");
};
const fill = (agent: string, key: string, value: string) =>
  fireEvent.change(within(row(agent)).getAllByTestId("agent-route-field").find((item) => item.dataset.field === key)!.querySelector("input")!, { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  routes = [];
  vi.mocked(api.cloudAgentRoutes).mockImplementation(async () => view());
});
afterEach(cleanup);

describe("your model access in Settings (PRO-18)", () => {
  it("lists each agent with the organization's login by default, and offers Cursor nothing it does not support", async () => {
    await show();
    expect(api.cloudAgentRoutes).toHaveBeenCalledWith("org-2");
    expect(screen.getByText("Your model access in Acme Robotics")).toBeTruthy();
    expect(screen.getByTestId("agent-routes").textContent).toMatch(/a\s+credential helper also runs for everyone who drives a workspace you share/);
    expect(screen.getByTestId("agent-routes").textContent).not.toMatch(/never .* run on it/);
    expect(within(row("claude")).getByTestId("agent-route-status").textContent).toBe("Organization login, managed by TerminalX.");
    expect(within(row("cursor")).getByTestId("agent-route-status").textContent).toMatch(/supports no custom endpoint or credential helper/);
    expect(within(row("cursor")).queryByRole("button")).toBeNull();
    expect(within(row("codex")).getByRole("button", { name: "Use your own endpoint or helper…" })).toBeTruthy();
  });

  it("saves a gateway with a credential asked for natively, and shows what this Mac's check found", async () => {
    await show();
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Use your own endpoint or helper…" }));
    // Only Claude Code's own templates.
    expect(within(row("claude")).getAllByTestId("agent-route-template").map((item) => item.dataset.template)).toEqual(["claude-gateway", "claude-key-helper", "claude-bedrock"]);
    const save = within(row("claude")).getByTestId("agent-route-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fill("claude", "baseUrl", "http://llm.example.com");
    expect(within(row("claude")).getByTestId("agent-route-field-problem").textContent).toMatch(/https/);
    expect(save.disabled).toBe(true);
    fill("claude", "baseUrl", "https://llm.example.com/anthropic/");
    fill("claude", "model", "gw-opus");
    expect(save.disabled).toBe(false);
    expect(save.textContent).toBe("Enter credential and save");
    vi.mocked(api.cloudAgentRouteSave).mockImplementation(async () => {
      routes = [gatewayRoute({ version: 1 })];
      return { saved: true, check: { outcome: "ok", httpStatus: 200, models: ["gw-opus", "gw-sonnet"] }, routes: view() };
    });
    fireEvent.click(save);
    await screen.findByTestId("agent-route-notice");
    expect(api.cloudAgentRouteSave).toHaveBeenCalledWith({
      organizationId: "org-2",
      contextRevision: "rev-1",
      agent: "claude",
      templateId: "claude-gateway",
      settings: { baseUrl: "https://llm.example.com/anthropic/", authScheme: "bearer", model: "gw-opus" },
      expectedVersion: 0,
      enterCredential: true,
      saveUnchecked: false,
    });
    expect(screen.getByTestId("agent-route-notice").textContent).toBe("Reached from this Mac with the credential. It lists gw-opus, gw-sonnet.");
    expect(within(row("claude")).getByTestId("agent-route-status").textContent).toBe("Saved · not checked from a workspace yet");
    expect(screen.queryByTestId("agent-route-edit")).toBeNull();
  });

  it("keeps the form and saves nothing when this Mac's check fails, unless asked to", async () => {
    await show();
    fireEvent.click(within(row("codex")).getByRole("button", { name: "Use your own endpoint or helper…" }));
    fill("codex", "baseUrl", "https://llm.example.com/v1");
    fill("codex", "model", "team-model");
    vi.mocked(api.cloudAgentRouteSave).mockResolvedValueOnce({ saved: false, check: { outcome: "failed", code: "unauthorized", httpStatus: 401 }, routes: null });
    fireEvent.click(within(row("codex")).getByTestId("agent-route-save"));
    await waitFor(() => expect(screen.getByTestId("agent-route-notice").textContent).toBe("Checked from this Mac: the endpoint refused the credential (401). Nothing was saved."));
    expect(screen.getByTestId("agent-route-edit")).toBeTruthy();
    fireEvent.click(within(row("codex")).getByRole("checkbox", { name: /Save even if this Mac's check fails/ }));
    vi.mocked(api.cloudAgentRouteSave).mockResolvedValueOnce({ saved: true, check: { outcome: "failed", code: "unreachable" }, routes: view() });
    fireEvent.click(within(row("codex")).getByTestId("agent-route-save"));
    await waitFor(() => expect(screen.queryByTestId("agent-route-edit")).toBeNull());
    expect(vi.mocked(api.cloudAgentRouteSave).mock.calls[1]![0]).toMatchObject({ agent: "codex", saveUnchecked: true, enterCredential: true });
    expect(screen.getByTestId("agent-route-notice").textContent).toBe("Checked from this Mac: the endpoint could not be reached. Saved anyway, as you chose.");
  });

  it("keeps the stored credential for a change on the same endpoint, and asks again for another one", async () => {
    routes = [gatewayRoute({ status: "failed", lastCheck: { workspaceId: "w", version: 3, checkedAt: 1, outcome: "failed", code: "model-unsupported", models: ["gw-sonnet"] } })];
    await show();
    expect(within(row("claude")).getByTestId("agent-route-status").textContent).toContain("the endpoint does not list the model gw-opus");
    expect(within(row("claude")).getByTestId("agent-route-models").textContent).toBe("Models the endpoint lists: gw-sonnet");
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Change…" }));
    fill("claude", "model", "gw-sonnet");
    expect(within(row("claude")).getByTestId("agent-route-save").textContent).toBe("Save");
    vi.mocked(api.cloudAgentRouteSave).mockResolvedValue({ saved: true, check: null, routes: view() });
    fireEvent.click(within(row("claude")).getByTestId("agent-route-save"));
    await waitFor(() => expect(api.cloudAgentRouteSave).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.cloudAgentRouteSave).mock.calls[0]![0]).toMatchObject({ expectedVersion: 3, enterCredential: false, settings: { model: "gw-sonnet" } });

    fireEvent.click(within(row("claude")).getByRole("button", { name: "Change…" }));
    fill("claude", "baseUrl", "https://elsewhere.example.com");
    expect(within(row("claude")).getByTestId("agent-route-save").textContent).toBe("Enter credential and save");
  });

  it("saves a helper as user managed, with no credential", async () => {
    await show();
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Use your own endpoint or helper…" }));
    fireEvent.click(within(within(row("claude")).getAllByTestId("agent-route-template")[1]!).getByRole("radio"));
    expect(within(row("claude")).getByTestId("agent-route-user-managed").textContent).toMatch(/TerminalX never sees what it prints/);
    // It is not private to its creator in a shared workspace, and says so.
    expect(within(row("claude")).getByTestId("agent-route-user-managed").textContent).toMatch(/everyone who\s+drives it runs through your helper too/);
    fill("claude", "helperPath", "./scripts/llm-key");
    vi.mocked(api.cloudAgentRouteSave).mockImplementation(async () => {
      routes = [gatewayRoute({ mode: "user-managed", templateId: "claude-key-helper", settings: { helperPath: "./scripts/llm-key" }, credentialStored: false, version: 1 })];
      return { saved: true, check: null, routes: view() };
    });
    fireEvent.click(within(row("claude")).getByTestId("agent-route-save"));
    await screen.findByTestId("agent-route-notice");
    expect(vi.mocked(api.cloudAgentRouteSave).mock.calls[0]![0]).toMatchObject({ templateId: "claude-key-helper", settings: { helperPath: "./scripts/llm-key" }, enterCredential: false });
    expect(within(row("claude")).getByTestId("agent-route-status").textContent).toMatch(/^User managed · not checked yet/);
  });

  it("switches back to the organization login after saying what that does", async () => {
    routes = [gatewayRoute()];
    await show();
    fireEvent.click(within(row("claude")).getByTestId("agent-route-switch-back"));
    expect(screen.getByTestId("agent-route-confirm-remove").textContent).toMatch(/Your route and its stored credential are deleted/);
    vi.mocked(api.cloudAgentRouteRemove).mockImplementation(async () => {
      routes = [];
      return view();
    });
    fireEvent.click(screen.getByRole("button", { name: "Switch back" }));
    await waitFor(() => expect(within(row("claude")).getByTestId("agent-route-status").textContent).toBe("Organization login, managed by TerminalX."));
    expect(api.cloudAgentRouteRemove).toHaveBeenCalledWith("claude", "rev-1", "org-2");
  });

  it("says why a save was refused, without the server's words", async () => {
    routes = [gatewayRoute()];
    await show();
    fireEvent.click(within(row("claude")).getByRole("button", { name: "Change…" }));
    vi.mocked(api.cloudAgentRouteSave).mockRejectedValueOnce({ code: "cloud_agent_route_conflict", status: 409 });
    fireEvent.click(within(row("claude")).getByTestId("agent-route-save"));
    await waitFor(() => expect(screen.getByTestId("agent-route-error").textContent).toMatch(/changed elsewhere/));
  });
});

describe("Amazon Bedrock Test and save", () => {
  it("requires region/model, enters credentials natively and never offers an unchecked save", async () => {
    vi.mocked(api.cloudAgentRouteSave).mockResolvedValue({ saved: true, check: null, routes: view() });
    await show();
    fireEvent.click(within(row("claude")).getByText("Use your own endpoint or helper…"));
    fireEvent.click(within(row("claude")).getByLabelText(/Amazon Bedrock/));
    expect((screen.getByText("Test and save") as HTMLButtonElement).disabled).toBe(true);
    fill("claude", "region", "us-east-1");
    fill("claude", "model", "us.anthropic.test-v1:0");
    expect(screen.queryByText(/Save even if/)).toBeNull();
    fireEvent.click(screen.getByText("Test and save"));
    await waitFor(() => expect(api.cloudAgentRouteSave).toHaveBeenCalledWith(expect.objectContaining({ templateId: "claude-bedrock", enterCredential: true, saveUnchecked: false, settings: { region: "us-east-1", model: "us.anthropic.test-v1:0", authScheme: "bedrock-api-key" } })));
    expect(await screen.findByText(/Amazon Bedrock accepted the test model/)).toBeTruthy();
  });

  it("confirms disconnect and preserves the credential until confirmed", async () => {
    routes = [gatewayRoute({ templateId: "claude-bedrock", settings: { region: "us-east-1", model: "test-model", authScheme: "bedrock-api-key" } })];
    vi.mocked(api.cloudAgentRouteRemove).mockResolvedValue(view());
    await show();
    fireEvent.click(screen.getByTestId("agent-route-switch-back"));
    expect(screen.getByText("Disconnect Amazon Bedrock?")).toBeTruthy();
    expect(api.cloudAgentRouteRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch back" }));
    await waitFor(() => expect(api.cloudAgentRouteRemove).toHaveBeenCalledWith("claude", "rev-1", "org-2"));
  });
});
