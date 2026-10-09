import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareSessionDialogHost } from "./ShareSessionDialog";
import { closeSessionShare, EMPTY_SHARE, openSessionShare } from "@/lib/localSharing";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), signedIn: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: { state: mocks.signedIn ? "signed-in" : "signed-out" } }),
  signIn: vi.fn(),
}));
vi.mock("@/lib/pairing", () => ({ usePairing: () => ({ status: { relay: { phase: "offline" } } }) }));

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(EMPTY_SHARE);
  mocks.signedIn = true;
});
afterEach(() => {
  closeSessionShare();
  cleanup();
});
const open = async () => {
  render(<ShareSessionDialogHost />);
  act(() => openSessionShare("local-session"));
  await screen.findByRole("button", { name: "Create share link" });
};
describe("Share session", () => {
  it("creates signed-in driver access with permission approval explicitly off and a finite expiry", async () => {
    await open();
    expect(screen.getByText(/Guests can see the existing transcript/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "session_share_create",
        expect.objectContaining({
          sessionId: "local-session",
          directOnly: true,
          settings: expect.objectContaining({
            audience: "anyone",
            role: "driver",
            canApprove: false,
            maximumPeople: 8,
            singleUse: false,
          }),
        }),
      ),
    );
    const settings = mocks.invoke.mock.calls.find(([command]) => command === "session_share_create")![1].settings;
    expect(settings.expiresAt).toBeGreaterThan(Date.now());
    expect(settings.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });
  it("sends per-account roles and the separate permission grant chosen by the host", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Who can join"), { target: { value: "people" } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    fireEvent.change(screen.getByLabelText("Account email 1"), { target: { value: "guest@example.com" } });
    fireEvent.change(screen.getByLabelText("Access for account 1"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByLabelText("Guests may approve permissions"));
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "session_share_create",
        expect.objectContaining({
          settings: expect.objectContaining({
            audience: "people",
            people: [{ email: "guest@example.com", role: "viewer" }],
            canApprove: true,
          }),
        }),
      ),
    );
  });
  it("requires sign-in before offering to create a link", async () => {
    mocks.signedIn = false;
    render(<ShareSessionDialogHost />);
    act(() => openSessionShare("signed-out-session"));
    expect(await screen.findByRole("button", { name: "Sign in to share" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create share link" })).toBeNull();
  });
});
