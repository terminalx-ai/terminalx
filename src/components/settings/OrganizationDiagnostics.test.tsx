import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import type { CloudDiagnostics } from "@/lib/cloudDiagnostics";
import { OrganizationDiagnostics } from "./OrganizationDiagnostics";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { cloudDiagnostics: vi.fn(), cloudConnectionDiagnostics: vi.fn(), cloudDiagnosticsExport: vi.fn() },
  errorMessage: (error: unknown) => String(error),
}));
// The real rule (the organization only when the server authorizes by membership) is covered in CloudProjects.test.tsx.
vi.mock("@/lib/cloudCatalog", () => ({ cloudOrgArg: (orgId: string | null | undefined) => orgId ?? null }));

const diagnostics = (): CloudDiagnostics => ({
  v: 1,
  organizationId: "org_1",
  generatedAt: Date.UTC(2026, 8, 28),
  window: { from: Date.UTC(2026, 8, 21), to: Date.UTC(2026, 8, 28), maxOperations: 200, truncated: false },
  retention: { operationHistoryDays: 90, operationLogDays: 14 },
  stageTimings: {
    create: {
      samples: 12,
      totalMs: { p50: 41_000, p95: 88_000 },
      stages: { preflight: { samples: 12, p50: 300, p95: 900 }, "creating-machine": { samples: 12, p50: 20_000, p95: 50_000 } },
    },
    resume: { samples: 0, totalMs: { p50: null, p95: null }, stages: {} },
  },
  operations: [
    {
      operationId: "op_1",
      workspaceId: "cw_1",
      provider: "local-docker",
      type: "resume",
      state: "failed",
      stage: "connecting-relay",
      errorCode: "cloud_provider_credential_invalid",
      retryAction: "fix-provider-credentials",
      reason: "attention-stopped",
      reasonDetail: "cloud_provider_credential_invalid",
      attemptCount: 2,
      createdAt: Date.UTC(2026, 8, 27),
      updatedAt: Date.UTC(2026, 8, 27),
      durationMs: 12_000,
      restartDecision: { path: "fenced-restart", reason: "warm-grace-expired", fencedAt: 1, replacedRuntimeGeneration: 3, fence: "rotate" },
      history: [],
    },
  ],
  workspaces: [
    {
      workspaceId: "cw_1",
      provider: "local-docker",
      state: "ready",
      runtimeGeneration: 4,
      lastActivityAt: 1,
      connections: { ready: 1, waitingForRuntime: 2, expired: 3 },
      lastOperationId: "op_1",
    },
  ],
  closeReasons: [
    { code: 4101, name: "stale_generation", retryAction: "fetch-new-ticket" },
    { code: 4103, name: "update_required", retryAction: "update-app" },
  ],
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.cloudConnectionDiagnostics).mockResolvedValue([{ workspaceId: "cw_1", code: 4102, name: "auth_expired", at: Date.UTC(2026, 8, 28) }]);
});
afterEach(cleanup);

it("shows timings, operations with retry hints, restart decisions, connections and the close legend", async () => {
  vi.mocked(api.cloudDiagnostics).mockResolvedValue(diagnostics());
  render(<OrganizationDiagnostics contextRevision="rev-1" />);

  const create = await screen.findByLabelText("Create timings");
  expect(create.textContent).toContain("12 samples");
  expect(create.textContent).toContain("Total p50 41s · p95 1m 28s");
  expect(within(create).getByText("creating-machine")).toBeTruthy();
  expect(screen.getByLabelText("Resume timings").textContent).toContain("p50 — · p95 —");

  const operation = within(screen.getByLabelText("Recent operations")).getByRole("listitem");
  expect(operation.textContent).toContain("resume");
  expect(operation.textContent).toContain("at connecting-relay");
  expect(operation.textContent).toContain("cloud_provider_credential_invalid");
  expect(operation.textContent).toContain("Validate or replace the provider key");
  expect(operation.textContent).toContain("Restart: fenced-restart (warm-grace-expired) · fence rotate · replaced generation 3");
  expect(operation.textContent).toContain("2 attempts");
  // Nothing is said about private workspaces when none was left out.
  expect(screen.queryByTestId("diagnostics-private-note")).toBeNull();
  expect(operation.textContent).toContain("Stopped by TerminalX while the workspace needed attention (cloud_provider_credential_invalid).");
  // The closes asked for are the default organization's, like the report.
  expect(api.cloudConnectionDiagnostics).toHaveBeenCalledWith(null);

  expect(screen.getByLabelText("Workspace connections").textContent).toContain("1 ready · 2 waiting · 3 expired");
  const legend = screen.getByLabelText("Relay close reasons");
  expect(legend.textContent).toContain("stale_generation");
  expect(legend.textContent).toContain("Update TerminalX");
  expect(screen.getByLabelText("Connection closes on this Mac").textContent).toContain("auth_expired");
  expect(api.cloudDiagnostics).toHaveBeenCalledWith(7, null);
});

it("tells a member the organization's diagnostics are for administrators and keeps this Mac's closes", async () => {
  vi.mocked(api.cloudDiagnostics).mockRejectedValue({ code: "organization_admin_required", status: 403 });
  render(<OrganizationDiagnostics contextRevision="rev-1" />);
  expect(await screen.findByText(/Only organization owners and administrators/)).toBeTruthy();
  expect(screen.queryByLabelText("Recent operations")).toBeNull();
  expect(screen.queryByLabelText("Create timings")).toBeNull();
  expect(screen.getByLabelText("Connection closes on this Mac").textContent).toContain("auth_expired");
  expect(screen.getByRole("button", { name: /Export diagnostics/ })).toBeTruthy();
});

