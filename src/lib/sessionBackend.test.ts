import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { localSessionBackend, sendFirstMessage } = await import("./sessionBackend");
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
