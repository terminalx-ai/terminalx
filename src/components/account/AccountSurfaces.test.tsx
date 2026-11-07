import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const { SignInLinkDialog } = await import("@/components/account/PasteSignInLink");

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
    expect(screen.getByText(/QR and code pairings keep working/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm sign out" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_sign_out"));
  });

  it("finishes a sign-in from a pasted link when the browser's button cannot open the app", async () => {
    mocks.invoke.mockClear();
    let refuse = true;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_status") return signedOut;
      if (command === "account_sign_in") return signingIn;
      if (command === "account_paste_callback") { if (refuse) throw "That link belongs to another sign-in. Start signing in again, then paste the new link."; return null; }
      throw new Error(`Unexpected command: ${command}`);
    });
    await act(async () => bootAccount());
    render(<><AccountSidebarEntry onOpenAccount={() => {}} /><SignInLinkDialog /></>);
    expect(screen.queryByTestId("paste-sign-in-link")).toBeNull();
    // In the dev app, Sign in opens the browser and, with it, a dialog asking for the browser's link.
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const dialog = await screen.findByRole("dialog", { name: "Finish signing in" });
    const field = within(dialog).getByLabelText("Sign-in link");
    // Put away, the sidebar brings it back for the same sign-in rather than starting another.
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Finish signing in" }));
    await screen.findByRole("dialog", { name: "Finish signing in" });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "account_sign_in")).toHaveLength(1);
    void field;
    const link = "terminalx-dev://auth/callback?code=abc&state=xyz";

    fireEvent.change(screen.getByLabelText("Sign-in link"), { target: { value: link } });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That link belongs to another sign-in. Start signing in again, then paste the new link.");

    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("account_paste_callback", { link }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await act(async () => mocks.onStatus?.({ payload: signedIn }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
