import { describe, expect, it, vi } from "vitest";
import { PortableRpcClient, type RpcResponse, type RpcTransport } from "./rpc";

describe("portable RPC refusal handling", () => {
  it("resolves a refused method as protocol data", async () => {
    let receive: ((response: RpcResponse) => void) | undefined;
    const send = vi.fn((request: { id: string }) => {
      queueMicrotask(() => receive?.({ id: request.id, ok: false, error: { code: "method_not_found", message: "Not supported" } }));
      return true;
    });
    const transport: RpcTransport = { send, subscribe: (listener) => { receive = listener; return () => { receive = undefined; }; } };
    const client = new PortableRpcClient(transport);
    await expect(client.request("future.method")).resolves.toEqual({ ok: false, refusal: { code: "method_not_found", message: "Not supported" } });
    client.close();
  });
});
