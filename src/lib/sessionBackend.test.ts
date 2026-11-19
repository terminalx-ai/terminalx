import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const cloudSends = vi.hoisted(() => [] as { tabId: string; text: string; images: unknown[] }[]);
vi.mock("./cloudAgents", async (original) => ({
  ...(await original<typeof import("./cloudAgents")>()),
  sendToCloudAgent: vi.fn(async (_scope: unknown, tabId: string, text: string, _client: unknown, images: unknown[]) => void cloudSends.push({ tabId, text, images })),
}));

const { localSessionBackend, sendFirstMessage, cloudSessionBackend, REMOTE_UNAVAILABLE, RESEND_ATTACHMENTS, RESEND_MISSING } = await import("./sessionBackend");
const { applyEvent } = await import("./agentEvents");
const { getErrorToasts, dismissError } = await import("./errorToasts");

const ref = { path: "/home/.terminalx/attachments/s1/a1/notes.md", name: "notes.md", mediaType: "text/markdown", size: 3 };
const image = { mediaType: "image/png", data: "AQID", name: "shot.png" };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "store_attachments") return [ref];
    if (command === "send_message") return { queued: false, events: [] };
    return null;
  });
});
afterEach(() => {
  for (const toast of getErrorToasts()) dismissError(toast.id);
});

const commands = () => invoke.mock.calls.map(([command]) => command);

describe("a local session's send (PRO-290)", () => {
  it("stores files in the session's attachments folder first, and sends their FileRefs with the images", async () => {
    await localSessionBackend("s1").send("t1", "Read these", [image], { pressedAt: 5, files: [{ name: "notes.md", path: "/Users/me/notes.md" }] });
    expect(commands()).toEqual(["store_attachments", "send_message"]);
    expect(invoke).toHaveBeenCalledWith("store_attachments", { sessionId: "s1", files: [{ name: "notes.md", path: "/Users/me/notes.md" }] });
    expect(invoke).toHaveBeenCalledWith("send_message", { sessionId: "s1", tabId: "t1", text: "Read these", images: [image], confirmDelivery: false, pressedAt: 5, files: [ref] });
  });

  it("sends nothing when the files cannot be stored", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "store_attachments") throw new Error("terminalx.json is a reserved name");
      return { queued: false, events: [] };
    });
    await expect(localSessionBackend("s1").send("t1", "Read these", [], { files: [{ name: "terminalx.json", data: "e30=" }] })).rejects.toThrow("reserved name");
    expect(commands()).toEqual(["store_attachments"]);
  });

  it("sends a message without files exactly as before: nothing is stored", async () => {
    await localSessionBackend("s1").send("t1", "Hello", [], { pressedAt: 9 });
    expect(commands()).toEqual(["send_message"]);
    expect(invoke).toHaveBeenCalledWith("send_message", { sessionId: "s1", tabId: "t1", text: "Hello", images: [], confirmDelivery: false, pressedAt: 9 });
  });
});

describe("the first message of a new session (PRO-290)", () => {
  it("stores the files picked on the new-session screen now the session exists, and sends their FileRefs", async () => {
    await sendFirstMessage("s1", "t1", "Start here", [image], [{ name: "notes.md", data: "AQID", mediaType: "text/markdown" }]);
    expect(commands()).toEqual(["store_attachments", "send_message"]);
    expect(invoke).toHaveBeenCalledWith("send_message", { sessionId: "s1", tabId: "t1", text: "Start here", images: [image], confirmDelivery: false, files: [ref] });
  });

  it("without files, sends just as the shells always did", async () => {
    await sendFirstMessage("s1", "t1", "Start here");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("send_message", { sessionId: "s1", tabId: "t1", text: "Start here", images: null, confirmDelivery: false });
  });

  it("says so in a toast when the files cannot be stored, since no composer holds them any more", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "store_attachments") throw new Error("disk full");
      return { queued: false, events: [] };
    });
    await expect(sendFirstMessage("s1", "t1", "Start here", [], [{ name: "notes.md", path: "/Users/me/notes.md" }])).rejects.toThrow("disk full");
    expect(commands()).toEqual(["store_attachments"]);
    expect(getErrorToasts()).toEqual([expect.objectContaining({ action: "Couldn't attach notes.md to the first message", cause: "disk full" })]);
  });
});

describe("a cloud session's options a local one has (#1289)", () => {
  const backend = (authority = "manage") =>
    cloudSessionBackend({
      key: "cloud:org-1:ws-1:s-cloud",
      workspaceKey: "cloud:org-1:ws-1",
      scope: { organizationId: "org-1", workspaceId: "ws-1" },
      sessionId: "s-cloud",
      state: { state: "idle" },
      client: null,
      workspaceState: "ready",
      authority,
      outbox: [],
      followUps: () => [],
      wake: vi.fn(async () => undefined),
    });
  const message = (seq: number, payload: Record<string, unknown>) =>
    applyEvent({ id: `e${seq}`, seq, sessionId: "s-cloud", tabId: "t-cloud", harness: "claude", ts: "2026-11-19T00:00:00Z", payload: { type: "user_message", queued: false, ...payload } } as never);

  beforeEach(() => {
    cloudSends.length = 0;
  });

  it("sends a message again, Retry or Send again, as its own text through the mailbox", async () => {
    message(3, { text: "Run the tests" });
    await expect(backend().resendMessage!("t-cloud", 3)).resolves.toEqual({ events: [], queued: true });
    expect(cloudSends).toEqual([{ tabId: "t-cloud", text: "Run the tests", images: [] }]);
  });

  it("refuses a message with attachments, one that is not in the tab, and a view-only reader", async () => {
    message(5, { text: "Look", images: [{ url: "https://example.test/a.png" }] });
    await expect(backend().resendMessage!("t-cloud", 5)).rejects.toThrow(RESEND_ATTACHMENTS);
    await expect(backend().resendMessage!("t-cloud", 99)).rejects.toThrow(RESEND_MISSING);
    message(6, { text: "Hello" });
    await expect(backend("participate").resendMessage!("t-cloud", 6)).rejects.toThrow(/View only/);
    expect(cloudSends).toEqual([]);
  });

  it("says why each option it cannot take is off; a local session has none to say", () => {
    expect(backend().unavailable).toBe(REMOTE_UNAVAILABLE);
    for (const key of ["fork", "reset", "secondOpinion", "retryInNewChat", "runMenu"] as const) expect(REMOTE_UNAVAILABLE[key]).toMatch(/\w/);
    expect(localSessionBackend("s1").unavailable).toBeUndefined();
  });
});
