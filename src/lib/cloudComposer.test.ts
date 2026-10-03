import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcError, type WorkspaceRpcClient, type WorkspaceYou } from "@terminalx/portable/workspace";
import {
  CLOUD_IMAGES_NEED_RUNNING,
  CLOUD_IMAGES_OLD_RUNTIME,
  CLOUD_TOO_MANY_IMAGES,
  COMMANDS_RESTRICTED_NOTE,
  CloudImageError,
  cloudComposerCommands,
  cloudComposerFiles,
  cloudImagesBlocked,
  resetCloudComposer,
  uploadCloudImages,
} from "./cloudComposer";

const approver: WorkspaceYou = { userId: "u-me", role: "driver", canApprove: true, listed: true } as WorkspaceYou;
const plain: WorkspaceYou = { ...approver, canApprove: false };

function runtime(answer: unknown, capabilities = ["composer/1"]) {
  const call = vi.fn(async () => answer);
  const client = { connection: { state: "connected" }, hasCapability: (capability: string) => capabilities.includes(capability), call } as unknown as WorkspaceRpcClient;
  return { call, client };
}

const target = (client: WorkspaceRpcClient | null, you: WorkspaceYou | null = approver) => ({ workspaceKey: "cloud:o:w", sessionId: "s-1", tabId: "t-1", harness: "claude", client, you });

beforeEach(resetCloudComposer);

