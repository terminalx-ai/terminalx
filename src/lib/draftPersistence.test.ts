import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

type Drafts = typeof import("./drafts");
let drafts: Drafts;
let start: () => Promise<void>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => (command === "composer_drafts_load" ? {} : undefined));
  drafts = await import("./drafts");
  start = (await import("./draftPersistence")).startDraftPersistence;
});
afterEach(() => vi.useRealTimers());

const saves = () => invoke.mock.calls.filter(([command]) => command === "composer_draft_save").map(([, args]) => args);

describe("draft persistence", () => {
  it("saves a tab's draft once typing pauses, with only the latest text", async () => {
    await start();
    drafts.setDraft("t1", "hel");
    drafts.setDraft("t1", "hello");
    vi.advanceTimersByTime(399);
    expect(saves()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(saves()).toEqual([{ tabId: "t1", text: "hello" }]);
  });

  it("saves what is pending as soon as the window is closing", async () => {
    await start();
    drafts.setDraft("t1", "unsent");
    window.dispatchEvent(new Event("pagehide"));
    expect(saves()).toEqual([{ tabId: "t1", text: "unsent" }]);
    vi.advanceTimersByTime(1000);
    expect(saves()).toHaveLength(1);
  });

  it("saves what is pending when the window loses focus", async () => {
    await start();
    drafts.setDraft("t1", "unsent");
    window.dispatchEvent(new Event("blur"));
    expect(saves()).toEqual([{ tabId: "t1", text: "unsent" }]);
  });

  it("restores saved drafts at startup, without saving them again", async () => {
    invoke.mockImplementation(async (command: string) => (command === "composer_drafts_load" ? { t1: "from last time" } : undefined));
    await start();
    expect(drafts.getDraft("t1")).toBe("from last time");
    vi.advanceTimersByTime(1000);
    expect(saves()).toEqual([]);
  });

  it("keeps what was already typed over a saved draft", async () => {
    invoke.mockImplementation(async (command: string) => (command === "composer_drafts_load" ? { t1: "old", t2: "other" } : undefined));
    const started = start();
    drafts.setDraft("t1", "typed meanwhile");
    await started;
    expect(drafts.getDraft("t1")).toBe("typed meanwhile");
    expect(drafts.getDraft("t2")).toBe("other");
  });

  it("carries on when the saved drafts cannot be read", async () => {
    invoke.mockRejectedValue(new Error("unavailable"));
    await start();
    drafts.setDraft("t1", "still works");
    vi.advanceTimersByTime(400);
    expect(saves()).toEqual([{ tabId: "t1", text: "still works" }]);
  });
});

describe("a draft that could not be saved (3.7)", () => {
  it("is saved again with the latest text, says so after failing twice, and stops saying so once saved", async () => {
    let fail = true;
    invoke.mockImplementation(async (command: string) => {
      if (command === "composer_drafts_load") return {};
      if (command === "composer_draft_save" && fail) throw new Error("disk full");
      return undefined;
    });
    const toasts = await import("./errorToasts");
    await start();
    drafts.setDraft("t1", "first");
    await vi.advanceTimersByTimeAsync(400);
    expect(saves()).toEqual([{ tabId: "t1", text: "first" }]);
    expect(toasts.getErrorToasts().some((toast) => toast.key === "draft-save")).toBe(false);
    drafts.setDraft("t1", "first and more");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(saves().at(-1)).toEqual({ tabId: "t1", text: "first and more" });
    expect(toasts.getErrorToasts().some((toast) => toast.key === "draft-save")).toBe(true);
    fail = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(toasts.getErrorToasts().some((toast) => toast.key === "draft-save")).toBe(false);
    const count = saves().length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(saves()).toHaveLength(count);
  });

  it("says last time's drafts could not be read, and reads them again on Try again", async () => {
    let fail = true;
    invoke.mockImplementation(async (command: string) => {
      if (command === "composer_drafts_load") { if (fail) throw new Error("unavailable"); return { t1: "from last time" }; }
      return undefined;
    });
    const toasts = await import("./errorToasts");
    await start();
    const toast = toasts.getErrorToasts().find((entry) => entry.key === "draft-load");
    expect(toast).toBeDefined();
    fail = false;
    toast!.actions!.find((action) => action.label === "Try again")!.run();
    await vi.waitFor(() => expect(drafts.getDraft("t1")).toBe("from last time"));
    expect(toasts.getErrorToasts().some((entry) => entry.key === "draft-load")).toBe(false);
  });
});
