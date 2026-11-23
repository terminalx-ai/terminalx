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
  pendingApproval: null,
  keepAwake: true,
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

const { AccountTab, accountInitials } = await import("./AccountTab");

beforeEach(() => {
  mocks.host = { ...host };
  mocks.machineName.mockClear();
  mocks.setMachineName.mockClear();
});
afterEach(cleanup);

describe("account binding disclosure", () => {
  it("keeps every directory field in a collapsed Advanced disclosure", async () => {
    render(<AccountTab />);

    const advanced = screen.getByText("Advanced");
    const disclosure = advanced.closest("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(advanced);
    expect(disclosure.open).toBe(true);
    for (const label of ["Host ID", "Public key", "Generation", "Display name", "Platform", "Environment", "Capability"]) {
      expect(within(disclosure).getByText(label)).toBeTruthy();
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
    const input = within(section).getByRole("textbox", { name: "This Mac’s name" }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Studio Mac"));
    fireEvent.change(input, { target: { value: "  Desk Mac " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mocks.setMachineName).toHaveBeenCalledWith("Desk Mac"));
    await waitFor(() => expect(input.value).toBe("Desk Mac"));
    expect(section.textContent).toContain("“You · on Desk Mac”");
  });

  // PRO-375: organisation setup lives under Organizations; Account names the active one and links to its page.
  it("has no organization setup on Account", () => {
    mocks.organization = "Existing organization";
    render(<AccountTab />);
    expect(screen.queryByText("Organization setup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create or switch organization" })).toBeNull();
    expect(within(screen.getByTestId("account-identity")).getByText("Existing organization")).toBeTruthy();
    cleanup();
    mocks.organization = null;
  });

  it("shows initials, name and email in the identity header, and signs out from a row", () => {
    render(<AccountTab />);
    const identity = screen.getByTestId("account-identity");
    expect(identity.textContent).toContain("P");
    expect(within(identity).getByText("Paresh")).toBeTruthy();
    expect(within(identity).getByText("owner@terminalx.ai")).toBeTruthy();
    const signOutRow = screen.getByTestId("account-sign-out");
    fireEvent.click(within(signOutRow).getByRole("button", { name: "Sign out" }));
    // The app's own dialog (PRO-400): the question, what happens, Cancel on the left and a red Sign out on the right.
    const dialog = screen.getByRole("dialog", { name: "Sign out of TerminalX?" });
    expect(dialog.textContent).toContain("QR and code pairings keep working");
    const buttons = within(dialog).getAllByRole("button").map((button) => button.textContent?.trim());
    expect(buttons).toEqual(["Cancel", "Sign out"]);
    expect(within(dialog).getByRole("button", { name: "Sign out" }).className).toContain("bg-destructive");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("takes initials from the first and last name, else the email", () => {
    expect(accountInitials({ name: "Alex Kim", email: "a@b.c", organization: null })).toBe("AK");
    expect(accountInitials({ name: " ada  de la mare ", email: "a@b.c", organization: null })).toBe("AM");
    expect(accountInitials({ name: "Paresh", email: "a@b.c", organization: null })).toBe("P");
    expect(accountInitials({ name: null, email: "zoe@b.c", organization: null })).toBe("Z");
  });
});
