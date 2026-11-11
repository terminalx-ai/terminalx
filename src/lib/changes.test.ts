import { expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import { changeRange } from "./changes";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
it("uses the pinned pair for queued and autonomous turns instead of a preceding prompt baseline", () => {
  const payloads: Payload[] = [
    { type: "user_message", text: "First", baseline: "old-base", queued: false },
    { type: "turn_completed", status: "ok", head: "old-end", authFailed: false },
    { type: "turn_started", startedBy: "Scheduled task" },
    { type: "turn_checkpoint", seq: 3, base: "auto-base", head: "auto-end" },
    { type: "turn_completed", status: "ok", head: "auto-end", authFailed: false },
  ];
  const events = payloads.map((payload, seq) => ({ id: `e${seq}`, seq, sessionId: "s", tabId: "t", harness: "claude", ts: "", payload })) as AgentEvent[];
  expect(changeRange(events)).toEqual({ base: "auto-base", head: "auto-end" });
});
