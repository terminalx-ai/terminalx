import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveAccess, type Bot, type BotList } from "@/types/bots";

const mocks = vi.hoisted(() => ({
  api: {
    list: vi.fn(),
    get: vi.fn(),
    templates: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    pauseAll: vi.fn(),
    resumeAll: vi.fn(),
    roleRead: vi.fn(),
    roleWrite: vi.fn(),
  },
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  // The quit questions held now, as `quitWarning` would hold them.
  quit: new Set<symbol>(),
}));

vi.mock("@/lib/api", () => ({ botsApi: mocks.api }));
vi.mock("@/lib/quitWarning", () => ({
  holdQuit: () => {
    const key = Symbol();
    mocks.quit.add(key);
    return () => mocks.quit.delete(key);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));

const { hasRoleDraft, keepRoleDraft, resetRoleDraftsForTests } = await import("./botMemory");
const { bootBots, shutBots, getBotStore, createBot, updateBot, deleteBot, pauseBot, resumeBot, pauseAllBots, resumeAllBots, loadBotTemplates, resetBotsForTests } = await import("./bots");

const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, slug: name.toLowerCase(), name, roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z", ...extra,
});
const listOf = (revision: number, bots: Bot[], unreadable = 0): BotList => ({ revision, bots, unreadable });
const paused = { at: "2026-11-20T11:00:00Z", by: "owner" };
const EMPTY = { loaded: false, bots: [], revision: -1, unreadable: 0, error: null, templates: null };
const changed = (list: BotList) => mocks.listeners.get("bots_changed")!({ payload: list });
const names = () => getBotStore().bots.map((value) => value.name);

beforeEach(() => {
  for (const mock of Object.values(mocks.api)) mock.mockReset();
  mocks.listeners.clear();
  mocks.api.list.mockResolvedValue(listOf(0, []));
});
afterEach(() => {
  resetBotsForTests();
  resetRoleDraftsForTests();
  mocks.quit.clear();
});

