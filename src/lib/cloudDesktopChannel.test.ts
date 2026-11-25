import { describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState, WorkspaceNotification } from "@terminalx/portable/workspace";
import { CloudDesktopChannel } from "./cloudDesktopChannel";

function fixture() {
  const connected: WorkspaceConnectionState = {
    state: "connected", runtimeGeneration: 3, runtimeVersion: "1", capabilities: ["cloud-desktop/1"],
    authority: "participate", link: 1,
  };
  let notify!: (value: WorkspaceNotification) => void;
  let stateChange!: (value: WorkspaceConnectionState) => void;
  let opened!: (result: unknown) => void;
  const call = vi.fn((method: string) => method === "desktop.open"
    ? new Promise((resolve) => { opened = resolve; })
    : Promise.resolve({}));
  const stop = vi.fn();
  const client = {
    call,
    connection: connected,
    onNotification(listener: typeof notify) { notify = listener; return stop; },
    onState(listener: typeof stateChange) { stateChange = listener; return stop; },
  } as unknown as ConstructorParameters<typeof CloudDesktopChannel>[0];
  return {
    client, call, stop,
    open: () => opened({ streamId: "desktop-1", window: 8, maxWriteBytes: 4 }),
    notify: (event: string, params: Record<string, unknown>) => notify({ event, params }),
    reconnect: () => stateChange({ ...connected, link: 2 }),
  };
}

describe("CloudDesktopChannel", () => {
  it("delivers the open event before buffered RFB data and acknowledges only its own stream", async () => {
    const f = fixture();
    const channel = new CloudDesktopChannel(f.client, false);
    const order: string[] = [];
    channel.onopen = () => order.push("open");
    channel.onmessage = ({ data }) => order.push(new TextDecoder().decode(data));
    f.notify("desktop.data", { streamId: "desktop-2", data: btoa("other") });
    f.notify("desktop.data", { streamId: "desktop-1", data: btoa("RFB") });
    f.open();
    await vi.waitFor(() => expect(order).toEqual(["open", "RFB"]));
    expect(f.call.mock.calls).toEqual([
      ["desktop.open", { control: false }],
      ["desktop.ack", { streamId: "desktop-1", bytes: 3 }],
    ]);
    channel.close();
    expect(f.call).toHaveBeenLastCalledWith("desktop.close", { streamId: "desktop-1" });
    expect(f.stop).toHaveBeenCalledTimes(2);
  });

  it("chunks the write window and never addresses an old stream on a replacement link", async () => {
    const f = fixture();
    const channel = new CloudDesktopChannel(f.client, true);
    f.open();
    await vi.waitFor(() => expect(channel.readyState).toBe("open"));
    channel.send(new Uint8Array([1, 2, 3, 4, 5]));
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(3));
    expect(f.call).toHaveBeenNthCalledWith(2, "desktop.write", { streamId: "desktop-1", data: "AQIDBA==" });
    expect(f.call).toHaveBeenNthCalledWith(3, "desktop.write", { streamId: "desktop-1", data: "BQ==" });
    f.reconnect();
    channel.send(new Uint8Array([6]));
    await vi.waitFor(() => expect(channel.readyState).toBe("closed"));
    expect(f.call).toHaveBeenCalledTimes(3);
  });
});
