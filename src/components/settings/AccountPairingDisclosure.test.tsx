import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountListing, MachineName, PairingHostMetadata } from "@/types/pairing";

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
  listing: { state: "listed" } as AccountListing,
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
      accountListing: mocks.listing,
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
  mocks.listing = { state: "listed" };
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
    expect(screen.queryByText("What this computer shares")).toBeNull();

    const section = screen.getByTestId("machine-name-settings");
    const input = within(section).getByRole("textbox", { name: "This computer’s name" }) as HTMLInputElement;
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
  // PRO-598: whether the account's other computers can find this one, and why not, is said on this computer.
  it("says this computer is on the account's machine list, or why it is not", () => {
    render(<AccountTab />);
    expect(screen.getByTestId("account-listing").textContent).toContain("On your account’s machine listYour other computers signed in as owner@terminalx.ai find this computer under Add a machine → On your account.");
    cleanup();

    mocks.listing = { state: "refused", reason: "Another TerminalX account lists this Mac. Sign out of TerminalX on this Mac as that account, or sign in here with it." };
    render(<AccountTab />);
    const refused = screen.getByTestId("account-listing");
    expect(refused.dataset.state).toBe("refused");
    expect(within(refused).getByText("Not on your account’s machine list")).toBeTruthy();
    const said = within(refused).getByRole("status");
    expect(said.textContent).toBe("Your other computers signed in as owner@terminalx.ai cannot find this computer yet. Another TerminalX account lists this Mac. Sign out of TerminalX on this Mac as that account, or sign in here with it.");
    expect(said.className).toContain("text-warning");
    cleanup();

    mocks.listing = { state: "pending", reason: "Relay has not confirmed that this Mac is connected yet. Trying again." };
    render(<AccountTab />);
    const pending = within(screen.getByTestId("account-listing")).getByRole("status");
    expect(pending.textContent).toContain("Relay has not confirmed");
    expect(pending.className).not.toContain("text-warning");
    cleanup();

    mocks.listing = { state: "off" };
    render(<AccountTab />);
    expect(screen.queryByTestId("account-listing")).toBeNull();
  });

  it("takes initials from the first and last name, else the email", () => {
    expect(accountInitials({ name: "Alex Kim", email: "a@b.c", organization: null })).toBe("AK");
    expect(accountInitials({ name: " ada  de la mare ", email: "a@b.c", organization: null })).toBe("AM");
    expect(accountInitials({ name: "Paresh", email: "a@b.c", organization: null })).toBe("P");
    expect(accountInitials({ name: null, email: "zoe@b.c", organization: null })).toBe("Z");
  });
});