it("formats durations without a 60-second remainder", async () => {
  const { formatDuration } = await import("@/lib/cloudDiagnostics");
  expect(formatDuration(119_600)).toBe("2m");
  expect(formatDuration(300)).toBe("300ms");
  expect(formatDuration(null)).toBe("—");
});

it("says the server does not offer diagnostics yet and still shows local closes", async () => {
  vi.mocked(api.cloudDiagnostics).mockRejectedValue({ code: "cloud_diagnostics_not_supported", status: 404 });
  render(<OrganizationDiagnostics contextRevision="rev-1" />);
  expect((await screen.findByRole("alert")).textContent).toContain("not available on this server");
  expect(screen.getByLabelText("Connection closes on this Mac").textContent).toContain("4102");
});

it("exports only to a path the user chose, with the selected window", async () => {
  vi.mocked(api.cloudDiagnostics).mockResolvedValue(diagnostics());
  vi.mocked(api.cloudDiagnosticsExport).mockResolvedValue(undefined);
  vi.mocked(save).mockResolvedValueOnce(null).mockResolvedValueOnce("/tmp/diagnostics.json");
  render(<OrganizationDiagnostics contextRevision="rev-1" />);
  await screen.findByLabelText("Recent operations");

  fireEvent.click(screen.getByRole("button", { name: /Export diagnostics/ }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(api.cloudDiagnosticsExport).not.toHaveBeenCalled();

  fireEvent.change(screen.getByRole("combobox", { name: "Diagnostics window" }), { target: { value: "30" } });
  await waitFor(() => expect(api.cloudDiagnostics).toHaveBeenLastCalledWith(30, null));
  await screen.findByLabelText("Recent operations");
  fireEvent.click(screen.getByRole("button", { name: /Export diagnostics/ }));
  await waitFor(() => expect(api.cloudDiagnosticsExport).toHaveBeenCalledWith("/tmp/diagnostics.json", 30, null));
  expect((await screen.findByText(/Saved to/)).textContent).toContain("/tmp/diagnostics.json");
});

it("explains a refused export in words", async () => {
  vi.mocked(api.cloudDiagnostics).mockResolvedValue(diagnostics());
  vi.mocked(api.cloudDiagnosticsExport).mockRejectedValue("cloud_diagnostics_export_write_failed");
  vi.mocked(save).mockResolvedValue("/read-only/diagnostics.json");
  render(<OrganizationDiagnostics contextRevision="rev-1" />);
  await screen.findByLabelText("Recent operations");
  fireEvent.click(screen.getByRole("button", { name: /Export diagnostics/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("could not be written there");
});

it("reports on and exports the organization it was opened for, marking the workspace it came from", async () => {
  const report = diagnostics();
  report.organizationId = "org_2";
  report.operations.push({ ...report.operations[0], operationId: "op_2", workspaceId: "cw_2" });
  report.workspaces.push({ ...report.workspaces[0], workspaceId: "cw_2" });
  vi.mocked(api.cloudDiagnostics).mockResolvedValue(report);
  vi.mocked(api.cloudDiagnosticsExport).mockResolvedValue(undefined);
  vi.mocked(save).mockResolvedValue("/tmp/org-2.json");
  render(<OrganizationDiagnostics contextRevision="rev-1" orgId="org_2" workspaceId="cw_2" framed={false} />);

  const operations = within(await screen.findByLabelText("Recent operations")).getAllByRole("listitem");
  expect(api.cloudDiagnostics).toHaveBeenCalledWith(7, "org_2");
  // This Mac's closes are asked for in that organization only, never the whole log.
  expect(api.cloudConnectionDiagnostics).toHaveBeenCalledWith("org_2");
  expect(api.cloudConnectionDiagnostics).toHaveBeenCalledTimes(1);
  expect(operations.map((row) => row.hasAttribute("data-current"))).toEqual([false, true]);
  const workspaces = within(screen.getByLabelText("Workspace connections")).getAllByRole("listitem");
  expect(workspaces.map((row) => row.hasAttribute("data-current"))).toEqual([false, true]);
  // Inside a dialog the frame's own title is the dialog's.
  expect(screen.queryByText("Cloud diagnostics")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /Export diagnostics/ }));
  await waitFor(() => expect(api.cloudDiagnosticsExport).toHaveBeenCalledWith("/tmp/org-2.json", 7, "org_2"));
});

it("says how many private workspaces the report leaves out, and explains a rate limit", async () => {
  vi.mocked(api.cloudDiagnostics).mockResolvedValue({ ...diagnostics(), privateWorkspacesNotShown: 3 });
  const view = render(<OrganizationDiagnostics contextRevision="rev-1" />);
  expect((await screen.findByTestId("diagnostics-private-note")).textContent).toContain("3 private workspaces are not shown");
  view.unmount();

  vi.mocked(api.cloudDiagnostics).mockResolvedValue({ ...diagnostics(), privateWorkspacesNotShown: 1 });
  const one = render(<OrganizationDiagnostics contextRevision="rev-1" />);
  expect((await screen.findByTestId("diagnostics-private-note")).textContent).toContain("1 private workspace is not shown");
  one.unmount();

  vi.mocked(api.cloudDiagnostics).mockRejectedValue({ code: "cloud_workspace_rate_limited", status: 429 });
  render(<OrganizationDiagnostics contextRevision="rev-1" />);
  expect((await screen.findByRole("alert")).textContent).toContain("Too many diagnostics requests");
});

it("explains an organization this account cannot reach", async () => {
  vi.mocked(api.cloudDiagnostics).mockRejectedValue({ code: "cloud_workspace_not_found", status: 404 });
  render(<OrganizationDiagnostics contextRevision="rev-1" orgId="org_9" />);
  expect((await screen.findByRole("alert")).textContent).toContain("not available for this organization");
});
