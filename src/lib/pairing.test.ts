import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PairingStatus } from "@/types/pairing";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const base: PairingStatus = {
  relay: { phase: "connected", message: null, attempt: 0 },
  host: null,
  devices: [],
  activePairing: null,
  pendingApproval: null,
  keepAwake: true,
  lastError: null,
};

let pairing: typeof import("./pairing");
const current = () => pairing.getPairing();

beforeEach(async () => {
  vi.resetModules();
  mocks.invoke.mockReset();
  pairing = await import("./pairing");
});

describe("pairing store commands", () => {
  it.each([
    ["approvePairing", "pairing_approve", { requestId: "req-1" }],
    ["declinePairing", "pairing_decline", { requestId: "req-1" }],
    ["disconnectDevice", "pairing_disconnect", { deviceId: "phone-1" }],
  ] as const)("%s calls %s and applies the status it returns", async (action, command, args) => {
    const next = { ...base, lastError: null, keepAwake: false };
    mocks.invoke.mockResolvedValue(next);
    await pairing[action](Object.values(args)[0]);
    expect(mocks.invoke).toHaveBeenCalledWith(command, args);
    expect(current().status).toEqual(next);
    expect(current().busy).toBe(false);
  });

  it("keeps a failed command's message as the last error", async () => {
    mocks.invoke.mockRejectedValue(new Error("The request has expired."));
    await pairing.approvePairing("req-1");
    expect(current().status.lastError).toBe("The request has expired.");
    expect(current().busy).toBe(false);
  });

  it("moves keep-awake at once and puts it back when the Mac refuses", async () => {
    let answer!: (status: PairingStatus) => void;
    mocks.invoke.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const pending = pairing.setKeepAwake(false);
    expect(current().status.keepAwake).toBe(false);
    answer({ ...base, keepAwake: false });
    await pending;
    expect(mocks.invoke).toHaveBeenCalledWith("pairing_set_keep_awake", { enabled: false });
    expect(current().status.keepAwake).toBe(false);

    mocks.invoke.mockRejectedValueOnce(new Error("Could not save"));
    await pairing.setKeepAwake(true);
    expect(current().status.keepAwake).toBe(false);
    expect(current().status.lastError).toBe("Could not save");
  });

  it("opens and closes the dialog", () => {
    expect(current().dialogOpen).toBe(false);
    pairing.openPairPhone();
    expect(current().dialogOpen).toBe(true);
    pairing.closePairPhone();
    expect(current().dialogOpen).toBe(false);
  });
});
