import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionGuestClient } from "./sessionGuest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event, callback) => {
    mocks.listeners.set(event, callback);
    return mocks.unlisten;
  }),
}));
beforeEach(() => {
  mocks.listeners.clear();
  mocks.unlisten.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "session_guest_join")
      return { sessionId: "invited-session", connectionId: "connection", admitted: true };
    if (command === "session_guest_send")
      queueMicrotask(() =>
        mocks.listeners.get("session_guest_message")?.({
          payload: {
            connectionId: "connection",
            message: { id: args.request.id, ok: true, result: { accepted: true } },
          },
        }),
      );
  });
});
describe("native guest transport", () => {
  it("binds every renderer request to the invited session and the current connection", async () => {
    const client = await SessionGuestClient.join("secret-link", vi.fn());
    expect(
      await client.request("session.send", { sessionId: "another-session", tabId: "public-tab", text: "Prompt" }),
    ).toEqual({ accepted: true });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "session_guest_send",
      expect.objectContaining({
        connectionId: "connection",
        request: expect.objectContaining({
          params: { sessionId: "invited-session", tabId: "public-tab", text: "Prompt" },
        }),
      }),
    );
    client.close();
    expect(mocks.invoke).toHaveBeenCalledWith("session_guest_leave", { connectionId: "connection" });
    expect(mocks.unlisten).toHaveBeenCalledTimes(2);
  });
  it("ignores another connection's closure and closes pending requests on its own revocation", async () => {
    const closed = vi.fn();
    const client = await SessionGuestClient.join("secret-link", closed);
    mocks.listeners.get("session_guest_closed")?.({ payload: { connectionId: "older-connection", message: "Ended" } });
    expect(closed).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValue(undefined);
    const pending = client.request("session.tail", { tabId: "public-tab" });
    mocks.listeners.get("session_guest_closed")?.({
      payload: { connectionId: "connection", message: "Removed by host" },
    });
    await expect(pending).rejects.toThrow("Removed by host");
    expect(closed).toHaveBeenCalledWith("Removed by host");
    client.close();
  });
  it("handles revocation before the native join result reaches the renderer", async () => {
    mocks.invoke.mockImplementation(async () => {
      mocks.listeners.get("session_guest_closed")?.({
        payload: { connectionId: "connection", message: "Removed immediately" },
      });
      return { sessionId: "invited-session", connectionId: "connection", admitted: true };
    });
    await expect(SessionGuestClient.join("secret-link", vi.fn())).rejects.toThrow("Removed immediately");
    expect(mocks.unlisten).toHaveBeenCalledTimes(2);
  });
});
