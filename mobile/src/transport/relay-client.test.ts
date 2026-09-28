import { describe, expect, it } from "vitest";
import { atPairingStage } from "../pairing/errors";
import { RelayClient } from "./relay-client";

class FakeSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  binaryType = "";
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: unknown[] = [];

  send(value: unknown) { this.sent.push(value); }
  close() { this.readyState = 3; }
}

describe("direct E2EE transport", () => {
  it("starts the same v2 handshake without a plaintext relay credential", async () => {
    const socket = new FakeSocket();
    const client = new RelayClient({
      transport: "direct",
      endpoint: "ws://192.0.2.10:4040",
      deviceToken: "device-token",
      desktopPublicKeyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(4))),
      createSocket: () => socket as unknown as WebSocket,
    });

    const connecting = client.connect();
    socket.onopen?.();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(String(socket.sent[0]))).toMatchObject({
      type: "e2ee_hello",
      v: 2,
      context: { protocol: "terminalx-mobile-e2ee", transport: "direct" },
    });
    expect(String(socket.sent[0])).not.toContain("device-token");

    client.close();
    await expect(connecting).rejects.toThrow("Relay connection closed");
  });
  it("reports a rejected encrypted host response at the verification stage", async () => {
    const socket = new FakeSocket();
    const client = new RelayClient({ transport: "direct", endpoint: "ws://192.0.2.10:4040", deviceToken: "test-token",
      desktopPublicKeyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(4))),
      createSocket: () => socket as unknown as WebSocket,
    });
    const connecting = atPairingStage("transport", () => client.connect(), "direct");
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: "e2ee_ready", unexpected: "private data" }) });
    await expect(connecting).rejects.toMatchObject({ stage: "host-verification", category: "invalid-response", path: "direct" });
    expect(socket.readyState).toBe(3);
  });

});
