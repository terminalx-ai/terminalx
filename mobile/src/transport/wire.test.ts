import { describe, expect, it } from "vitest";
import { delivery, encodeFragments, FragmentAssembler, FRAGMENTED_MESSAGE_BYTES_LIMIT, isFragment, MessageTooLargeError, RELAY_MESSAGE_BYTES_LIMIT, textPlaintextLimit } from "./wire";

const E2EE_FRAME_OVERHEAD = 82;

describe("transport limits", () => {
  it("keep one sealed, base64 encoded text frame inside the relay cell's limit", () => {
    for (const transport of ["relay", "direct"] as const) {
      const sealed = textPlaintextLimit(transport) + E2EE_FRAME_OVERHEAD;
      const encoded = Math.ceil(sealed / 3) * 4;
      expect(encoded).toBeLessThanOrEqual(transport === "relay" ? RELAY_MESSAGE_BYTES_LIMIT : 10 * 1024 * 1024);
    }
    // A 5 MB attachment still crosses a direct connection in one frame, as it always has.
    expect(delivery("direct", Math.ceil(5 * 1024 * 1024 * 4 / 3) + 512, false)).toBe("frame");
    expect(delivery("relay", textPlaintextLimit("relay"), false)).toBe("frame");
    expect(delivery("relay", textPlaintextLimit("relay") + 1, false)).toBe("too-large");
    expect(delivery("relay", textPlaintextLimit("relay") + 1, true)).toBe("fragments");
    expect(delivery("relay", FRAGMENTED_MESSAGE_BYTES_LIMIT + 1, true)).toBe("too-large");
  });
});

describe("fragments", () => {
  it("use the desktop's layout: magic, version, length and offset little endian", () => {
    // The same bytes src-tauri/src/pairing/wire.rs writes for a 2,000,000 byte message over Relay.
    const fragments = encodeFragments(new Uint8Array(2_000_000), "relay");
    expect(fragments).toHaveLength(2);
    expect([...fragments[0]!.subarray(0, 12)]).toEqual([0x66, 1, 0, 0, 0x80, 0x84, 0x1e, 0x00, 0, 0, 0, 0]);
    expect([...fragments[1]!.subarray(0, 12)]).toEqual([0x66, 1, 0, 0, 0x80, 0x84, 0x1e, 0x00, 0xa2, 0xef, 0x0f, 0x00]);
    for (const fragment of fragments) expect(fragment.length + E2EE_FRAME_OVERHEAD).toBeLessThanOrEqual(RELAY_MESSAGE_BYTES_LIMIT);
  });

  it("rebuild the message, then the next one", () => {
    const message = Uint8Array.from({ length: 3 * RELAY_MESSAGE_BYTES_LIMIT + 17 }, (_, index) => index % 251);
    const assembler = new FragmentAssembler();
    const fragments = encodeFragments(message, "relay");
    expect(fragments).toHaveLength(4);
    fragments.forEach((fragment, index) => {
      expect(isFragment(fragment)).toBe(true);
      const rebuilt = assembler.push(fragment);
      if (index < fragments.length - 1) expect(rebuilt).toBeNull();
      else expect(rebuilt && Buffer.from(rebuilt).equals(Buffer.from(message))).toBe(true);
    });
    const next = new TextEncoder().encode('{"id":"next"}');
    expect([...assembler.push(encodeFragments(next, "relay")[0]!)!]).toEqual([...next]);
  });

  it("refuse parts out of order, larger than any message, or malformed", () => {
    const fragments = encodeFragments(new Uint8Array(2_500_000), "relay");
    expect(() => new FragmentAssembler().push(fragments[1]!)).toThrow("out of order");
    const repeated = new FragmentAssembler();
    repeated.push(fragments[0]!);
    expect(() => repeated.push(fragments[0]!)).toThrow("out of order");
    const skipped = new FragmentAssembler();
    skipped.push(fragments[0]!);
    expect(() => skipped.push(fragments[2]!)).toThrow("out of order");
    const huge = fragments[0]!.slice();
    new DataView(huge.buffer).setUint32(4, FRAGMENTED_MESSAGE_BYTES_LIMIT + 1, true);
    expect(() => new FragmentAssembler().push(huge)).toThrow("too large");
    const short = fragments[0]!.slice();
    new DataView(short.buffer).setUint32(4, 8, true);
    expect(() => new FragmentAssembler().push(short)).toThrow("runs past");
    const version = fragments[0]!.slice();
    version[1] = 2;
    expect(() => new FragmentAssembler().push(version)).toThrow("Malformed");
    expect(() => new FragmentAssembler().push(fragments[0]!.subarray(0, 12))).toThrow("Malformed");
    // A terminal stream frame is not a fragment.
    expect(isFragment(Uint8Array.of(0x74, 1, 1, 0))).toBe(false);
  });
});

it("says how large a refused message was, and what to do", () => {
  expect(new MessageTooLargeError("relay", 2_300_000, false).message).toBe(
    "This is too large to send over Relay (2.3 MB; the limit is 0.8 MB). Update TerminalX on your Mac, or send it on the same Wi-Fi as your Mac.",
  );
  expect(new MessageTooLargeError("relay", 11_000_000, true).message).toBe(
    "This is too large to send over Relay (11.0 MB; the limit is 10.5 MB). Send less at once.",
  );
});