describe("the bots' store (PRO-466)", () => {
  it("reads and listens for nothing until it is booted", () => {
    expect(getBotStore()).toEqual(EMPTY);
    expect(mocks.api.list).not.toHaveBeenCalled();
    expect(mocks.listeners.size).toBe(0);
  });

  it("boots once: reads the bots, then follows bots_changed and a reattached runtime", async () => {
    mocks.api.list.mockResolvedValue(listOf(3, [bot("1", "Atlas")], 1));
    await bootBots();
    await bootBots();
    expect(mocks.api.list).toHaveBeenCalledTimes(1);
    expect(getBotStore()).toMatchObject({ loaded: true, revision: 3, unreadable: 1, error: null, bots: [{ id: "1", name: "Atlas" }] });

    changed(listOf(4, [bot("1", "Atlas"), bot("2", "Iris")]));
    expect(names()).toEqual(["Atlas", "Iris"]);
    // Not a list: ignored, the bots stay as they were.
    mocks.listeners.get("bots_changed")!({ payload: [bot("9", "Old shape")] });
    mocks.listeners.get("bots_changed")!({ payload: null });
    expect(getBotStore().bots).toHaveLength(2);

    mocks.api.list.mockResolvedValue(listOf(5, [bot("2", "Iris")]));
    mocks.listeners.get("local_runtime_reattached")!({ payload: null });
    await vi.waitFor(() => expect(getBotStore().bots.map((value) => value.id)).toEqual(["2"]));
  });

  it("keeps the newest list: an older one never replaces it", async () => {
    let answer!: (list: BotList) => void;
    mocks.api.list.mockReturnValue(new Promise<BotList>((resolve) => (answer = resolve)));
    const booting = bootBots();
    await vi.waitFor(() => expect(mocks.listeners.has("bots_changed")).toBe(true));
    // The event of a change made after the read reaches the window before the read's answer.
    changed(listOf(8, [bot("1", "Kestrel")]));
    answer(listOf(7, [bot("1", "Atlas")]));
    await booting;
    expect(getBotStore().revision).toBe(8);
    expect(names()).toEqual(["Kestrel"]);
    // Out of order events: the older one is dropped.
    changed(listOf(10, [bot("1", "Merlin")]));
    changed(listOf(9, [bot("1", "Argus")]));
    expect(names()).toEqual(["Merlin"]);
    // A pause-all answer older than what is shown is dropped too.
    mocks.api.pauseAll.mockResolvedValue(listOf(9, [bot("1", "Argus", { paused })]));
    await pauseAllBots();
    expect(getBotStore().bots[0]).toMatchObject({ name: "Merlin" });
  });

  it("says why the bots could not be read, which is not the same as having none", async () => {
    mocks.api.list.mockRejectedValue("bots.json cannot be read; it is left as it is");
    await bootBots();
    expect(getBotStore()).toMatchObject({ loaded: true, bots: [], error: "bots.json cannot be read; it is left as it is" });
    // A later good list clears it.
    changed(listOf(1, [bot("1", "Atlas")]));
    expect(getBotStore()).toMatchObject({ error: null, bots: [{ id: "1" }] });
    // A failed read after a good one keeps the bots it has and says why.
    mocks.api.list.mockRejectedValue(new Error("the runtime did not answer"));
    mocks.listeners.get("local_runtime_reattached")!({ payload: null });
    await vi.waitFor(() => expect(getBotStore().error).toBe("the runtime did not answer"));
    expect(names()).toEqual(["Atlas"]);
  });

  it("forgets everything and stops listening when the switch goes off", async () => {
    mocks.api.list.mockResolvedValue(listOf(2, [bot("1", "Atlas")]));
    await bootBots();
    expect(mocks.listeners.size).toBe(2);
    shutBots();
    expect(getBotStore()).toEqual(EMPTY);
    expect(mocks.listeners.size).toBe(0);
    // Turned on again, it reads again.
    await bootBots();
    expect(mocks.api.list).toHaveBeenCalledTimes(2);
    expect(getBotStore().bots).toHaveLength(1);
  });

  it("drops an answer that arrives after the switch went off", async () => {
    let answer!: (list: BotList) => void;
    mocks.api.list.mockReturnValue(new Promise<BotList>((resolve) => (answer = resolve)));
    const booting = bootBots();
    await vi.waitFor(() => expect(mocks.api.list).toHaveBeenCalled());
    shutBots();
    answer(listOf(1, [bot("1", "Atlas")]));
    await booting;
    expect(getBotStore()).toEqual(EMPTY);
  });

  it("takes each change's answer at once when no list came in meanwhile", async () => {
    await bootBots();
    mocks.api.create.mockResolvedValue(bot("1", "Atlas"));
    expect((await createBot("cto", "Atlas")).slug).toBe("atlas");
    expect(mocks.api.create).toHaveBeenCalledWith("cto", "Atlas");
    expect(getBotStore().bots).toHaveLength(1);

    mocks.api.update.mockResolvedValue(bot("1", "Kestrel"));
    await updateBot("1", { name: "Kestrel" });
    expect(mocks.api.update).toHaveBeenCalledWith("1", { name: "Kestrel" });
    expect(names()).toEqual(["Kestrel"]);

    mocks.api.pause.mockResolvedValue(bot("1", "Kestrel", { paused }));
    await pauseBot("1");
    expect(getBotStore().bots[0].paused).toEqual(paused);
    mocks.api.resume.mockResolvedValue(bot("1", "Kestrel"));
    await resumeBot("1");
    expect(getBotStore().bots[0].paused).toBeUndefined();

    mocks.api.create.mockResolvedValue(bot("2", "Iris"));
    await createBot("ux-designer", "Iris");
    mocks.api.pauseAll.mockResolvedValue(listOf(6, [bot("1", "Kestrel", { paused }), bot("2", "Iris", { paused })]));
    expect(await pauseAllBots()).toHaveLength(2);
    expect(getBotStore().bots.every((value) => value.paused)).toBe(true);
    mocks.api.resumeAll.mockResolvedValue(listOf(7, [bot("1", "Kestrel"), bot("2", "Iris")]));
    await resumeAllBots();
    expect(getBotStore().bots.some((value) => value.paused)).toBe(false);

    mocks.api.remove.mockResolvedValue(undefined);
    await deleteBot("1");
    expect(getBotStore().bots.map((value) => value.id)).toEqual(["2"]);
  });

  it("leaves a change's answer to the lists when one came in while it ran", async () => {
    mocks.api.list.mockResolvedValue(listOf(1, [bot("1", "Atlas")]));
    await bootBots();
    let answer!: (value: Bot) => void;
    mocks.api.update.mockReturnValue(new Promise<Bot>((resolve) => (answer = resolve)));
    const renaming = updateBot("1", { name: "Kestrel" });
    // Its own announcement and then a later rename arrive before the answer.
    changed(listOf(2, [bot("1", "Kestrel")]));
    changed(listOf(3, [bot("1", "Merlin")]));
    answer(bot("1", "Kestrel"));
    expect((await renaming).name).toBe("Kestrel");
    expect(names()).toEqual(["Merlin"]);
  });

  it("keeps the bots as they were when a change is refused", async () => {
    mocks.api.list.mockResolvedValue(listOf(1, [bot("1", "Atlas")]));
    await bootBots();
    mocks.api.update.mockRejectedValue("A bot needs a name.");
    await expect(updateBot("1", { name: " " })).rejects.toBe("A bot needs a name.");
    mocks.api.remove.mockRejectedValue("No bot has the id 1.");
    await expect(deleteBot("1")).rejects.toBe("No bot has the id 1.");
    expect(names()).toEqual(["Atlas"]);
  });

  it("reads the role templates once", async () => {
    const templates = [{ id: "cto", title: "CTO", description: "Leads.", role: "You are the lead bot.", skills: ["terminalx-cli"], duties: [] }];
    mocks.api.templates.mockResolvedValue(templates);
    expect(await loadBotTemplates()).toEqual(templates);
    expect(await loadBotTemplates()).toEqual(templates);
    expect(mocks.api.templates).toHaveBeenCalledTimes(1);
    expect(getBotStore().templates).toEqual(templates);
  });

  it("acts on an access level it does not know as the most restrictive one", () => {
    expect(effectiveAccess("full")).toBe("full");
    expect(effectiveAccess("askOutward")).toBe("askOutward");
    expect(effectiveAccess("approveEverything")).toBe("readReport");
  });
});

