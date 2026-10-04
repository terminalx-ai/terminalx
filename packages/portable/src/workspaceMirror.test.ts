import { describe, expect, it } from "vitest";
import type { RpcWireRequest } from "./rpc";
import { WorkspaceRpcClient, WorkspaceRpcError, type WorkspaceConnectionState, type WorkspaceTransport } from "./workspace";
import { MirrorManifestError, readMirrorManifest, type MirrorEntry } from "./workspaceMirror";

type Handler = (params: Record<string, unknown>) => unknown;

class FakeRuntime implements WorkspaceTransport {
  sent: RpcWireRequest[] = [];
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();

  constructor(private handler: Handler) {}

  send(frame: RpcWireRequest): boolean {
    this.sent.push(frame);
    queueMicrotask(() => {
      try {
        this.deliver({ id: frame.id, ok: true, result: this.handler((frame.params ?? {}) as Record<string, unknown>) });
      } catch (error) {
        this.deliver({ id: frame.id, ok: false, error: { code: (error as { code?: string }).code ?? "internal", message: String(error) } });
      }
    });
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
}

function connect(handler: Handler, capabilities: WorkspaceConnectionState["capabilities"] = ["fs/1", "mirror/1"]) {
  const runtime = new FakeRuntime(handler);
  const client = new WorkspaceRpcClient(runtime);
  runtime.setState({ state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.3.0", capabilities, authority: "participate" });
  return { runtime, client };
}

const entry = (path: string, version = "v1"): MirrorEntry => ({ path, size: 1, version, executable: false });
const skipped = { secret: 0, excluded: 0, symlink: 0, unsupported: 0, tooLarge: 0 };
const page = (manifestId: string, entries: MirrorEntry[], next: number | null, total: number) => ({
  manifestId,
  repositories: [{ repo: ".", branch: "main", head: "a".repeat(40) }],
  entries,
  next,
  total,
  totalBytes: total,
  skipped,
  truncated: false,
});
const refusal = (code: string) => Object.assign(new Error(code), { code });

describe("readMirrorManifest", () => {
  it("joins the pages of one listing", async () => {
    const all = [entry("a.ts"), entry("b/c.ts"), entry("d.ts")];
    const { runtime, client } = connect((params) => {
      if (params.manifestId === undefined) return page("m1", all.slice(0, 2), 2, 3);
      expect(params).toEqual({ manifestId: "m1", cursor: 2 });
      return page("m1", all.slice(2), null, 3);
    });
    const manifest = await readMirrorManifest(client);
    expect(manifest.manifestId).toBe("m1");
    expect(manifest.entries).toEqual(all);
    expect(manifest.repositories[0].branch).toBe("main");
    // Only the listing's id and cursor are ever sent: nothing about this machine.
    expect(runtime.sent.map((frame) => frame.params)).toEqual([{}, { manifestId: "m1", cursor: 2 }]);
  });

  it("starts over when the files change between pages, then gives up", async () => {
    let listings = 0;
    const { client } = connect((params) => {
      if (params.manifestId === undefined) {
        listings += 1;
        return listings === 1 ? page("m1", [entry("a.ts")], 1, 2) : page("m2", [entry("a.ts", "v2"), entry("b.ts")], null, 2);
      }
      throw refusal("cursor_expired");
    });
    const manifest = await readMirrorManifest(client);
    expect(manifest.manifestId).toBe("m2");
    expect(manifest.entries.map((item) => item.path)).toEqual(["a.ts", "b.ts"]);

    const restless = connect((params) => {
      if (params.manifestId === undefined) return page("m", [entry("a.ts")], 1, 2);
      throw refusal("cursor_expired");
    });
    await expect(readMirrorManifest(restless.client)).rejects.toMatchObject({ code: "unstable" });
    expect(restless.runtime.sent.length).toBe(8);
  });

  it("refuses a manifest that is incomplete or names a path outside the workspace", async () => {
    const short = connect(() => page("m1", [entry("a.ts")], null, 2));
    await expect(readMirrorManifest(short.client)).rejects.toBeInstanceOf(MirrorManifestError);
    for (const path of ["../outside.ts", "/etc/passwd", "a/../../b", "a//b.ts", "./a.ts"]) {
      const bad = connect(() => page("m1", [entry(path)], null, 1));
      await expect(readMirrorManifest(bad.client), path).rejects.toThrow();
    }
    const twice = connect(() => page("m1", [entry("a.ts"), entry("a.ts")], null, 2));
    await expect(readMirrorManifest(twice.client)).rejects.toMatchObject({ code: "invalid" });
  });

  it("is not asked of a runtime without mirror/1, and passes other refusals on", async () => {
    const old = connect(() => page("m1", [], null, 0), ["fs/1"]);
    await expect(readMirrorManifest(old.client)).rejects.toMatchObject({ code: "capability_not_granted" });
    expect(old.runtime.sent).toEqual([]);
    expect(old.client.hasCapability("mirror/1")).toBe(false);
    const failing = connect(() => {
      throw refusal("git_failed");
    });
    await expect(readMirrorManifest(failing.client)).rejects.toBeInstanceOf(WorkspaceRpcError);
  });

  it("stops between pages when aborted", async () => {
    const controller = new AbortController();
    const { client } = connect((params) => {
      if (params.manifestId === undefined) {
        controller.abort();
        return page("m1", [entry("a.ts")], 1, 2);
      }
      return page("m1", [entry("b.ts")], null, 2);
    });
    await expect(readMirrorManifest(client, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  });
});
