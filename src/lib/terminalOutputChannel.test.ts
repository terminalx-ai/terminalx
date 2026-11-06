import { expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), channels: [] as { onmessage: (data: ArrayBuffer) => void }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mock.invoke,
  Channel: class { onmessage = (_data: ArrayBuffer) => {}; constructor() { mock.channels.push(this); } },
}));
import { pty } from "./api";

it("decodes local output dimensions without counting the header as PTY bytes", async () => {
  const data = vi.fn();
  await pty.attachSized("pane", "view", data);
  expect(mock.invoke).toHaveBeenCalledWith("pty_attach_sized", expect.objectContaining({ id: "pane", token: "view" }));
  const channel = mock.channels.at(-1)!;
  const frame = new ArrayBuffer(7);
  new DataView(frame).setUint16(0, 300, true);
  new DataView(frame).setUint16(2, 12, true);
  new Uint8Array(frame, 4).set([0, 255, 27]);
  channel.onmessage(frame);
  expect(data).toHaveBeenLastCalledWith(new Uint8Array([0, 255, 27]), { cols: 300, rows: 12 });
  channel.onmessage(new Uint8Array([0, 0, 0, 0, 65]).buffer);
  expect(data).toHaveBeenLastCalledWith(new Uint8Array([65]), undefined);
  channel.onmessage(new ArrayBuffer(2));
  expect(data).toHaveBeenCalledTimes(2);
  const completion = new ArrayBuffer(4);
  new DataView(completion).setUint16(0, 30, true);
  new DataView(completion).setUint16(2, 8, true);
  channel.onmessage(completion);
  expect(data).toHaveBeenLastCalledWith(new Uint8Array(), { cols: 30, rows: 8 });
});
