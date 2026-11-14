import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineName, PairingHostMetadata } from "@/types/pairing";

const host: PairingHostMetadata = {
  hostId: "host-1",
  publicKey: "public-key",
  bindingGeneration: 3,
  displayName: "Studio Mac",
  platform: "darwin",
  environmentKind: "native",
  capabilities: ["account-bound-host-pairing.v1"],
  appVersion: "0.1.0",
  lastSeenAt: "2026-09-03T00:00:00Z",
};

const mocks = vi.hoisted(() => ({
  organization: null as string | null,
  host: null as PairingHostMetadata | null,
  machineName: vi.fn(async (): Promise<MachineName> => ({ name: "Studio Mac", chosen: false, computerName: "Studio Mac" })),
  setMachineName: vi.fn(async (name: string | null): Promise<MachineName> => ({ name: name ?? "Studio Mac", chosen: name !== null, computerName: "Studio Mac" })),
}));

vi.mock("@/lib/account", () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  useAccount: () => ({
    ready: true,
    busy: false,
    status: {
      state: "signed-in",
      identity: { name: "Paresh", email: "owner@terminalx.ai", organization: mocks.organization },
      expiresAt: Date.now() + 60_000,
      lastError: null,
    },
  }),
}));

vi.mock("@/lib/pairing", () => ({
  usePairing: () => ({
    ready: true,
    busy: false,
    status: {
      relay: { phase: mocks.host ? "connected" : "off", message: null, attempt: 0 },
      host: mocks.host,
      devices: [],
      activePairing: null,
      lastError: null,
    },
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, machineName: mocks.machineName, setMachineName: mocks.setMachineName },
    workStatus: { ...actual.workStatus, settings: async () => ({ shareWithTeam: true }) },
  };
});

const { AccountTab } = await import("./AccountTab");

beforeEach(() => {
  mocks.host = { ...host };
  mocks.machineName.mockClear();
  mocks.setMachineName.mockClear();
});
afterEach(cleanup);

describe("account binding disclosure", () => {
  it("names every directory field, the machine name among them", async () => {
    render(<AccountTab />);

    for (const label of ["Host ID", "Public key", "Generation", "Display name", "Platform", "Environment", "Capability"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Display name").nextElementSibling?.textContent).toBe("Studio Mac");
    await screen.findByTestId("machine-name");
  });

  // #686: the name other Macs show is seen and changed whether or not Relay bound this Mac.
  it("shows and renames this Mac with Relay off", async () => {
    mocks.host = null;
    render(<AccountTab />);
    expect(screen.queryByText("What this Mac shares")).toBeNull();

    const section = screen.getByTestId("machine-name-settings");
    await waitFor(() => expect(within(section).getByTestId("machine-name").textContent).toBe("Studio Mac"));
    fireEvent.click(within(section).getByRole("button", { name: "Rename" }));
    const input = within(section).getByRole("textbox", { name: "This Mac’s name" });
    fireEvent.change(input, { target: { value: "  Desk Mac " } });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.setMachineName).toHaveBeenCalledWith("Desk Mac"));
    await waitFor(() => expect(within(section).getByTestId("machine-name").textContent).toBe("Desk Mac"));
    expect(section.textContent).toContain("“You · on Desk Mac”");
  });

  it("keeps creation discoverable when an organization already exists", () => {
    mocks.organization = "Existing organization";
    render(<AccountTab />);
    expect(screen.getByRole("button", { name: "Create or switch organization" })).toBeTruthy();
    cleanup();
    mocks.organization = null;
  });
});
