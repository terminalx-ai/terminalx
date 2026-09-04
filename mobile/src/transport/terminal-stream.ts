export interface TerminalStreamFrame {
  opcode: number;
  streamId: number;
  seq: number;
  payload: Uint8Array;
}

export function decodeTerminalFrame(bytes: Uint8Array): TerminalStreamFrame | null {
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opcode = view.getUint8(2);
  if (view.getUint8(0) !== 0x74 || view.getUint8(1) !== 1 || ![1, 2, 3, 4, 5, 6, 12].includes(opcode)) return null;
  const high = view.getUint32(8, true);
  const low = view.getUint32(12, true);
  return { opcode, streamId: view.getUint32(4, true), seq: high * 0x1_0000_0000 + low, payload: bytes.slice(16) };
}
