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
  expect(create.textContent).toContain("Total p50 41.0 s · p95 1 m 28 s");
  expect(within(create).getByText("creating-machine")).toBeTruthy();
  expect(screen.getByLabelText("Resume timings").textContent).toContain("p50 — · p95 —");

  const operation = within(screen.getByLabelText("Recent operations")).getByRole("listitem");
  expect(operation.textContent).toContain("resume");
  expect(operation.textContent).toContain("at connecting-relay");
  expect(operation.textContent).toContain("cloud_provider_credential_invalid");
  expect(operation.textContent).toContain("Validate or replace the provider key");
  expect(operation.textContent).toContain("Restart: fenced-restart (warm-grace-expired) · fence rotate · replaced generation 3");
  expect(operation.textContent).toContain("2 attempts");

  expect(screen.getByLabelText("Workspace connections").textContent).toContain("1 ready · 2 waiting · 3 expired");
  const legend = screen.getByLabelText("Relay close reasons");
  expect(legend.textContent).toContain("stale_generation");
  expect(legend.textContent).toContain("Update TerminalX");
  expect(screen.getByLabelText("Connection closes on this Mac").textContent).toContain("auth_expired");
  expect(api.cloudDiagnostics).toHaveBeenCalledWith(7);
});

it("tells a member diagnostics are for administrators and shows nothing else", async () => {
  vi.mocked(api.cloudDiagnostics).mockRejectedValue({ code: "organization_admin_required", status: 403 });
  render(<OrganizationDiagnostics contextRevision="rev-1" />);
  expect(await screen.findByText(/Only organization owners and administrators/)).toBeTruthy();
  expect(screen.queryByLabelText("Recent operations")).toBeNull();
  expect(screen.queryByRole("button", { name: /Export diagnostics/ })).toBeNull();
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
  await waitFor(() => expect(api.cloudDiagnostics).toHaveBeenLastCalledWith(30));
  await screen.findByLabelText("Recent operations");
  fireEvent.click(screen.getByRole("button", { name: /Export diagnostics/ }));
  await waitFor(() => expect(api.cloudDiagnosticsExport).toHaveBeenCalledWith("/tmp/diagnostics.json", 30));
  expect((await screen.findByText(/Saved to/)).textContent).toContain("/tmp/diagnostics.json");
});
