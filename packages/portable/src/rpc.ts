export interface RpcErrorData {
  code: string;
  message: string;
  data?: unknown;
}

export type RpcResponse<T = unknown> =
  | { id: string; ok: true; result: T }
  | { id: string; ok: false; error: RpcErrorData };

export interface RpcWireRequest {
  id: string;
  method: string;
  params?: unknown;
}

export interface RpcTransport {
  send(request: RpcWireRequest): boolean;
  subscribe(listener: (response: RpcResponse) => void): () => void;
}

export type RpcCallResult<T> = { ok: true; value: T } | { ok: false; refusal: RpcErrorData };

export class PortableRpcClient {
  private nextRequest = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: RpcCallResult<unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly transport: RpcTransport,
    private readonly timeoutMs = 30_000,
  ) {
    this.unsubscribe = transport.subscribe((response) => this.receive(response));
  }

  request<T>(method: string, params?: unknown): Promise<RpcCallResult<T>> {
    const id = `rpc-${Date.now()}-${++this.nextRequest}`;
    return new Promise<RpcCallResult<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as RpcCallResult<T>), reject, timer });
      if (!this.transport.send({ id, method, ...(params === undefined ? {} : { params }) })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`RPC transport unavailable: ${method}`));
      }
    });
  }

  close(reason = "RPC client closed"): void {
    this.unsubscribe();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private receive(response: RpcResponse): void {
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.ok) request.resolve({ ok: true, value: response.result });
    else request.resolve({ ok: false, refusal: response.error });
  }
}
