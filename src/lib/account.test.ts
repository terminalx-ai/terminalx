import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));

const signedIn = (cloud: boolean, activeOrg = "org-a") => ({
  state: "signed-in",
  identity: { name: "A", email: "a@example.com", organization: activeOrg, organizationId: activeOrg },
  expiresAt: null,
  lastError: null,
  context: { scope: "s", revision: "s:1" },
  organizations: [{ id: "org-a", name: "Acme", role: "owner", isPersonal: false, ...(cloud ? { cloud: { enabled: true, flags: {} } } : {}) }],
});

describe("account status after a silent token refresh", () => {
  it("takes the native announcement, and re-reads the status on window focus", async () => {
    mocks.invoke.mockResolvedValue(signedIn(false));
    const account = await import("./account");
    await account.bootAccount();
    expect(account.getAccount().status.organizations?.[0].cloud).toBeUndefined();

    // The native side refreshed the token and announces the new organizations.
    mocks.listeners.get("account_status")!({ payload: signedIn(true) });
    expect(account.getAccount().status.organizations?.[0].cloud?.enabled).toBe(true);

    // A missed announcement is caught on focus: the status is read again.
    mocks.invoke.mockClear().mockResolvedValue(signedIn(true, "org-b"));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(account.getAccount().status.identity?.organizationId).toBe("org-b"));
    expect(mocks.invoke.mock.calls[0][0]).toBe("account_status");
  });
});