describe("an unsaved role and the bots there are (PRO-512)", () => {
  const draft = { text: "Half written", base: "Before", baseHash: "h1" };
  const asking = () => mocks.quit.size > 0;

  it("stops asking before quitting once the bot is deleted here", async () => {
    mocks.api.list.mockResolvedValue(listOf(1, [bot("1", "Atlas"), bot("2", "Iris")]));
    await bootBots();
    keepRoleDraft("1", draft);
    expect(asking()).toBe(true);
    // A delete that is refused deletes nothing: the draft stays, and is still asked about.
    mocks.api.remove.mockRejectedValue("No bot has the id 1.");
    await expect(deleteBot("1")).rejects.toBe("No bot has the id 1.");
    expect([hasRoleDraft("1"), asking()]).toEqual([true, true]);
    mocks.api.remove.mockResolvedValue(undefined);
    await deleteBot("1");
    expect([hasRoleDraft("1"), asking()]).toEqual([false, false]);
  });

  it("stops asking once a list no longer has the bot, deleted elsewhere", async () => {
    mocks.api.list.mockResolvedValue(listOf(1, [bot("1", "Atlas"), bot("2", "Iris")]));
    await bootBots();
    keepRoleDraft("1", draft);
    keepRoleDraft("2", draft);
    // A list with a record this app cannot read may be missing a bot that is there: nothing is dropped.
    changed(listOf(2, [bot("2", "Iris")], 1));
    expect([hasRoleDraft("1"), hasRoleDraft("2"), asking()]).toEqual([true, true, true]);
    // Nor by an older list, which is not taken.
    changed(listOf(1, []));
    expect([hasRoleDraft("1"), hasRoleDraft("2")]).toEqual([true, true]);
    changed(listOf(3, [bot("2", "Iris")]));
    expect([hasRoleDraft("1"), hasRoleDraft("2"), asking()]).toEqual([false, true, true]);
    changed(listOf(4, []));
    expect([hasRoleDraft("2"), asking()]).toEqual([false, false]);
  });

  it("keeps a draft when the bots cannot be read", async () => {
    mocks.api.list.mockResolvedValue(listOf(1, [bot("1", "Atlas")]));
    await bootBots();
    keepRoleDraft("1", draft);
    mocks.api.list.mockRejectedValue("The runtime is not running.");
    mocks.listeners.get("local_runtime_reattached")!({ payload: null });
    await vi.waitFor(() => expect(getBotStore().error).toBe("The runtime is not running."));
    expect([hasRoleDraft("1"), asking()]).toEqual([true, true]);
  });

  it("does not ask while Bots is off, and asks again about the draft it kept once Bots is back on", async () => {
    mocks.api.list.mockResolvedValue(listOf(1, [bot("1", "Atlas")]));
    await bootBots();
    keepRoleDraft("1", draft);
    shutBots();
    expect([hasRoleDraft("1"), asking()]).toEqual([true, false]);
    await bootBots();
    expect([hasRoleDraft("1"), asking()]).toEqual([true, true]);
    // Deleted while Bots was off: the list read when it comes back on drops the draft.
    shutBots();
    mocks.api.list.mockResolvedValue(listOf(2, []));
    await bootBots();
    expect([hasRoleDraft("1"), asking()]).toEqual([false, false]);
  });
});
