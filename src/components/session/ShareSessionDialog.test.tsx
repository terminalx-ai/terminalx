import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalShareButton, ShareSessionDialogHost } from "./ShareSessionDialog";
import { closeSessionShare, EMPTY_SHARE, openSessionShare, type ShareState } from "@/lib/localSharing";
import { getPrefs, setPrefs } from "@/lib/prefs";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), signedIn: true, sessions: [] as unknown[] }));
vi.mock("@/lib/sessions", async (original) => ({ ...(await original<typeof import("@/lib/sessions")>()), useSessionStore: () => ({ sessions: mocks.sessions }) }));
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
  // Most of these are about the link's settings: a host who has shared before, so Share opens on them.
  setPrefs({ shareOnboarded: true });
  mocks.sessions = [];
});
afterEach(() => {
  closeSessionShare();
  cleanup();
});
/** More settings folds away what is chosen now and then; a host opens it to reach those. */
const openMore = () => fireEvent.click(screen.getByRole("button", { name: "More settings" }));
const open = async () => {
  render(<ShareSessionDialogHost />);
  act(() => openSessionShare("local-session"));
  await screen.findByRole("button", { name: "Create share link" });
};
describe("Share session", () => {
  it("settles a tab in Bypass beside the link: says why, holds Create, and switches every agent tab", async () => {
    mocks.sessions = [{ id: "local-session", tabs: [{ id: "a", permissionMode: "bypassPermissions" }, { id: "b", permissionMode: "acceptEdits" }] }];
    render(<ShareSessionDialogHost />);
    act(() => openSessionShare("local-session"));
    expect((await screen.findByTestId("share-unguarded")).textContent).toContain("Bypass permissions");
    expect(screen.getByRole("button", { name: "Create share link" }).matches(":disabled")).toBe(true);
    const picker = screen.getByLabelText("Session permissions") as HTMLSelectElement;
    expect(picker.value).toBe("__mixed__");
    // Bypass is not offered while sharing.
    expect([...picker.options].filter((option) => !option.disabled).map((option) => option.value)).not.toContain("bypassPermissions");
    fireEvent.change(picker, { target: { value: "acceptEdits" } });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("set_tab_permission_mode", { sessionId: "local-session", tabId: "b", mode: "acceptEdits" }));
    expect(mocks.invoke).toHaveBeenCalledWith("set_tab_permission_mode", { sessionId: "local-session", tabId: "a", mode: "acceptEdits" });
  });

  it("introduces sharing on the first share, and then opens on the link's settings with the introduction a click away", async () => {
    setPrefs({ shareOnboarded: false });
    render(<ShareSessionDialogHost />);
    act(() => openSessionShare("local-session"));
    const intro = await screen.findByTestId("share-intro");
    expect(intro.textContent).toContain("They see the transcript and terminal so far");
    expect(screen.getByTestId("collaboration-scene")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create share link" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByTestId("share-intro")).toBeNull();
    expect(screen.queryByTestId("collaboration-scene")).toBeNull();
    // Making the first link marks the host as introduced.
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await waitFor(() => expect(getPrefs().shareOnboarded).toBe(true));
    // How sharing works brings the introduction back, and Back to sharing returns.
    fireEvent.click(screen.getByRole("button", { name: "How sharing works" }));
    expect(await screen.findByTestId("share-intro")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to sharing" }));
    expect(screen.getByRole("button", { name: "Create share link" })).toBeTruthy();
  });

  it("creates a read-only link that admits each person only once approved, with a finite expiry (PRO-162)", async () => {
    await open();
    // Limits are off until chosen: no people field until Limit people is on.
    expect(screen.getByRole("switch", { name: "Limit people", hidden: true }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByLabelText("Maximum people")).toBeNull();
    // A host who has shared before is not shown the introduction again, only offered it.
    expect(screen.queryByTestId("share-intro")).toBeNull();
    expect(screen.getByRole("button", { name: "How sharing works" })).toBeTruthy();
    // The form shows the defaults it will send.
    expect((screen.getByLabelText("Default access") as HTMLSelectElement).value).toBe("viewer");
    // Who, how and how long are out every time; the rest waits folded under More settings.
    const more = screen.getByTestId("share-more-settings");
    expect(more.getAttribute("data-state")).toBe("closed");
    expect(screen.getByRole("button", { name: "More settings" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("switch", { name: "Approve each person" })).toBeNull();
    openMore();
    expect(more.getAttribute("data-state")).toBe("open");
    expect(more.contains(screen.getByRole("switch", { name: "Approve each person" }))).toBe(true);
    expect(more.contains(screen.getByLabelText("Who can join"))).toBe(false);
    expect(screen.getByRole("switch", { name: "Approve each person" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Guests may approve permissions" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "session_share_create",
        expect.objectContaining({
          sessionId: "local-session",
          directOnly: true,
          settings: expect.objectContaining({
            audience: "anyone",
            role: "viewer",
            approveEachPerson: true,
            canApprove: false,
            // No limit chosen: as many as the host takes.
            maximumPeople: 32,
            singleUse: false,
          }),
        }),
      ),
    );
    const settings = mocks.invoke.mock.calls.find(([command]) => command === "session_share_create")![1].settings;
    expect(settings.expiresAt).toBeGreaterThan(Date.now());
    // Finite (PRO-162): as long as the host allows, never past its 24 hours.
    expect(settings.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
    expect(settings.expiresAt).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });
  it("sends per-account roles and the separate permission grant chosen by the host", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Who can join"), { target: { value: "people" } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    fireEvent.change(screen.getByLabelText("Account email 1"), { target: { value: "guest@example.com" } });
    fireEvent.change(screen.getByLabelText("Access for account 1"), { target: { value: "viewer" } });
    openMore();
    fireEvent.click(screen.getByRole("switch", { name: "Guests may approve permissions" }));
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
  it("lets the host make a driver link that admits people unasked, and starts the next link from the defaults again", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Default access"), { target: { value: "driver" } });
    openMore();
    fireEvent.click(screen.getByRole("switch", { name: "Approve each person" }));
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "session_share_create",
        expect.objectContaining({ settings: expect.objectContaining({ role: "driver", approveEachPerson: false }) }),
      ),
    );
    await waitFor(() => expect((screen.getByLabelText("Default access") as HTMLSelectElement).value).toBe("viewer"));
    expect(screen.getByRole("switch", { name: "Approve each person" }).getAttribute("aria-checked")).toBe("true");
  });
  it("shows on the session's Share button who waits to be admitted, not only inside Share (PRO-162)", async () => {
    const guest = (userId: string, displayName: string, admitted: boolean): ShareState["people"][number] => ({
      person: { userId, displayName, email: `${userId}@example.com`, emailVerified: true },
      role: "viewer", canApprove: false, admitted, connections: 1, viewing: [], typing: false, linkIds: ["link-1"],
    });
    mocks.invoke.mockResolvedValue({ ...EMPTY_SHARE, active: true, people: [guest("ana", "Ana", true), guest("kim", "Kim", false)] });
    render(<LocalShareButton sessionId="waiting-session" />);
    const button = screen.getByRole("button", { name: "Share session…" });
    await waitFor(() => expect(screen.getByTestId("share-waiting").textContent).toBe("· 1 waiting"));
    // Kim is not a guest yet: the count is of admitted people, and Kim is said apart from it.
    expect(button.textContent).toContain("1 guests");
    expect(button.getAttribute("title")).toBe("Ana · Kim is waiting to join");
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("1 waiting");
    cleanup();

    mocks.invoke.mockResolvedValue({ ...EMPTY_SHARE, active: true, people: [guest("ana", "Ana", true), guest("kim", "Kim", true)] });
    render(<LocalShareButton sessionId="admitted-session" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Share session…" }).textContent).toContain("2 guests"));
    expect(screen.queryByTestId("share-waiting")).toBeNull();
    expect(screen.getByRole("button", { name: "Share session…" }).hasAttribute("aria-describedby")).toBe(false);
  });
  it("requires sign-in before offering to create a link", async () => {
    mocks.signedIn = false;
    render(<ShareSessionDialogHost />);
    act(() => openSessionShare("signed-out-session"));
    expect(await screen.findByRole("button", { name: "Sign in to share" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create share link" })).toBeNull();
  });
  it("does not repeat the server's sign-in refusal as an error while signed out", async () => {
    mocks.signedIn = false;
    mocks.invoke.mockRejectedValue("Sign in to share a session.");
    render(<ShareSessionDialogHost />);
    act(() => openSessionShare("signed-out-session"));
    expect(await screen.findByTestId("share-sign-in")).toBeTruthy();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
