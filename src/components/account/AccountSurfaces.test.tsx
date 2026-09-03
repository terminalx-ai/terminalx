import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";

const signedOut: AccountStatus = {
  state: "signed-out",
  identity: null,
  expiresAt: null,
  lastError: null,
};
const signingIn: AccountStatus = { ...signedOut, state: "signing-in" };
const signedIn: AccountStatus = {
  state: "signed-in",
  identity: { name: "Paresh", email: "owner@terminalx.ai", organization: "TerminalX" },
  expiresAt: Date.now() + 3_600_000,
  lastError: null,
};

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  onStatus: null as ((event: { payload: AccountStatus }) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: AccountStatus }) => void) => {
    mocks.onStatus = handler;
    return () => {};
  }),
}));

const { bootAccount } = await import("@/lib/account");
const { AccountSidebarEntry } = await import("./AccountSidebarEntry");
const { AccountTab } = await import("@/components/settings/AccountTab");

afterEach(cleanup);

describe("TerminalX account surfaces", () => {
  it("signs in from the sidebar and shows the session identity in Settings", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_status") return signedOut;
      if (command === "account_sign_in") return signingIn;
      if (command === "account_sign_out") return signedOut;
      throw new Error(`Unexpected command: ${command}`);
    });
    await act(async () => bootAccount());
    const openAccount = vi.fn();
    render(
      <>
        <AccountSidebarEntry onOpenAccount={openAccount} />
        <AccountTab />
      </>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Sign in" })[0]);
    await screen.findByRole("button", { name: "Finish signing in" });
    expect(mocks.invoke).toHaveBeenCalledWith("account_sign_in");

    await act(async () => mocks.onStatus?.({ payload: signedIn }));
    expect(screen.getAllByText("Paresh")).toHaveLength(2);
    expect(screen.getByText("owner@terminalx.ai")).toBeTruthy();
    expect(screen.getByText("TerminalX")).toBeTruthy();

    fireEvent.click(screen.getAllByText("Paresh")[0]);
    expect(openAccount).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_sign_out"));
  });
});
