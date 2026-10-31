/**
 * How much one connection to the Mac carries in a WebSocket message, and how a
 * larger message crosses it (#669). The format is shared with
 * src-tauri/src/pairing/wire.rs.
 *
 * The relay cell closes both legs of a connection on any message over its
 * `maxPayloadLength`, so one large request took every other request on the
 * connection down with it. Each message now either fits its connection or,
 * once the Mac has agreed to fragments, crosses as fragments. A message
 * neither can carry is refused here, before it is sent.
 *
 * A fragment is one binary E2EE frame, sealed on its own so the nonce counter
 * stays in order. Its plaintext is a 12 byte header, then that part of the
 * message: `0x66` (`f`; terminal stream frames start with `t`), version 1, two
 * zero bytes, the whole message's length and this part's offset in it, each
 * u32 little endian. One message's fragments are sent back to back, in order,
 * from offset 0; it is complete when a part ends at its length.
 */

export type WireTransport = "direct" | "relay";

/** The relay cell's `maxPayloadLength` (terminalx-server, apps/relay/src/cell/cell-server.ts). */
export const RELAY_MESSAGE_BYTES_LIMIT = 1024 * 1024;
/** The Mac's limit on one message from a phone (`PAIRING_MESSAGE_BYTES_LIMIT`). */
export const DIRECT_MESSAGE_BYTES_LIMIT = 10 * 1024 * 1024;
/** The largest message either side reassembles from fragments. */
export const FRAGMENTED_MESSAGE_BYTES_LIMIT = DIRECT_MESSAGE_BYTES_LIMIT;
export const FRAGMENTS_VERSION = 1;
/** Nonce, Poly1305 tag and the sealed header: session id, direction, kind and counter. */
const E2EE_FRAME_OVERHEAD = 24 + 16 + 32 + 1 + 1 + 8;
const FRAGMENT_MAGIC = 0x66;
const FRAGMENT_HEADER_BYTES = 12;
/** Headroom only: the receiver counts the payload, not the frame header. */
const WIRE_HEADROOM_BYTES = 4 * 1024;

const wireBudget = (transport: WireTransport) =>
  (transport === "relay" ? RELAY_MESSAGE_BYTES_LIMIT : DIRECT_MESSAGE_BYTES_LIMIT) - WIRE_HEADROOM_BYTES;

/** The largest plaintext that crosses as one text frame: sealed, then base64 encoded. */
export function textPlaintextLimit(transport: WireTransport): number {
  return Math.floor(wireBudget(transport) / 4) * 3 - E2EE_FRAME_OVERHEAD;
}

export type Delivery = "frame" | "fragments" | "too-large";

export function delivery(transport: WireTransport, plaintextBytes: number, fragments: boolean): Delivery {
  if (plaintextBytes <= textPlaintextLimit(transport)) return "frame";
  if (fragments && plaintextBytes <= FRAGMENTED_MESSAGE_BYTES_LIMIT) return "fragments";
  return "too-large";
}

export function encodeFragments(message: Uint8Array, transport: WireTransport): Uint8Array[] {
  const dataLimit = wireBudget(transport) - E2EE_FRAME_OVERHEAD - FRAGMENT_HEADER_BYTES;
  const fragments: Uint8Array[] = [];
  for (let offset = 0; offset < message.length; offset += dataLimit) {
    const data = message.subarray(offset, offset + dataLimit);
    const fragment = new Uint8Array(FRAGMENT_HEADER_BYTES + data.length);
    const view = new DataView(fragment.buffer);
    fragment[0] = FRAGMENT_MAGIC;
    fragment[1] = FRAGMENTS_VERSION;
    view.setUint32(4, message.length, true);
    view.setUint32(8, offset, true);
    fragment.set(data, FRAGMENT_HEADER_BYTES);
    fragments.push(fragment);
  }
  return fragments;
}

export const isFragment = (frame: Uint8Array) => frame[0] === FRAGMENT_MAGIC;

/** Rebuilds the messages the Mac sent as fragments. */
export class FragmentAssembler {
  private message: { bytes: Uint8Array; received: number } | null = null;

  /** One fragment's plaintext: the whole message once its last part arrives. A malformed or out of order part throws. */
  push(frame: Uint8Array): Uint8Array | null {
    if (frame.length <= FRAGMENT_HEADER_BYTES || frame[0] !== FRAGMENT_MAGIC || frame[1] !== FRAGMENTS_VERSION || frame[2] !== 0 || frame[3] !== 0) {
      throw new Error("Malformed message fragment");
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const total = view.getUint32(4, true);
    const offset = view.getUint32(8, true);
    const data = frame.subarray(FRAGMENT_HEADER_BYTES);
    if (total > FRAGMENTED_MESSAGE_BYTES_LIMIT) throw new Error("Fragmented message is too large");
    const current = this.message;
    this.message = null;
    let message: { bytes: Uint8Array; received: number };
    if (!current && offset === 0) message = { bytes: new Uint8Array(total), received: 0 };
    else if (current && offset !== 0 && current.bytes.length === total && current.received === offset) message = current;
    else throw new Error("Message fragment arrived out of order");
    if (offset + data.length > total) throw new Error("Message fragment runs past its message");
    message.bytes.set(data, offset);
    message.received += data.length;
    if (message.received === total) return message.bytes;
    this.message = message;
    return null;
  }
}

export const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** A request this phone did not send, because no connection to the Mac could carry it. */
export class MessageTooLargeError extends Error {
  constructor(transport: WireTransport, plaintextBytes: number, fragments: boolean) {
    const limit = fragments ? FRAGMENTED_MESSAGE_BYTES_LIMIT : textPlaintextLimit(transport);
    const route = transport === "relay" ? "over Relay" : "to your Mac";
    const advice = transport === "relay" && !fragments
      ? "Update TerminalX on your Mac, or send it on the same Wi-Fi as your Mac."
      : "Send less at once.";
    super(`This is too large to send ${route} (${megabytes(plaintextBytes)}; the limit is ${megabytes(limit)}). ${advice}`);
    this.name = "MessageTooLargeError";
  }
}
