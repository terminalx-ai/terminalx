import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { sendHeldFirstMessage } = await import("./sessionBackend");
const { heldFirstMessage, resetFirstMessages } = await import("./firstMessage");
const { getErrorToasts, dismissError } = await import("./errorToasts");

const image = { mediaType: "image/png", data: "AQID", name: "shot.png" };
const userMessage = { id: "e1", seq: 1, sessionId: "s1", tabId: "t1", harness: "claude", ts: "2026-11-16T10:00:00Z", payload: { type: "user_message", text: "Start here", queued: false } };

let reply: (value: unknown) => void;
let refuse: (error: unknown) => void;
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((command: string) => {
    if (command === "send_message") return new Promise((resolve, reject) => { reply = resolve; refuse = reject; });
    return Promise.resolve(null);
  });
});
afterEach(() => {
  resetFirstMessages();
  for (const toast of getErrorToasts()) dismissError(toast.id);
});

describe("a new session's first send, held on screen (PRO-397)", () => {
  it("holds the message with its image and files from the moment it is sent, until the send returns", async () => {
    const done = sendHeldFirstMessage("s1", "t1", "Start here", [image]);
    expect(heldFirstMessage("s1", "t1")).toMatchObject({ text: "Start here", images: [{ url: "data:image/png;base64,AQID", name: "shot.png" }], error: null });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("send_message", expect.objectContaining({ sessionId: "s1", tabId: "t1", text: "Start here" })));
    expect(heldFirstMessage("s1", "t1")).not.toBeNull();
    reply({ queued: false, events: [userMessage] });
    await done;
    expect(heldFirstMessage("s1", "t1")).toBeNull();
  });

  it("names the files picked on the new-session screen while they are stored", () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    void sendHeldFirstMessage("s1", "t1", "Read these", [], [{ name: "notes.md", path: "/Users/me/notes.md" }]);
    expect(heldFirstMessage("s1")?.files).toEqual([{ name: "notes.md" }]);
  });

  it("keeps the message, with why, when the send fails", async () => {
    const done = sendHeldFirstMessage("s1", "t1", "Start here");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    refuse(new Error("the agent exited"));
    await expect(done).rejects.toThrow("the agent exited");
    expect(heldFirstMessage("s1", "t1")).toMatchObject({ text: "Start here", error: "the agent exited" });
  });
});
