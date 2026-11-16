import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalShareButton, ShareSessionDialogHost } from "./ShareSessionDialog";
import { closeSessionShare, defaultShareSettings, EMPTY_SHARE, openSessionShare, type ShareLink, type ShareState } from "@/lib/localSharing";
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
/** The choice a segmented setting shows as made. */
const checked = (group: string) => within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { checked: true }).textContent;
const open = async () => {
  render(<ShareSessionDialogHost />);
  act(() => openSessionShare("local-session"));
  await screen.findByRole("button", { name: "Create share link" });
};
describe("Share session", () => {
  it("warns of a tab in Bypass beside the link, leaves sharing to the host, and switches every agent tab", async () => {
    mocks.sessions = [{ id: "local-session", tabs: [{ id: "a", permissionMode: "bypassPermissions" }, { id: "b", permissionMode: "acceptEdits" }] }];
    render(<ShareSessionDialogHost />);
    act(() => openSessionShare("local-session"));
    expect((await screen.findByTestId("share-unguarded")).textContent).toContain("Bypass is on");
    // The host decides, with one more click: the first turns Create into a confirmation, the second shares.
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    expect(mocks.invoke).not.toHaveBeenCalledWith("session_share_create", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Share in Bypass anyway" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("session_share_create", expect.anything()));
    const picker = screen.getByLabelText("Session permissions") as HTMLSelectElement;
    expect(picker.value).toBe("__mixed__");
    // Every mode is offered, Bypass too.
    expect([...picker.options].filter((option) => !option.disabled).map((option) => option.value)).toContain("bypassPermissions");
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
    // A host who has shared before is not shown the introduction again, only offered it.
    expect(screen.queryByTestId("share-intro")).toBeNull();
    expect(screen.getByRole("button", { name: "How sharing works" })).toBeTruthy();
    // Every setting is in view, none folded away, and the form shows the defaults it will send.
    expect(screen.queryByRole("button", { name: "More settings" })).toBeNull();
    expect(checked("Who can join")).toBe("Anyone signed in");
    expect(checked("Default access")).toBe("Read only");
    expect(checked("Link expires")).toBe("24 hours");
    expect((screen.getByLabelText("Maximum people") as HTMLInputElement).value).toBe("32");
    expect(screen.getByRole("switch", { name: "Approve each person" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Guests may approve permissions" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Single use" }).getAttribute("aria-checked")).toBe("false");
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
  it("makes a link that lasts the chosen time from now", async () => {
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "1 hour" }));
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("session_share_create", expect.anything()));
    const settings = mocks.invoke.mock.calls.find(([command]) => command === "session_share_create")![1].settings;
    expect(Math.abs(settings.expiresAt - (Date.now() + 3_600_000))).toBeLessThan(5_000);
  });
  it("sends per-account roles and the separate permission grant chosen by the host", async () => {
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "Only specific people" }));
    fireEvent.change(screen.getByLabelText("Account email 1"), { target: { value: "guest@example.com" } });
    fireEvent.change(screen.getByLabelText("Access for account 1"), { target: { value: "viewer" } });
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
  it("shows a made link's real expiry, people limit and options, and saves only what the host changed (PRO-390)", async () => {
    const made = Date.now() - 30 * 60_000;
    const link: ShareLink = {
      id: "link-1",
      url: "https://console.terminalx.ai/join#secret",
      directOnly: false,
      revoked: false,
      credentialExpiresAt: made + 24 * 3_600_000,
      settings: { audience: "organization", role: "driver", people: [], expiresAt: made + 4 * 3_600_000, approveEachPerson: false, canApprove: true, maximumPeople: 5, singleUse: true },
    };
    mocks.invoke.mockResolvedValue({ ...EMPTY_SHARE, active: true, links: [link] });
    render(<ShareSessionDialogHost />);
    act(() => openSessionShare("local-session"));
    await screen.findByRole("button", { name: "Save settings" });
    await waitFor(() => expect(checked("Link expires")).toBe("4 hours"));
    expect(checked("Who can join")).toBe("Members of my organization");
    expect(checked("Default access")).toBe("Can drive");
    expect((screen.getByLabelText("Maximum people") as HTMLInputElement).value).toBe("5");
    expect(screen.getByRole("switch", { name: "Approve each person" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Guests may approve permissions" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Single use" }).getAttribute("aria-checked")).toBe("true");
    // Times that have already passed since the link was made are not offered.
    expect((screen.getByRole("radio", { name: "15 min" }) as HTMLButtonElement).disabled).toBe(true);
    // The link and its QR code are in view, with Copy link and Revoke only.
    expect((screen.getByLabelText("Secret share link") as HTMLInputElement).value).toBe(link.url);
    expect(await screen.findByAltText("Secret share link QR code")).toBeTruthy();
    expect(screen.getByTestId("share-link").textContent).toContain("Through TerminalX Relay, end-to-end encrypted.");
    expect(screen.queryByRole("button", { name: "Edit settings" })).toBeNull();
    // Nothing changed, nothing to save; a change saves the link's settings with only it changed.
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "1 hour" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("session_share_change", expect.objectContaining({ action: "edit" })));
    const sent = mocks.invoke.mock.calls.find(([command, args]) => command === "session_share_change" && args.action === "edit")![1].params;
    expect(sent.linkId).toBe("link-1");
    expect(sent.settings).toEqual({ ...link.settings, expiresAt: made + 3_600_000 });
  });
  it("lets the host answer whoever waits and choose each admitted person's access", async () => {
    const link: ShareLink = { id: "link-1", url: "https://console.terminalx.ai/join#secret", directOnly: false, revoked: false, settings: { ...defaultShareSettings(), role: "driver", maximumPeople: 5 } };
    const person = (userId: string, displayName: string, admitted: boolean, connections = 1): ShareState["people"][number] => ({
      person: { userId, displayName, email: `${userId}@example.com`, emailVerified: true },
      role: "viewer", canApprove: false, admitted, connections, viewing: [], typing: false, linkIds: ["link-1"], pendingLinkIds: admitted ? [] : ["link-1"],
    });
    mocks.invoke.mockResolvedValue({ ...EMPTY_SHARE, active: true, links: [link], people: [person("aisha", "Aisha Khan", false), person("sam", "Sam Rivera", true, 2)] });
    render(<ShareSessionDialogHost />);
    act(() => openSessionShare("local-session"));
    const rows = await screen.findAllByTestId("share-person");
    expect(rows[0].textContent).toContain("Waiting for approval · asked for Can drive");
    expect(rows[1].textContent).toContain("2 devices");
    expect(screen.getByRole("region", { name: "People" }).textContent).toContain("1 of 5");
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Let in" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("session_share_change", { sessionId: "local-session", action: "approve", params: { linkId: "link-1", userId: "aisha", allow: true } }));
    fireEvent.change(within(rows[1]).getByLabelText("Access for Sam Rivera"), { target: { value: "driver" } });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("session_share_change", { sessionId: "local-session", action: "access", params: { linkId: "link-1", userId: "sam", role: "driver" } }));
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Remove Sam Rivera" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("session_share_change", { sessionId: "local-session", action: "remove", params: { linkId: "link-1", userId: "sam" } }));
  });
  it("makes another link beside a live one, and counts each link's own people against its limit", async () => {
    const make = (id: string, maximumPeople: number): ShareLink => ({ id, url: `https://console.terminalx.ai/join#${id}`, directOnly: false, revoked: false, settings: { ...defaultShareSettings(), maximumPeople } });
    const person = (userId: string, linkId: string): ShareState["people"][number] => ({
      person: { userId, displayName: userId, email: `${userId}@example.com`, emailVerified: true },
      role: "viewer", canApprove: false, admitted: true, connections: 1, viewing: [], typing: false, linkIds: [linkId], pendingLinkIds: [],
    });
    mocks.invoke.mockResolvedValue({ ...EMPTY_SHARE, active: true, links: [make("one", 5), make("two", 2)], people: [person("ana", "one"), person("kim", "one"), person("lee", "two")] });
    render(<ShareSessionDialogHost />);
    act(() => openSessionShare("local-session"));
    await screen.findByRole("button", { name: "Save settings" });
    // The newest link is shown, and only its one person counts against its 2.
    await waitFor(() => expect(screen.getByRole("region", { name: "People" }).textContent).toContain("1 of 2"));
    fireEvent.click(screen.getByRole("button", { name: /Show link 1/ }));
    await waitFor(() => expect(screen.getByRole("region", { name: "People" }).textContent).toContain("2 of 5"));
    // Another link opens the form for a new one, without revoking those live.
    fireEvent.click(screen.getByRole("button", { name: "Another link" }));
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("session_share_create", expect.anything()));
    expect(mocks.invoke).not.toHaveBeenCalledWith("session_share_change", expect.objectContaining({ action: "revoke" }));
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
    // The label stays Share, with whoever waits beside it; who is in is said on hover.
    expect(button.textContent).toBe("Share· 1 waiting");
    expect(button.getAttribute("title")).toBe("Ana · Kim is waiting to join");
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("1 waiting");
    cleanup();

    mocks.invoke.mockResolvedValue({ ...EMPTY_SHARE, active: true, people: [guest("ana", "Ana", true), guest("kim", "Kim", true)] });
    render(<LocalShareButton sessionId="admitted-session" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Share session…" }).getAttribute("title")).toBe("Ana · Kim"));
    expect(screen.getByRole("button", { name: "Share session…" }).textContent).toBe("Share");
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
