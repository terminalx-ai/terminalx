import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, PauseHeld } from "@/types/bots";

const mocks = vi.hoisted(() => ({
  pauseHeld: vi.fn(),
  listeners: new Map<string, () => void>(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), botsApi: { pauseHeld: mocks.pauseHeld } }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));

const pause = await import("./botPause");

const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, slug: name.toLowerCase(), name, roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z", ...extra,
});
const AT = "2026-11-21T13:42:00";
const NOW = new Date(AT).getTime() + 18 * 60_000;
const atlas = bot("a", "Atlas", { paused: { at: AT, by: "owner", from: "phone", stopped: { was: "was running 2 workers", workers: 2 } } });
const iris = bot("i", "Iris", { paused: { at: AT, by: "owner", from: "phone", stopped: { was: "was quiet" } } });
const HELD: PauseHeld = {
  bots: [{ id: "a", inTurn: 0, needsYou: 0 }, { id: "i", inTurn: 0, needsYou: 1 }],
  entries: [
    { kind: "skipped", source: "duty", botId: "a", dutyId: "d1", name: "Stalled sessions and runs", at: "2026-11-21T13:50:00", count: 3 },
    { kind: "kept", source: "events", botId: "a", dutyId: "d2", name: "Review each pull request", at: AT },
    { kind: "kept", source: "answer", botId: "i", number: 4, messageKind: "answer", at: "2026-11-21T13:55:00" },
  ],
  errors: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.pauseHeld.mockReset();
  mocks.listeners.clear();
});
afterEach(() => {
  pause.resetBotPauseForTests();
  vi.useRealTimers();
});

describe("botPause: what a pause holds, read only while a bot is paused (PRO-474)", () => {
  it("asks nothing while no bot is paused, reads once a bot is, and forgets it on resume", async () => {
    mocks.pauseHeld.mockResolvedValue(HELD);
    await pause.bootBotPause();
    pause.noteBotsForPause([bot("a", "Atlas")]);
    mocks.listeners.get("bots_changed")?.();
    await vi.advanceTimersByTimeAsync(pause.PAUSE_REFRESH_MS * 2);
    expect(mocks.pauseHeld).not.toHaveBeenCalled();

    await act(async () => {
      pause.noteBotsForPause([atlas]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.pauseHeld).toHaveBeenCalledTimes(1);

    // Events arriving together are read once.
    mocks.listeners.get("automation_run")?.();
    mocks.listeners.get("bot_items_changed")?.();
    mocks.listeners.get("bot_handoffs_changed")?.();
    await vi.advanceTimersByTimeAsync(pause.PAUSE_REFRESH_MS);
    expect(mocks.pauseHeld).toHaveBeenCalledTimes(2);

    pause.noteBotsForPause([bot("a", "Atlas")]);
    mocks.listeners.get("bots_changed")?.();
    await vi.advanceTimersByTimeAsync(pause.PAUSE_REFRESH_MS * 2);
    expect(mocks.pauseHeld).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed read as an error, never as nothing held", async () => {
    mocks.pauseHeld.mockRejectedValue("the runtime is gone");
    let seen: string | null = null;
    const { renderHook } = await import("@testing-library/react");
    const hook = renderHook(() => pause.usePauseHeldError());
    await pause.bootBotPause();
    await act(async () => {
      pause.noteBotsForPause([atlas]);
      await vi.advanceTimersByTimeAsync(0);
    });
    seen = hook.result.current;
    expect(seen).toBe("the runtime is gone");
  });

  it("listens to nothing once the switch goes off", async () => {
    await pause.bootBotPause();
    expect(mocks.listeners.size).toBe(5);
    pause.shutBotPause();
    expect(mocks.listeners.size).toBe(0);
  });
});

describe("botPause: words (23.12)", () => {
  it("says who paused them, from where and when", () => {
    const clock = pause.clockTime(AT);
    expect(pause.pausedBySentence([atlas, iris], [atlas, iris], NOW)).toBe(`You paused them from your phone at ${clock}, 18 minutes ago.`);
    const itself = bot("s", "Sentry", { paused: { at: AT, by: "s", from: "cli" } });
    expect(pause.pausedBySentence([itself], [itself], NOW)).toBe(`Sentry paused itself from the command line at ${clock}, 18 minutes ago.`);
    const byAtlas = bot("s", "Sentry", { paused: { at: AT, by: "a" } });
    expect(pause.pausedBySentence([byAtlas], [atlas, byAtlas], NOW)).toBe(`Atlas paused it at ${clock}, 18 minutes ago.`);
    expect(pause.pausedBySentence([bot("q", "Quiet")], [], NOW)).toBe("");
  });

  it("counts in words up to twelve and in figures past it", () => {
    expect(pause.numberWord(4)).toBe("four");
    expect(pause.numberWord(13)).toBe("13");
    expect(pause.agoWords(AT, new Date(AT).getTime() + 30_000)).toBe("just now");
    expect(pause.agoWords(AT, new Date(AT).getTime() + 3 * 3_600_000)).toBe("3 hours ago");
  });

  it("tells each bot's row and sidebar line what is held, most telling first", () => {
    expect(pause.wasLine(atlas)).toBe("Paused · was running 2 workers");
    expect(pause.heldLine(atlas, HELD)).toBe("2 workers stopped after their current step · 3 checks skipped so far · 1 duty's events wait for resume");
    expect(pause.pausedStatus(atlas, HELD)).toBe("Paused · 2 workers stopped");
    expect(pause.heldLine(iris, HELD)).toBe("Your answer is kept and used on resume");
    expect(pause.pausedStatus(iris, HELD)).toBe("Paused · your answer is kept");
    const finishing = { ...HELD, bots: [{ id: "a", inTurn: 1, needsYou: 0 }] };
    expect(pause.heldLine(atlas, finishing).startsWith("1 worker finishes its current step, then stops")).toBe(true);
    expect(pause.pausedStatus(bot("q", "Quiet", { paused: { at: AT, by: "owner" } }), null)).toBe("Paused");
    expect(pause.heldLine(bot("q", "Quiet", { paused: { at: AT, by: "owner" } }), null)).toBe("Nothing held");
    expect(pause.pausedStatus({ ...iris, resumeRequest: { at: AT, by: "cli" } }, HELD)).toBe("Paused · asks to resume");
  });

  it("names each held entry and what happens to it", () => {
    const [skipped, events, answer] = HELD.entries;
    expect(pause.heldEntryText(skipped, [atlas, iris])).toBe("Atlas · Stalled sessions and runs");
    expect(pause.heldEntryStatus(skipped)).toBe("skipped · 3 times");
    expect(pause.heldEntryStatus(events)).toBe("kept · read on resume");
    expect(pause.heldEntryText(answer, [atlas, iris])).toBe("Your answer for Iris on #4");
    expect(pause.heldEntryText(answer, [])).toBe("Your answer for A removed bot on #4");
    expect(pause.heldNote(HELD.entries)).toBe("3 checks skipped · 2 kept for resume");
    expect(pause.heldNote([])).toBe("Nothing has come due");
  });
});
