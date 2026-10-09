import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PortableRpcClient, type RpcResponse } from "@terminalx/portable/rpc";

export class SessionGuestClient {
  private listeners = new Set<(response: RpcResponse) => void>();
  private events = new Set<(method: string, params: unknown) => void>();
  private unlisten: (() => void)[] = [];
  private readonly rpc: PortableRpcClient;
  private constructor(
    readonly sessionId: string,
    readonly connectionId: string,
  ) {
    this.rpc = new PortableRpcClient({
      send: (request) => {
        void invoke("session_guest_send", {
          connectionId: this.connectionId,
          request: { ...request, params: { ...(request.params as object), sessionId } },
        }).catch((error: unknown) => {
          const response: RpcResponse = {
            id: request.id,
            ok: false,
            error: { code: "disconnected", message: String(error) },
          };
          for (const callback of this.listeners) callback(response);
        });
        return true;
      },
      subscribe: (callback) => {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
      },
    });
  }
  static async join(link: string, closed: (reason: string) => void) {
    // Listen before connecting, so approval/events arriving with the first
    // reply cannot be lost between the native connection and its view.
    let client: SessionGuestClient | null = null;
    const earlyClosures = new Map<string, string>();
    const messages = await listen<{ connectionId: string; message: RpcResponse | { method: string; params: unknown } }>(
      "session_guest_message",
      ({ payload }) => {
        if (!client || payload.connectionId !== client.connectionId) return;
        if ("method" in payload.message) {
          for (const callback of client.events) callback(payload.message.method, payload.message.params);
        } else {
          for (const callback of client.listeners) callback(payload.message);
        }
      },
    );
    const ended = await listen<{ connectionId: string; message: string }>("session_guest_closed", ({ payload }) => {
      if (!client) {
        earlyClosures.set(payload.connectionId, payload.message);
        return;
      }
      if (payload.connectionId === client.connectionId) {
        client.rpc.close(payload.message);
        closed(payload.message);
      }
    });
    try {
      const result = await invoke<{ sessionId: string; connectionId: string; admitted: boolean }>(
        "session_guest_join",
        { link },
      );
      const earlyClosure = earlyClosures.get(result.connectionId);
      if (earlyClosure) throw new Error(earlyClosure);
      client = new SessionGuestClient(result.sessionId, result.connectionId);
      client.unlisten = [messages, ended];
      return client;
    } catch (error) {
      messages();
      ended();
      throw error;
    }
  }
  async request<T>(method: string, params: object = {}): Promise<T> {
    const result = await this.rpc.request<T>(method, params);
    if (!result.ok) throw new Error(result.refusal.message);
    return result.value;
  }
  subscribe(callback: (method: string, params: unknown) => void) {
    this.events.add(callback);
    return () => this.events.delete(callback);
  }
  close() {
    this.rpc.close();
    for (const unlisten of this.unlisten) unlisten();
    void invoke("session_guest_leave", { connectionId: this.connectionId });
  }
}
