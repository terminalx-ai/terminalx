import { describe, expect, it } from "vitest";
import { decodeTerminalFrame } from "./terminal-stream";

describe("terminal binary stream contract", () => {
  it("uses the legacy 16-byte little-endian header", () => {
    const bytes = new Uint8Array(19);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, 0x74);
    view.setUint8(1, 1);
    view.setUint8(2, 1);
    view.setUint32(4, 42, true);
    view.setUint32(8, 1, true);
    view.setUint32(12, 7, true);
    bytes.set(new TextEncoder().encode("ok\n"), 16);
    const frame = decodeTerminalFrame(bytes);
    expect(frame && { ...frame, payload: new TextDecoder().decode(frame.payload) }).toEqual({ opcode: 1, streamId: 42, seq: 0x1_0000_0007, payload: "ok\n" });
    bytes[0] = 0x75;
    expect(decodeTerminalFrame(bytes)).toBeNull();
  });
});
