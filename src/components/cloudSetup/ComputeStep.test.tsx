import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These cover the forms as a Mac runs them, where the secure system dialog exists.
const platform = vi.hoisted(() => ({ secureDialog: true }));
vi.mock("@/lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/platform")>()), get hasSecureDialog() { return platform.secureDialog; } }));
import { api, type CloudProviderConnection, type CloudProviderSummary, type CloudWorkspaceSetup, type OrganizationSummary } from "@/lib/api";
import { newSetup } from "@/lib/organizationSetup";
import { describedAs } from "@/test/cloudProviderDescriptors";
import { ComputeStep } from "./ComputeStep";

vi.mock("@/lib/api", () => ({
  api: {
    cloudProviders: vi.fn(),
    cloudProvider: vi.fn(),
    cloudWorkspaceSetup: vi.fn(),
    cloudProviderConnect: vi.fn(),
    cloudProviderSetCreationEnabled: vi.fn(),
  },
  errorMessage: (error: Error) => error.message,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

const organization: OrganizationSummary = { id: "org-1", name: "Acme", role: "owner" };

/** A provider as the organization's list carries it, with the descriptor the server publishes for it. */
const summary = (id: string, overrides: Partial<CloudProviderSummary> = {}): CloudProviderSummary => ({
  id,
  displayName: describedAs(id).label,
  availability: "available",
  canManage: true,
  connection: null,
  capabilities: { suspend: true, resume: true, releaseDisposition: "destroyed", locationSelection: "required", sourceSelection: "optional", pricing: "provider-rate" },
  descriptor: describedAs(id),
  ...overrides,
});

const offer = (provider: string): CloudWorkspaceSetup => ({
  provider,
  credentialFingerprint: "sha256:fixture",
  currency: "USD",
  pricing: "provider-rate",
  pricingObservedAt: 1,
  sources: [{ id: "default", kind: "provider-default", label: "Default image", description: null }],
  locations: [
    { id: "fra1", label: "Frankfurt", placement: "selected" },
    { id: "iad1", label: "Ashburn", placement: "selected" },
  ],
  machineClasses: [
    { id: "small", label: "small", vcpu: 2, memoryMiB: 4096, diskGiB: 40, activeHourlyMicros: 20_000 },
    { id: "large", label: "large", vcpu: 8, memoryMiB: 16_384, diskGiB: 160, activeHourlyMicros: 80_000 },
  ],
  defaults: { sourceId: "default", locationId: "fra1", machineClassId: "small", idleSuspendMinutes: 30, retentionDays: 7, networkPolicy: "relay-only" },
  allowedIdleSuspendMinutes: [30, 0],
  allowedRetentionDays: [7],
});

const connection = (provider: string, overrides: Partial<CloudProviderConnection> = {}): CloudProviderConnection => ({
  provider,
  state: "connected",
  canManage: true,
  credentialFingerprint: "sha256:abcd1234",
  connectedAt: 1,
  lastValidatedAt: 1,
  ...overrides,
});

const KEY_CONTROLS = /^Connect |Replace key|Enter the new key/;

let listed: CloudProviderSummary[];
const onRecord = vi.fn();
const onContinue = vi.fn();

const mount = () =>
  render(<ComputeStep organization={organization} record={newSetup("Acme", "request-1")} onRecord={onRecord} accountEmail="owner@example.com" contextRevision="rev-1" onContinue={onContinue} />);

const card = (id: string) => screen.getByTestId(`cloud-setup-provider-${id}`);
const connectionRow = () => screen.getByTestId("cloud-setup-provider-connection");

beforeEach(() => {
  vi.clearAllMocks();
  listed = [];
  vi.mocked(api.cloudProviders).mockImplementation(async () => ({ providers: structuredClone(listed) }));
  vi.mocked(api.cloudProvider).mockImplementation(async (provider) => connection(provider));
  vi.mocked(api.cloudWorkspaceSetup).mockImplementation(async (provider) => offer(provider));
});
afterEach(cleanup);

// PRO-452: a provider TerminalX itself provides. It reuses the connected
// provider's presentation without the key: nothing to connect, replace or
// read, and its regions and machine sizes show from the start.
describe("a provider TerminalX provides", () => {
  it("shows as ready to use with its regions and sizes, and has no connect step", async () => {
    listed = [summary("terminalx-cloud"), summary("hetzner", { availability: "not-connected" })];
    mount();
    const sizes = await screen.findByRole("radiogroup", { name: "Machine size" });
    expect(within(sizes).getAllByRole("radio")).toHaveLength(2);

    // Chosen without anyone connecting anything, and said to be ready.
    expect((within(card("terminalx-cloud")).getByRole("radio") as HTMLInputElement).checked).toBe(true);
    expect(card("terminalx-cloud").textContent).toContain("Billed by TerminalX");
    expect(connectionRow().textContent).toContain("Provided by TerminalX");
    expect(connectionRow().textContent).toContain("Ready");
    expect(connectionRow().textContent).toContain("Ready");
    expect(connectionRow().textContent).not.toContain("Not connected");
    expect(connectionRow().textContent).not.toContain("•");
    expect(screen.getByText(/TerminalX Cloud runs cloud workspaces on machines TerminalX provides/)).toBeTruthy();
    expect(screen.getByText("Choosing compute doesn't create a machine")).toBeTruthy();

    // No connect step, and nothing about a key.
    expect(screen.queryByTestId("cloud-setup-provider-connect")).toBeNull();
    expect(screen.queryByRole("button", { name: KEY_CONTROLS })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/provider keys/)).toBeNull();
    expect(screen.queryByText(/API token/)).toBeNull();

    // Its connection is never read; its offer is, like any other provider's.
    expect(api.cloudProvider).not.toHaveBeenCalled();
    expect(api.cloudProviderConnect).not.toHaveBeenCalled();
    expect(api.cloudWorkspaceSetup).toHaveBeenCalledWith("terminalx-cloud", "org-1");
    const region = screen.getByLabelText("Region") as HTMLSelectElement;
    expect(region.disabled).toBe(false);
    expect([...region.options].map((option) => option.value)).toEqual(["fra1", "iad1"]);
    await waitFor(() => expect(onRecord).toHaveBeenLastCalledWith(expect.objectContaining({ machine: { provider: "terminalx-cloud", locationId: "fra1", machineClassId: "small" } })));

    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("gives way to the provider the organization connected, and reads no connection when it is chosen", async () => {
    listed = [summary("terminalx-cloud"), summary("hetzner", { connection: { state: "connected", connectedAt: 1, lastValidatedAt: 1, credentialFingerprint: "sha256:abcd1234" } })];
    mount();
    await screen.findByRole("button", { name: "Replace key" });
    expect((within(card("hetzner")).getByRole("radio") as HTMLInputElement).checked).toBe(true);
    expect(connectionRow().textContent).toContain("1234");
    expect(connectionRow().textContent).toContain("Valid");
    expect(screen.getByText(/machines in your own provider account/)).toBeTruthy();
    expect(screen.getByText("Connecting a token doesn't create a machine")).toBeTruthy();
    expect(api.cloudProvider).toHaveBeenCalledTimes(1);
    expect(api.cloudProvider).toHaveBeenCalledWith("hetzner");

    fireEvent.click(within(card("terminalx-cloud")).getByRole("radio"));
    await waitFor(() => expect(connectionRow().textContent).toContain("Provided by TerminalX"));
    await waitFor(() => expect(api.cloudWorkspaceSetup).toHaveBeenLastCalledWith("terminalx-cloud", "org-1"));
    expect(screen.queryByRole("button", { name: KEY_CONTROLS })).toBeNull();
    expect(connectionRow().textContent).not.toContain("1234");
    expect(api.cloudProvider).toHaveBeenCalledTimes(1);
  });

  it("lets an owner or admin allow its paused new machines, which is all there is to manage", async () => {
    let availability: CloudProviderSummary["availability"] = "disabled-for-create";
    vi.mocked(api.cloudProviders).mockImplementation(async () => ({ providers: [summary("terminalx-cloud", { availability })] }));
    vi.mocked(api.cloudProviderSetCreationEnabled).mockImplementation(async (_provider, _revision, enabled) => {
      availability = enabled ? "available" : "disabled-for-create";
      return {} as CloudProviderSummary;
    });
    mount();
    const paused = await screen.findByTestId("cloud-setup-provider-paused");
    expect(paused.textContent).toContain("New machines are paused on TerminalX Cloud.");
    expect(card("terminalx-cloud").textContent).toContain("New machines paused");
    // Paused for new machines, it is still in place: no key is asked for.
    expect(connectionRow().textContent).toContain("Provided by TerminalX");
    expect(screen.queryByRole("button", { name: KEY_CONTROLS })).toBeNull();

    fireEvent.click(within(paused).getByRole("button", { name: "Allow new machines" }));
    await screen.findByText("New machines are allowed again.");
    expect(api.cloudProviderSetCreationEnabled).toHaveBeenCalledWith("terminalx-cloud", "rev-1", true);
    await waitFor(() => expect(screen.queryByTestId("cloud-setup-provider-paused")).toBeNull());
    expect(card("terminalx-cloud").textContent).not.toContain("New machines paused");
    expect(api.cloudProvider).not.toHaveBeenCalled();
  });

  it("tells a member nothing about keys, and offers no switch", async () => {
    listed = [summary("terminalx-cloud", { canManage: false, availability: "disabled-for-create" })];
    mount();
    const paused = await screen.findByTestId("cloud-setup-provider-paused");
    expect(paused.textContent).toContain("An organization owner or administrator can allow new machines again.");
    expect(within(paused).queryByRole("button")).toBeNull();
    expect(screen.queryByText(/provider keys|Ask an owner or administrator/)).toBeNull();
    expect(api.cloudProvider).not.toHaveBeenCalled();
  });

  it("says it is not available when it needs attention, with no key to replace", async () => {
    listed = [summary("terminalx-cloud", { availability: "attention-required" })];
    mount();
    const attention = await screen.findByTestId("cloud-setup-provider-platform-attention");
    expect(attention.textContent).toContain("TerminalX Cloud isn't available to Acme right now.");
    expect(connectionRow().textContent).toContain("Needs attention");
    expect(card("terminalx-cloud").textContent).toContain("Needs attention");
    expect(screen.queryByRole("button", { name: KEY_CONTROLS })).toBeNull();
    expect(screen.queryByTestId("cloud-setup-provider-connect")).toBeNull();
    expect([...(screen.getByLabelText("Region") as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["Unavailable"]);
    expect(api.cloudWorkspaceSetup).not.toHaveBeenCalled();
    expect(api.cloudProvider).not.toHaveBeenCalled();
  });
});

// Every provider an organization connects, and every server that does not
// say whose credential a provider runs on, is as it was before PRO-452.
describe("a provider the organization connects", () => {
  it.each([
    ["a server that says it is the organization's", describedAs("hetzner")],
    ["an older server that does not say", describedAs("hetzner", { credentialSource: undefined })],
  ])("asks for its key before anything else, from %s", async (_server, descriptor) => {
    listed = [summary("hetzner", { availability: "not-connected", descriptor })];
    vi.mocked(api.cloudProvider).mockImplementation(async (provider) => connection(provider, { state: "not-connected", credentialFingerprint: null, connectedAt: null, lastValidatedAt: null }));
    mount();
    const connect = await screen.findByTestId("cloud-setup-provider-connect");
    expect(api.cloudProvider).toHaveBeenCalledWith("hetzner");
    expect(connectionRow().textContent).toContain("Not connected");
    expect(screen.getByText("Hetzner API token")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Where to get the Hetzner API token" })).toBeTruthy();
    expect([...(screen.getByLabelText("Region") as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["After connecting"]);
    expect(api.cloudWorkspaceSetup).not.toHaveBeenCalled();

    // The key is asked for only after the billing consent.
    const button = within(connect).getByRole("button", { name: "Connect Hetzner Cloud" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(within(connect).getByRole("checkbox"));
    expect(button.disabled).toBe(false);
    vi.mocked(api.cloudProviderConnect).mockResolvedValue(connection("hetzner"));
    fireEvent.click(button);
    await waitFor(() => expect(api.cloudProviderConnect).toHaveBeenCalledWith("hetzner", expect.objectContaining({ contextRevision: "rev-1" })));
  });
});

describe("a provider key on a computer with no secure system dialog", () => {
  it("keeps Connect off and says where to enter the key", async () => {
    platform.secureDialog = false;
    try {
      listed = [summary("hetzner", { availability: "not-connected", descriptor: describedAs("hetzner") })];
      vi.mocked(api.cloudProvider).mockImplementation(async (provider) => connection(provider, { state: "not-connected", credentialFingerprint: null, connectedAt: null, lastValidatedAt: null }));
      mount();
      const connect = await screen.findByTestId("cloud-setup-provider-connect");
      expect(within(connect).getByRole("note").textContent).toContain("macOS only");
      fireEvent.click(within(connect).getByRole("checkbox"));
      expect((within(connect).getByRole("button", { name: "Connect Hetzner Cloud" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      platform.secureDialog = true;
    }
  });
});
