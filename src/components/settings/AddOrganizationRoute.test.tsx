import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/platform")>()), hasSecureDialog: true }));
import type { AgentRouteTemplate, OrganizationRoutes } from "@/lib/api";
import { AddOrganizationRoute } from "./AddOrganizationRoute";

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { cloudOrganizationRouteAdd: add } }));

const templates: AgentRouteTemplate[] = [
  {
    id: "claude-gateway",
    version: 1,
    provider: "claude",
    mode: "custom-endpoint",
    label: "LLM gateway",
    description: "",
    fields: [
      { key: "baseUrl", kind: "url", required: true, label: "Base URL", help: "" },
      { key: "authScheme", kind: "choice", required: true, label: "Header", help: "", choices: [{ value: "bearer", label: "Bearer" }, { value: "x-api-key", label: "x-api-key" }], default: "bearer" },
      { key: "model", kind: "model", required: false, label: "Model", help: "" },
    ],
    credential: { label: "Gateway credential", help: "" },
    capabilities: { modelList: "anthropic", modelPicker: true },
    docs: "",
  },
  {
    id: "codex-provider",
    version: 1,
    provider: "codex",
    mode: "custom-endpoint",
    label: "Model provider",
    description: "",
    fields: [
      { key: "baseUrl", kind: "url", required: true, label: "Base URL", help: "" },
      { key: "model", kind: "model", required: true, label: "Model", help: "" },
    ],
    credential: { label: "Provider key", help: "" },
    capabilities: { modelList: "openai", modelPicker: false },
    docs: "",
  },
];
const routes: OrganizationRoutes = { canManage: true, templates, routes: [] };
const added: OrganizationRoutes = {
  ...routes,
  routes: [{ id: "orgroute_1", provider: "claude", repository: "acme/terminalx", templateId: "claude-gateway", templateVersion: 1, templateCurrent: true, settings: { baseUrl: "https://gw.example.com" }, version: 1, createdAt: 1, updatedAt: 1 }],
};

const onAdded = vi.fn();
const open = () => {
  render(<AddOrganizationRoute contextRevision="rev-1" organizationId="org-2" organizationName="Acme" routes={routes} onAdded={onAdded} />);
  fireEvent.click(screen.getByTestId("organization-route-add"));
  return screen.getByTestId("organization-route-form");
};
const fill = (form: HTMLElement) => {
  fireEvent.change(within(form).getByPlaceholderText("owner/name"), { target: { value: "Acme/terminalx" } });
  fireEvent.change(within(form).getByPlaceholderText("https://llm.example.com"), { target: { value: "https://gw.example.com" } });
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("adds a route for an agent and repository once the test passed", async () => {
  add.mockResolvedValue({ saved: true, check: { outcome: "ok" }, routes: added });
  const form = open();
  expect(form.textContent).toContain("For everyone in Acme · takes precedence over members’ own Claude Code logins");
  const save = within(form).getByRole("button", { name: "Test and save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fill(form);
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(added));
  expect(add).toHaveBeenCalledExactlyOnceWith({
    organizationId: "org-2",
    contextRevision: "rev-1",
    agent: "claude",
    repository: "Acme/terminalx",
    templateId: "claude-gateway",
    settings: { baseUrl: "https://gw.example.com", authScheme: "bearer" },
    saveUnchecked: false,
  });
  expect(screen.queryByTestId("organization-route-form")).toBeNull();
});

it("switches to another agent's provider fields", () => {
  const form = open();
  fireEvent.click(within(form).getByRole("radio", { name: "Codex" }));
  expect(within(form).getByText("Custom provider for Codex")).toBeTruthy();
  expect(form.querySelector('[data-field="authScheme"]')).toBeNull();
});

it("saves nothing when the test fails, and offers to test again or save anyway", async () => {
  add.mockResolvedValueOnce({ saved: false, check: { outcome: "failed", code: "unauthorized" }, routes: null });
  const form = open();
  fill(form);
  fireEvent.click(within(form).getByRole("button", { name: "Test and save" }));
  const failed = await screen.findByTestId("organization-route-test-failed");
  expect(failed.textContent).toContain("Test failed · nothing was saved");
  expect(failed.textContent).toContain("the endpoint refused the credential (401)");
  expect(onAdded).not.toHaveBeenCalled();
  expect(within(form).getByRole("button", { name: "Test again" })).toBeTruthy();
  fireEvent.click(within(failed).getByRole("checkbox"));
  add.mockResolvedValueOnce({ saved: true, check: { outcome: "failed", code: "unauthorized" }, routes: added });
  fireEvent.click(within(form).getByRole("button", { name: "Test and save anyway" }));
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(added));
  expect(add.mock.calls[1][0].saveUnchecked).toBe(true);
});

it("shows a refused save in the form and keeps it open", async () => {
  add.mockRejectedValue({ code: "cloud_organization_route_exists" });
  const form = open();
  fill(form);
  fireEvent.click(within(form).getByRole("button", { name: "Test and save" }));
  expect(await screen.findByTestId("organization-route-form-error")).toBeTruthy();
  expect(onAdded).not.toHaveBeenCalled();
});

it("closes on Cancel without sending anything", () => {
  const form = open();
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByTestId("organization-route-form")).toBeNull();
  expect(add).not.toHaveBeenCalled();
});
