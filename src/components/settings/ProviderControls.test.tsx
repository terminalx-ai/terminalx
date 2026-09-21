import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type CloudProviderConnection } from "@/lib/api";
import { ProviderControls } from "./ProviderControls";

vi.mock("@/lib/api", () => ({
  api: {
    cloudProviders: vi.fn(),
    cloudProvider: vi.fn(),
    cloudProviderConnect: vi.fn(),
    cloudProviderDisconnect: vi.fn(),
    cloudWorkspaceCreate: vi.fn(),
  },
}));
let detail: CloudProviderConnection;
beforeEach(() => {
  vi.clearAllMocks();
  detail = {
    provider: "box",
    state: "connected",
    canManage: true,
    credentialFingerprint: "sha256:fixture",
    connectedAt: 1,
    lastValidatedAt: 1,
    credentialVersion: 3,
    providerAccount: "Original account",
    resources: [
      {
        id: "ws-1",
        name: "Running job",
        state: "ready",
        kind: "workspace",
        operationState: "running",
        cleanupRequired: false,
        activeHourlyMicros: 120000,
        suspendedMonthlyMicros: 3000000,
        currency: "USD",
        releaseDisposition: null,
      },
    ],
  };
  vi.mocked(api.cloudProviders).mockImplementation(async () => ({
    providers: [
      {
        id: "box",
        displayName: "Box",
        canManage: detail.canManage,
        availability: "available",
        connection: null,
        capabilities: {
          suspend: true,
          resume: true,
          releaseDisposition: "archived",
          locationSelection: "automatic",
          sourceSelection: "optional",
          pricing: "estimate",
        },
      },
    ],
  }));
  vi.mocked(api.cloudProvider).mockImplementation(async () =>
    structuredClone(detail),
  );
});
afterEach(cleanup);
const ready = async () => {
  render(<ProviderControls contextRevision="org-revision" />);
  await screen.findByText("Original account");
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Replace / validate key" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
};
const replace = async () => {
  fireEvent.click(
    screen.getByRole("button", { name: "Replace / validate key" }),
  );
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Validate and save key" }),
  );
};

describe("organization provider controls", () => {
  it("shows members an admin action with no key controls or account metadata", async () => {
    detail.canManage = false;
    detail.state = "attention-required";
    render(<ProviderControls contextRevision="member" />);
    await screen.findByText(/Ask an organization administrator/);
    expect(
      screen.queryByRole("button", { name: /Replace|Disconnect|Validate/ }),
    ).toBeNull();
    expect(screen.queryByText("Original account")).toBeNull();
  });
  it("requires billing consent, then updates version only after validation succeeds", async () => {
    vi.mocked(api.cloudProviderConnect).mockImplementation(async () => {
      detail.credentialVersion = 4;
      return detail;
    });
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Replace / validate key" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Validate and save key" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Validate and save key" }),
    );
    await screen.findByText("4");
    expect(api.cloudProviderConnect).toHaveBeenCalledWith("box", {
      contextRevision: "org-revision",
      disclosure: {
        version: "cloud-provider-connections-2026-08-13",
        providerBillingAccepted: true,
        organizationUseAccepted: true,
      },
    });
    expect(screen.getByText("Original account")).toBeTruthy();
    expect(screen.getByText(/Running job/)).toBeTruthy();
  });
  it.each([
    "cloud_provider_account_mismatch",
    "cloud_provider_credential_invalid",
  ])("preserves ownership and version on %s", async (code) => {
    vi.mocked(api.cloudProviderConnect).mockRejectedValue({ code });
    await ready();
    await replace();
    await screen.findByRole("alert");
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Original account")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(
      /original provider account|different provider account/,
    );
  });
  it("requires an explicit disposition and keeps unavailable cleanup visible after retry", async () => {
    detail.state = "attention-required";
    detail.disconnectDisposition = "destroy";
    detail.resources![0].operationState = "failed";
    detail.resources![0].cleanupRequired = true;
    vi.mocked(api.cloudProviderDisconnect).mockResolvedValue(detail);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry disconnect / cleanup" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Confirm disconnect" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Destroy resources/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() =>
      expect(api.cloudProviderDisconnect).toHaveBeenCalledWith(
        "box",
        "org-revision",
        "destroy",
      ),
    );
    await screen.findByRole("button", { name: "Retry disconnect / cleanup" });
    expect(screen.getByText(/Cleanup unresolved/)).toBeTruthy();
    expect(screen.getByText(/0.1200\/hour/)).toBeTruthy();
  });
  it("fails closed when an older service omits the lifecycle metadata", async () => {
    delete detail.resources;
    delete detail.credentialVersion;
    await ready();
    expect(
      screen
        .getByRole("button", { name: "Disconnect" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  it("keeps setup incomplete on timeout and recovers the saved connection on refresh", async () => {
    detail.state = "not-connected";
    detail.lastValidatedAt = null;
    detail.resources = [];
    vi.mocked(api.cloudProviderConnect).mockRejectedValue({
      code: "provider_timeout",
    });
    const view = render(<ProviderControls contextRevision="org-revision" />);
    await screen.findByRole("button", { name: "Connect provider" });
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Validate and save key" }),
    );
    await screen.findByRole("alert");
    await screen.findByText("Compute setup incomplete — connect a provider");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      false,
    );
    view.unmount();
    detail.state = "connected";
    detail.lastValidatedAt = 100;
    render(<ProviderControls contextRevision="org-revision" />);
    await screen.findByText("Setup complete — compute connection validated");
    expect(screen.getByText(/Next: create a cloud workspace/)).toBeTruthy();
    expect(api.cloudProviderConnect).toHaveBeenCalledOnce();
  });
  it("honors backend rejection when the displayed admin role has been revoked", async () => {
    vi.mocked(api.cloudProviderConnect).mockImplementation(async () => {
      detail.canManage = false;
      throw { code: "organization_admin_required" };
    });
    await ready();
    await replace();
    await screen.findByText(
      "Only an organization owner or administrator can manage this connection.",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Validate and save key" }),
      ).toBeNull(),
    );
  });
  it("does not report completion when the service blocks provisioning", async () => {
    detail.operationsBlocked = true;
    await ready();
    expect(screen.queryByText(/Setup complete/)).toBeNull();
    expect(screen.getByText(/Compute setup incomplete/)).toBeTruthy();
  });
  it("completes first-time setup only after validation without provisioning", async () => {
    detail.state = "not-connected";
    detail.resources = [];
    vi.mocked(api.cloudProviderConnect).mockImplementation(async () => {
      detail.state = "connected";
      return detail;
    });
    render(<ProviderControls contextRevision="org-revision" />);
    await screen.findByText("Compute setup incomplete — connect a provider");
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Validate and save key" }),
    );
    await screen.findByText("Setup complete — compute connection validated");
    expect(api.cloudProviderConnect).toHaveBeenCalledOnce();
    expect(api.cloudWorkspaceCreate).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
