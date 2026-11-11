import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildTranscript } from "@/lib/transcript";
import { dropEditors, getEditors } from "@/lib/editors";
import { fs } from "@/lib/api";
import type { AgentEvent } from "@/types/events";
import { TurnChanges } from "./TurnChanges";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), fs: { inspectPath: vi.fn(), openPath: vi.fn() } }));
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
  expect(getEditors().editors[0]).toMatchObject({ kind: "diff", name: "gone.ts · Turn", root: "/repo", rel: "gone.ts", diff: { scope: "turn", range: { base: "before", head: "after" } } });
});

it("does not invent snapshots for a queued prompt without a baseline", () => {
  const events = [
    { seq: 1, payload: { type: "user_message", text: "First", queued: false, baseline: "first" } },
    { seq: 2, payload: { type: "user_message", text: "Queued", queued: true } },
    { seq: 3, payload: { type: "turn_completed", status: "ok", head: "head" } },
    { seq: 4, payload: { type: "turn_started", promptSeq: 2 } },
  ] as AgentEvent[];
  expect(buildTranscript(events, false).turns.at(-1)?.prompt?.baseline).toBeUndefined();
});


it.each(["/repo/current.ts", "/outside/current.ts"])("opens an available current file when a chip for %s cannot show a snapshot", async (path) => {
  const root = path.slice(0, path.lastIndexOf("/"));
  vi.mocked(fs.inspectPath).mockResolvedValue({ kind: "file", path, root, rel: "current.ts", text: true });
  render(<TurnChanges changes={[{ path, kind: "update", added: 1, removed: 0 }]} linkContext={{ sessionId: "s", cwd: "/repo" }} />);
  fireEvent.click(screen.getByRole("button", { name: /current.ts/ }));
  await waitFor(() => expect(getEditors().editors).toHaveLength(1));
  expect(getEditors().editors[0]).toMatchObject({ kind: "text", root, rel: "current.ts" });
});

it("does not open an empty tab when neither a snapshot nor the file is available", async () => {
  vi.mocked(fs.inspectPath).mockRejectedValue(new Error("File no longer exists"));
  render(<TurnChanges changes={[{ path: "/repo/gone.ts", kind: "delete", added: 0, removed: 1 }, { path: "/repo/moved.ts", kind: "update", added: 1, removed: 0 }]} linkContext={{ sessionId: "s", cwd: "/repo" }} />);
  // Without the turn's snapshots a deleted file has nothing to open.
  expect((screen.getByRole("button", { name: /gone.ts/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /moved.ts/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("File no longer exists");
  expect(getEditors().editors).toHaveLength(0);
});
