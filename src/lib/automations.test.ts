import { describe, expect, it, vi } from "vitest";
import type { AutomationRun } from "@/types/automations";

const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => {};
  }),
}));
vi.mock("@/lib/notify", () => ({ noteAutomationFailure: vi.fn() }));
const runNow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  automationsApi: { list: vi.fn(async () => []), issueStates: vi.fn(async () => []), runNow },
}));

const { bootAutomations, getAutomationStore, runAutomationNow } = await import("./automations");

function run(runId: string, runNumber: number): AutomationRun {
  return { runId, runNumber, automationId: "a1", trigger: "manual", status: "pending", repeatCount: 1 };
}

describe("automation run history", () => {
  it("drops a pending run the backend folded into an earlier record", async () => {
    await bootAutomations();
    handlers.get("automation_run")!({ payload: { ...run("old", 1), status: "skippedPrecheck" } });
    handlers.get("automation_run")!({ payload: run("pending", 2) });
    expect(getAutomationStore().runs.a1.map((value) => value.runId)).toEqual(["pending", "old"]);

    handlers.get("automation_run_removed")!({ payload: { automationId: "a1", runId: "pending" } });
    handlers.get("automation_run")!({ payload: { ...run("old", 1), status: "skippedPrecheck", repeatCount: 2 } });
    expect(getAutomationStore().runs.a1.map((value) => [value.runId, value.repeatCount])).toEqual([["old", 2]]);
  });

  it("does not let Run now's pending answer undo events that arrived first", async () => {
    await bootAutomations();
    runNow.mockImplementationOnce(async () => {
      handlers.get("automation_run")!({ payload: { ...run("quick", 5), status: "skippedPrecheck" } });
      return run("quick", 5);
    });
    await runAutomationNow("a1");
    expect(getAutomationStore().runs.a1.find((value) => value.runId === "quick")?.status).toBe("skippedPrecheck");

    runNow.mockImplementationOnce(async () => {
      handlers.get("automation_run")!({ payload: run("folded", 6) });
      handlers.get("automation_run_removed")!({ payload: { automationId: "a1", runId: "folded" } });
      return run("folded", 6);
    });
    await runAutomationNow("a1");
    expect(getAutomationStore().runs.a1.some((value) => value.runId === "folded")).toBe(false);
  });
});
