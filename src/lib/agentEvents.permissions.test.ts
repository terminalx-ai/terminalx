import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types/events";
import { applyEvent, dropTabLog, getTabLog, respondPermissionOnce } from "./agentEvents";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));

const request: AgentEvent = {
  id: "request-event", sessionId: "permission-session", tabId: "permission-tab", harness: "codex", seq: 1, ts: "2026-11-05T10:00:00Z",
  payload: { type: "permission_requested", requestId: "request", toolUseId: "", toolName: "Bash", input: { command: "pwd" }, options: [{ id: "allow", label: "Allow", kind: "allow_once" }] },
};
const respond = (send: () => Promise<void>, confirmed = true) => respondPermissionOnce(request.sessionId, request.tabId, "request", send, confirmed);
const log = () => getTabLog(request.sessionId, request.tabId);
afterEach(() => dropTabLog(request.sessionId, request.tabId));

it("claims a request synchronously across cards and refuses a stale callback after confirmation (PRO-160)", async () => {
  applyEvent(request);
  let finish!: () => void;
  const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = respond(send);
  expect(log().permissionResponses?.get("request")).toBe("sending");
  expect(await respond(send)).toBe("sending");
  expect(send).toHaveBeenCalledOnce();
  finish();
  expect(await first).toBe("sent");
  expect(await respond(send)).toBe("already_answered");
  expect(send).toHaveBeenCalledOnce();
});

it("releases a failed submission for retry without retiring a live request", async () => {
  applyEvent(request);
  const send = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(undefined);
  await expect(respond(send)).rejects.toThrow("connection lost");
  expect(log().permissionResponses?.has("request")).toBe(false);
  expect(await respond(send)).toBe("sent");
  expect(send).toHaveBeenCalledTimes(2);
});

it("keeps an enqueued cloud answer pending until the owner confirms it", async () => {
  applyEvent(request);
  const send = vi.fn().mockResolvedValue(undefined);
  expect(await respond(send, false)).toBe("sent");
  expect(log().permissionResponses?.has("request")).toBe(false);
  applyEvent({ ...request, id: "decision-event", seq: 2, payload: { type: "permission_decided", requestId: "request", allowed: true, label: "Allowed", automatic: false } });
  expect(await respond(send, false)).toBe("already_answered");
  expect(send).toHaveBeenCalledOnce();
});

it("does not carry an in-flight answer into a closed and recreated tab log", async () => {
  applyEvent(request);
  let finish!: () => void;
  const responding = respond(() => new Promise<void>(resolve => { finish = resolve; }));
  dropTabLog(request.sessionId, request.tabId);
  applyEvent(request);
  finish();
  await responding;
  expect(log().permissionResponses?.has("request")).toBeFalsy();
});
