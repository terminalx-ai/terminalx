import { describe, expect, it } from "vitest";
import { phoneNetwork } from "./network";

describe("phone network", () => {
  it("tells interfaces and Wi-Fi networks apart, and waits for the OS to say", () => {
    const home = phoneNetwork({ type: "wifi", isConnected: true, details: { ipAddress: "192.168.0.5" } } as never);
    const office = phoneNetwork({ type: "wifi", isConnected: true, details: { ipAddress: "10.1.2.3" } } as never);
    const cellular = phoneNetwork({ type: "cellular", isConnected: true, details: { cellularGeneration: "5g" } } as never);
    expect(home).toEqual({ key: "wifi:192.168.0.5", online: true, label: "wifi" });
    expect(office!.key).not.toBe(home!.key);
    expect(cellular).toEqual({ key: "cellular:", online: true, label: "cellular" });
    expect(phoneNetwork({ type: "none", isConnected: false, details: null } as never)).toEqual({ key: "offline", online: false, label: "offline" });
    expect(phoneNetwork({ type: "wifi", isConnected: false, details: { ipAddress: null } } as never)!.online).toBe(false);
    expect(phoneNetwork({ type: "unknown", isConnected: null, details: null } as never)).toBeNull();
  });
});
