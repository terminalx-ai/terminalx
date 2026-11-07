import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildTranscript } from "@/lib/transcript";
import { dropEditors, getEditors } from "@/lib/editors";
import type { AgentEvent } from "@/types/events";
import { TurnChanges } from "./TurnChanges";
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
afterEach(() => { cleanup(); dropEditors(() => true); });

it("opens a deleted file's immutable turn diff without inspecting the missing file", () => {
  const events = [
    { seq: 1, payload: { type: "user_message", text: "Remove it", queued: false, baseline: "before" } },
    { seq: 2, payload: { type: "turn_completed", status: "ok", head: "after" } },
    { seq: 3, payload: { type: "user_message", text: "Next", queued: false, baseline: "later" } },
  ] as AgentEvent[];
  const turn = buildTranscript(events, false).turns[0];
  expect(turn.prompt?.baseline).toBe("before");
  render(<TurnChanges changes={[{ path: "/repo/gone.ts", kind: "delete", added: 0, removed: 3 }]} linkContext={{ sessionId: "s", cwd: "/repo" }} range={{ base: turn.prompt!.baseline!, head: turn.completed!.head! }} />);
  fireEvent.click(screen.getByRole("button", { name: /gone.ts/ }));
  expect(getEditors().editors[0]).toMatchObject({ kind: "diff", root: "/repo", rel: "gone.ts", diff: { scope: "turn", range: { base: "before", head: "after" } } });
});

it("retains a queued prompt's baseline when it becomes a turn", () => {
  const events = [
    { seq: 1, payload: { type: "user_message", text: "First", queued: false, baseline: "first" } },
    { seq: 2, payload: { type: "user_message", text: "Queued", queued: true, baseline: "queued" } },
    { seq: 3, payload: { type: "turn_completed", status: "ok", head: "head" } },
    { seq: 4, payload: { type: "turn_started", promptSeq: 2 } },
  ] as AgentEvent[];
  expect(buildTranscript(events, false).turns.at(-1)?.prompt?.baseline).toBe("queued");
});