describe("a cloud tab's slash commands", () => {
  it("come from the runtime, once per session, agent and right", async () => {
    const { call, client } = runtime({ commands: [{ name: "review", description: "Review a PR", argumentHint: "[pr]", source: "builtin" }, { name: "", description: "nameless" }, null], restricted: false });
    const source = cloudComposerCommands(target(client))!;
    expect(source.known()).toBeNull();
    expect(await source.load()).toEqual({ commands: [{ name: "review", description: "Review a PR", argumentHint: "[pr]", source: "builtin" }], note: null });
    expect(call).toHaveBeenCalledWith("session.commands", { sessionId: "s-1", tabId: "t-1" });
    // Another tab of the same session and agent, and a later render, read what is known.
    const again = cloudComposerCommands({ ...target(client), tabId: "t-2" })!;
    expect(again.key).toBe(source.key);
    expect(again.known()?.commands.map((command) => command.name)).toEqual(["review"]);
    await again.load();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("says why a plain driver's list is shorter, and never shows them a list read with the right", async () => {
    const full = runtime({ commands: [{ name: "review", description: "", source: "builtin" }], restricted: false });
    await cloudComposerCommands(target(full.client))!.load();
    const narrow = runtime({ commands: [{ name: "compact", description: "", source: "builtin" }], restricted: true });
    const source = cloudComposerCommands(target(narrow.client, plain))!;
    expect(source.known()).toBeNull();
    expect(await source.load()).toEqual({ commands: [{ name: "compact", description: "", source: "builtin" }], note: COMMANDS_RESTRICTED_NOTE });
    expect(source.key).not.toBe(cloudComposerCommands(target(narrow.client))!.key);
  });

  it("asks nothing while the runtime is not connected: what was listed stays, and connecting reads again", async () => {
    const offline = cloudComposerCommands(target(null))!;
    expect(await offline.load()).toEqual({ commands: [], note: null });
    const { call, client } = runtime({ commands: [{ name: "review", description: "", source: "builtin" }], restricted: false });
    const live = cloudComposerCommands(target(client))!;
    expect(live.key).not.toBe(offline.key);
    await live.load();
    expect(call).toHaveBeenCalledTimes(1);
    expect((await cloudComposerCommands(target(null))!.load()).commands.map((command) => command.name)).toEqual(["review"]);
  });

  it("is absent on a runtime from before composer/1", () => {
    const { call, client } = runtime({}, ["session/1"]);
    expect(cloudComposerCommands(target(client))).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("a failed listing is asked again", async () => {
    const { call, client } = runtime(null);
    call.mockRejectedValueOnce(new Error("timeout"));
    const source = cloudComposerCommands(target(client))!;
    await expect(source.load()).rejects.toThrow("timeout");
    call.mockResolvedValueOnce({ commands: [], restricted: false });
    expect(await source.load()).toEqual({ commands: [], note: null });
  });
});

describe("a cloud tab's file mentions", () => {
  const where = { workspaceKey: "cloud:o:w", sessionId: "s-1" };

  it("search the session's directory on the runtime", async () => {
    const { call, client } = runtime({ files: [{ path: "src/auth/login.rs", name: "login.rs", score: 140 }, { path: "docs/login.md" }, { name: "pathless" }, null] }, ["composer/1", "composer/2"]);
    const files = cloudComposerFiles({ ...where, client })!;
    expect(await files.search("login", 30)).toEqual([
      { path: "src/auth/login.rs", name: "login.rs", score: 140 },
      { path: "docs/login.md", name: "login.md", score: 0 },
    ]);
    expect(call).toHaveBeenCalledWith("session.files", { sessionId: "s-1", query: "login", limit: 30 });
  });

  it("are not offered while the runtime is not connected, or on a runtime from before composer/2", () => {
    expect(cloudComposerFiles({ ...where, client: null })).toBeNull();
    const old = runtime({}, ["composer/1"]);
    expect(cloudComposerFiles({ ...where, client: old.client })).toBeNull();
    const asleep = { connection: { state: "suspended" }, hasCapability: () => false, call: vi.fn() } as unknown as WorkspaceRpcClient;
    expect(cloudComposerFiles({ ...where, client: asleep })).toBeNull();
    expect(old.call).not.toHaveBeenCalled();
  });
});

describe("a cloud tab's images", () => {
  const where = { sessionId: "s-1", tabId: "t-1" };
  function uploader(refuse?: WorkspaceRpcError) {
    const mutate = vi.fn(async (_method: string, _params: Record<string, unknown>) => {
      if (refuse) throw refuse;
      return {};
    });
    return { mutate, client: { mutate } as unknown as WorkspaceRpcClient };
  }

  it("are uploaded to the runtime in parts that each decode by themselves, and named by id", async () => {
    const { mutate, client } = uploader();
    // 600,000 base64 characters: one full part of 384 KiB and a rest.
    const large = "QUJD".repeat(150_000);
    const refs = await uploadCloudImages(client, where, [
      { mediaType: "image/png", data: large, name: "large.png" },
      { mediaType: "image/webp", data: "YWJj" },
    ]);
    expect(refs).toEqual([
      { id: expect.stringMatching(/^att-[0-9a-f]{32}$/), mediaType: "image/png", name: "large.png" },
      { id: expect.stringMatching(/^att-[0-9a-f]{32}$/), mediaType: "image/webp" },
    ]);
    const sent = mutate.mock.calls.map(([method, params]) => ({ method, ...params, data: (params.data as string).length }));
    expect(sent).toEqual([
      { method: "session.attach", ...where, attachmentId: refs[0]!.id, mediaType: "image/png", name: "large.png", offset: 0, data: 524_288, last: false },
      { method: "session.attach", ...where, attachmentId: refs[0]!.id, mediaType: "image/png", name: "large.png", offset: 393_216, data: 75_712, last: true },
      { method: "session.attach", ...where, attachmentId: refs[1]!.id, mediaType: "image/webp", offset: 0, data: 4, last: true },
    ]);
    expect(mutate.mock.calls.map(([, params]) => params.data).slice(0, 2).join("")).toBe(large);
    expect(mutate.mock.calls.every(([, params]) => (params.data as string).length % 4 === 0)).toBe(true);
  });

  it("say in words why one was refused, and never send more than a message carries", async () => {
    const refused = uploader(new WorkspaceRpcError("invalid_params", "the image is larger than 5 MB", "session.attach"));
    const failure = await uploadCloudImages(refused.client, where, [{ mediaType: "image/png", data: "YWJj", name: "huge.png" }]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CloudImageError);
    expect((failure as Error).message).toBe("huge.png was not sent: the image is larger than 5 MB.");
    const many = Array.from({ length: 9 }, () => ({ mediaType: "image/png", data: "YWJj" }));
    const { mutate, client } = uploader();
    await expect(uploadCloudImages(client, where, many)).rejects.toThrow(CLOUD_TOO_MANY_IMAGES);
    expect(mutate).not.toHaveBeenCalled();
    // A dropped connection is not a refusal: the caller sees it as it is.
    const dropped = uploader();
    dropped.mutate.mockRejectedValueOnce(new Error("connection closed"));
    await expect(uploadCloudImages(dropped.client, where, [{ mediaType: "image/png", data: "YWJj" }])).rejects.not.toBeInstanceOf(CloudImageError);
  });

  it("need a connected runtime that takes them", () => {
    expect(cloudImagesBlocked(null)).toBe(CLOUD_IMAGES_NEED_RUNNING);
    expect(cloudImagesBlocked({ connection: { state: "suspended" }, hasCapability: () => false } as unknown as WorkspaceRpcClient)).toBe(CLOUD_IMAGES_NEED_RUNNING);
    expect(cloudImagesBlocked(runtime({}, ["composer/1", "composer/2"]).client)).toBe(CLOUD_IMAGES_OLD_RUNTIME);
    expect(cloudImagesBlocked(runtime({}, ["composer/3"]).client)).toBeNull();
  });
});
