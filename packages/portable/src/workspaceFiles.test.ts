import { describe, expect, it } from "vitest";
import type { RpcWireRequest } from "./rpc";
import { WorkspaceRpcClient, type WorkspaceConnectionState, type WorkspaceTransport } from "./workspace";
import { FS_PART_BYTES, readRemoteFile, remotePath, searchRemote, writeRemoteFile } from "./workspaceFiles";

const connected: WorkspaceConnectionState = {
  state: "connected",
  runtimeGeneration: 1,
  runtimeEpoch: "e1",
  runtimeVersion: "0.3.0",
  capabilities: ["fs/1"],
  authority: "manage",
};

type Handler = (params: Record<string, unknown>) => unknown;

/** A runtime answering fs/1 from handlers; `hold` keeps answers back until released. */
class FakeRuntime implements WorkspaceTransport {
  sent: RpcWireRequest[] = [];
  held: (() => void)[] = [];
  hold = new Set<string>();
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();

  constructor(private handlers: Record<string, Handler>) {}

  send(frame: RpcWireRequest): boolean {
    this.sent.push(frame);
    const reply = () => {
      try {
        const result = this.handlers[frame.method]?.((frame.params ?? {}) as Record<string, unknown>);
        this.deliver({ id: frame.id, ok: true, result: result ?? {} });
      } catch (error) {
        const code = (error as { code?: string }).code ?? "internal";
        this.deliver({ id: frame.id, ok: false, error: { code, message: String(error) } });
      }
    };
    if (this.hold.has(frame.method)) this.held.push(reply);
    else queueMicrotask(reply);
    return true;
  }
  onMessage(listener: (message: unknown) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onState(listener: (state: WorkspaceConnectionState) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
  close() {}
  setState(state: WorkspaceConnectionState) {
    for (const listener of this.states) listener(state);
  }
  deliver(message: unknown) {
    for (const listener of this.messages) listener(message);
  }
  calls(method: string) {
    return this.sent.filter((frame) => frame.method === method).map((frame) => frame.params as Record<string, unknown>);
  }
}

function connect(handlers: Record<string, Handler>) {
  const runtime = new FakeRuntime(handlers);
  const client = new WorkspaceRpcClient(runtime);
  runtime.setState(connected);
  return { runtime, client };
}

const refusal = (code: string) => Object.assign(new Error(code), { code });

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** fs.read over `content`, parted like the runtime; `version` changes when `bump` is called. */
function partedFile(content: Uint8Array) {
  const state = { version: "v1", content };
  const read: Handler = (params) => {
    if (params.version && params.version !== state.version) throw refusal("conflict");
    const offset = Number(params.offset ?? 0);
    const part = state.content.subarray(offset, offset + FS_PART_BYTES);
    const eof = offset + part.length >= state.content.length;
    return {
      path: params.path,
      size: state.content.length,
      version: state.version,
      offset,
      eof,
      ...(offset === 0 ? { etag: `etag-${state.version}`, binary: false } : {}),
      dataB64: base64(part),
    };
  };
  return { state, read };
}

describe("workspace files", () => {
  it("sends only workspace-relative paths", () => {
    expect(remotePath("src/./a.ts")).toBe("src/a.ts");
    expect(remotePath("")).toBe("");
    for (const bad of ["../x", "a/../../x", "/etc/hosts", "C:\\x", "\\\\server\\share"]) expect(() => remotePath(bad)).toThrow();
  });

  it("reads a large file part by part under one version, starting over once if it changes", async () => {
    const content = new Uint8Array(FS_PART_BYTES * 2 + 17).map((_, index) => 65 + (index % 26));
    const file = partedFile(content);
    let reads = 0;
    const { runtime, client } = connect({
      "fs.read": (params) => {
        reads++;
        // The file is rewritten while the second part is on its way, once.
        if (reads === 2) file.state.version = "v2";
        return file.read(params);
      },
    });
    const read = await readRemoteFile(client, "big.txt");
    expect(read.bytes).toEqual(content);
    expect(read.text?.length).toBe(content.length);
    expect(read.etag).toBe("etag-v2");
    const offsets = runtime.calls("fs.read").map((params) => params.offset ?? 0);
    expect(offsets).toEqual([0, FS_PART_BYTES, 0, FS_PART_BYTES, FS_PART_BYTES * 2]);
    expect(runtime.calls("fs.read").slice(3).every((params) => params.version === "v2")).toBe(true);
  });

  it("refuses a file larger than asked after its first part", async () => {
    const file = partedFile(new Uint8Array(FS_PART_BYTES * 3));
    const { runtime, client } = connect({ "fs.read": file.read });
    await expect(readRemoteFile(client, "a", { maxBytes: 100 })).rejects.toMatchObject({ code: "too_large" });
    expect(runtime.calls("fs.read")).toHaveLength(1);
    expect(runtime.calls("fs.stat")).toEqual([]);
  });

  it("keeps a byte order mark in a large file", async () => {
    const body = new Uint8Array(FS_PART_BYTES + 10).fill(97);
    body.set([0xef, 0xbb, 0xbf]);
    const { client } = connect({ "fs.read": partedFile(body).read });
    const read = await readRemoteFile(client, "bom.csv");
    expect(read.text?.charCodeAt(0)).toBe(0xfeff);
    const encoded = new TextEncoder().encode(read.text!);
    expect(encoded.length).toBe(body.length);
    expect(encoded.every((byte, index) => byte === body[index])).toBe(true);
  });

  it("does not decode non-UTF-8 content as text", async () => {
    const { client } = connect({
      "fs.read": () => ({ path: "l.txt", size: 2, version: "v", offset: 0, eof: true, etag: "e", binary: false, dataB64: base64(new Uint8Array([0xc3, 0x28])) }),
    });
    expect((await readRemoteFile(client, "l.txt")).text).toBeNull();
  });

  it("writes small text inline and stages large content before one conditional commit", async () => {
    const { runtime, client } = connect({
      "fs.writePart": (params) => ({ received: Number(params.offset) + atob(String(params.dataB64)).length }),
      "fs.write": (params) => ({ path: params.path, etag: "new", size: params.size ?? 1, version: "v2" }),
    });
    await writeRemoteFile(client, "a.txt", "hello", "old");
    expect(runtime.calls("fs.write")[0]).toMatchObject({ path: "a.txt", text: "hello", expectedEtag: "old" });

    const big = "x".repeat(FS_PART_BYTES * 2 + 5);
    await writeRemoteFile(client, "b.txt", big, "base");
    const parts = runtime.calls("fs.writePart");
    expect(parts.map((part) => part.offset)).toEqual([0, FS_PART_BYTES, FS_PART_BYTES * 2]);
    expect(new Set(parts.map((part) => part.uploadId)).size).toBe(1);
    expect(new Set(parts.map((part) => part.clientRequestId)).size).toBe(3);
    const commit = runtime.calls("fs.write")[1]!;
    expect(commit).toMatchObject({ path: "b.txt", uploadId: parts[0]!.uploadId, size: big.length, expectedEtag: "base" });
    expect(commit.text).toBeUndefined();

    // Null: the file must not exist yet; undefined: an explicit overwrite.
    await writeRemoteFile(client, "c.txt", "x", null);
    expect(runtime.calls("fs.write")[2]).toMatchObject({ expectedEtag: null });
    await writeRemoteFile(client, "d.txt", "x", undefined);
    expect("expectedEtag" in runtime.calls("fs.write")[3]!).toBe(false);
  });

  it("cancels a search on the runtime when the caller stops waiting", async () => {
    const { runtime, client } = connect({
      "fs.search": () => ({ hits: [{ path: "a", line: 1, col: 0, text: "late", matches: [[0, 4]] }], files: 1, capped: false, cancelled: true }),
      "fs.cancel": () => ({ cancelled: true }),
    });
    runtime.hold.add("fs.search");
    const controller = new AbortController();
    const pending = searchRemote(client, { query: "needle" }, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const searchId = runtime.calls("fs.search")[0]!.searchId;
    expect(runtime.calls("fs.cancel")).toEqual([{ searchId }]);
    // Its late answer is dropped.
    for (const reply of runtime.held) reply();
  });

  it("reports changes missed while disconnected as a full refresh", async () => {
    let subscriptions = 0;
    const { runtime, client } = connect({ "fs.watch": () => ({ subscriptionId: `sub-${++subscriptions}`, path: "" }) });
    const seen: (string[] | null)[] = [];
    await client.watchFiles("", (paths) => seen.push(paths));
    runtime.deliver({ event: "fs.changed", params: { subscriptionId: "sub-1", paths: ["a.txt"] } });
    runtime.setState({ state: "reconnecting", attempt: 1, reason: "1006", retryInMs: 250 });
    runtime.setState(connected);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.deliver({ event: "fs.changed", params: { subscriptionId: "sub-2", paths: ["b.txt"] } });
    runtime.deliver({ event: "fs.changed", params: { subscriptionId: "sub-2", paths: [], overflow: true } });
    expect(seen).toEqual([["a.txt"], null, ["b.txt"], null]);
  });
});
