import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setHostName: vi.fn(async () => {}), organization: null as string | null }));

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
  setPairingHostName: mocks.setHostName,
  usePairing: () => ({
    ready: true,
    busy: false,
    status: {
      relay: { phase: "connected", message: "Connected", attempt: 0 },
      host: {
        hostId: "host-1",
        publicKey: "public-key",
        bindingGeneration: 3,
        displayName: "Studio Mac",
        platform: "darwin",
        environmentKind: "native",
        capabilities: ["account-bound-host-pairing.v1"],
        appVersion: "0.1.0",
        lastSeenAt: "2026-09-03T00:00:00Z",
      },
      devices: [],
      activePairing: null,
      lastError: null,
    },
  }),
}));

const { AccountTab, createOrganizationAttemptKey } = await import("./AccountTab");

afterEach(cleanup);

describe("account binding disclosure", () => {
  it("names every directory field and updates the editable machine name", async () => {
    render(<AccountTab />);

    for (const label of ["Host ID", "Public key", "Generation", "Display name", "Platform", "Environment", "Capability"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: /Studio Mac/ }));
    const input = screen.getByRole("textbox", { name: "Mac display name" });
    fireEvent.change(input, { target: { value: "Desk Mac" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Mac display name" }));
    await waitFor(() => expect(mocks.setHostName).toHaveBeenCalledWith("Desk Mac"));
  });

  it("keeps creation discoverable when an organization already exists", () => {
    mocks.organization = "Existing organization";
    render(<AccountTab />);
    expect(screen.getByRole("button", { name: "Create or switch organization" })).toBeTruthy();
    cleanup();
    mocks.organization = null;
  });

  it("scopes a second-organization retry key to its target name", () => {
    const first = createOrganizationAttemptKey("profile-a:7", "owner@example.test", "Existing");
    const second = createOrganizationAttemptKey("profile-a:7", "owner@example.test", "Second Org");
    expect(second).not.toBe(first);
    expect(createOrganizationAttemptKey("profile-a:7", "owner@example.test", " second   org ")).toBe(second);
  });
});
