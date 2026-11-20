import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/types/bots";

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
}));

vi.mock("@/lib/api", () => ({ botsApi: mocks.api }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));

const { bootBots, shutBots, getBotStore, createBot, updateBot, deleteBot, pauseBot, resumeBot, pauseAllBots, resumeAllBots, loadBotTemplates, resetBotsForTests } = await import("./bots");

const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, slug: name.toLowerCase(), name, roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z", ...extra,
});
const paused = { at: "2026-11-20T11:00:00Z", by: "owner" };

beforeEach(() => {
  for (const mock of Object.values(mocks.api)) mock.mockReset();
  mocks.listeners.clear();
  mocks.api.list.mockResolvedValue([]);
});
afterEach(() => resetBotsForTests());

describe("the bots' store (PRO-466)", () => {
  it("reads and listens for nothing until it is booted", () => {
    expect(getBotStore()).toEqual({ loaded: false, bots: [], templates: null });
    expect(mocks.api.list).not.toHaveBeenCalled();
    expect(mocks.listeners.size).toBe(0);
  });

  it("boots once: reads the bots, then follows bots_changed and a reattached runtime", async () => {
    mocks.api.list.mockResolvedValue([bot("1", "Atlas")]);
    await bootBots();
    await bootBots();
    expect(mocks.api.list).toHaveBeenCalledTimes(1);
    expect(getBotStore()).toMatchObject({ loaded: true, bots: [{ id: "1", name: "Atlas" }] });

    mocks.listeners.get("bots_changed")!({ payload: [bot("1", "Atlas"), bot("2", "Iris")] });
    expect(getBotStore().bots.map((value) => value.name)).toEqual(["Atlas", "Iris"]);
    // Not a list: ignored, the bots stay as they were.
    mocks.listeners.get("bots_changed")!({ payload: null });
    expect(getBotStore().bots).toHaveLength(2);

    mocks.api.list.mockResolvedValue([bot("2", "Iris")]);
    mocks.listeners.get("local_runtime_reattached")!({ payload: null });
    await vi.waitFor(() => expect(getBotStore().bots.map((value) => value.id)).toEqual(["2"]));
  });

  it("is loaded, and empty, when the app refuses the read", async () => {
    mocks.api.list.mockRejectedValue("Bots are off.");
    await bootBots();
    expect(getBotStore()).toMatchObject({ loaded: true, bots: [] });
  });

  it("forgets everything and stops listening when the switch goes off", async () => {
    mocks.api.list.mockResolvedValue([bot("1", "Atlas")]);
    await bootBots();
    expect(mocks.listeners.size).toBe(2);
    shutBots();
    expect(getBotStore()).toEqual({ loaded: false, bots: [], templates: null });
    expect(mocks.listeners.size).toBe(0);
    // Turned on again, it reads again.
    await bootBots();
    expect(mocks.api.list).toHaveBeenCalledTimes(2);
    expect(getBotStore().bots).toHaveLength(1);
  });

  it("drops an answer that arrives after the switch went off", async () => {
    let answer!: (bots: Bot[]) => void;
    mocks.api.list.mockReturnValue(new Promise<Bot[]>((resolve) => (answer = resolve)));
    const booting = bootBots();
    await vi.waitFor(() => expect(mocks.api.list).toHaveBeenCalled());
    shutBots();
    answer([bot("1", "Atlas")]);
    await booting;
    expect(getBotStore()).toEqual({ loaded: false, bots: [], templates: null });
  });

  it("takes each change's answer at once, before its event comes back", async () => {
    await bootBots();
    mocks.api.create.mockResolvedValue(bot("1", "Atlas"));
    expect((await createBot("cto", "Atlas")).slug).toBe("atlas");
    expect(mocks.api.create).toHaveBeenCalledWith("cto", "Atlas");
    expect(getBotStore().bots).toHaveLength(1);

    mocks.api.update.mockResolvedValue(bot("1", "Kestrel"));
    await updateBot("1", { name: "Kestrel" });
    expect(mocks.api.update).toHaveBeenCalledWith("1", { name: "Kestrel" });
    expect(getBotStore().bots.map((value) => value.name)).toEqual(["Kestrel"]);

    mocks.api.pause.mockResolvedValue(bot("1", "Kestrel", { paused }));
    await pauseBot("1");
    expect(getBotStore().bots[0].paused).toEqual(paused);
    mocks.api.resume.mockResolvedValue(bot("1", "Kestrel"));
    await resumeBot("1");
    expect(getBotStore().bots[0].paused).toBeUndefined();

    mocks.api.create.mockResolvedValue(bot("2", "Iris"));
    await createBot("ux-designer", "Iris");
    mocks.api.pauseAll.mockResolvedValue([bot("1", "Kestrel", { paused }), bot("2", "Iris", { paused })]);
    await pauseAllBots();
    expect(getBotStore().bots.every((value) => value.paused)).toBe(true);
    mocks.api.resumeAll.mockResolvedValue([bot("1", "Kestrel"), bot("2", "Iris")]);
    await resumeAllBots();
    expect(getBotStore().bots.some((value) => value.paused)).toBe(false);

    mocks.api.remove.mockResolvedValue(undefined);
    await deleteBot("1");
    expect(getBotStore().bots.map((value) => value.id)).toEqual(["2"]);
  });

  it("keeps the bots as they were when a change is refused", async () => {
    mocks.api.list.mockResolvedValue([bot("1", "Atlas")]);
    await bootBots();
    mocks.api.update.mockRejectedValue("A bot needs a name.");
    await expect(updateBot("1", { name: " " })).rejects.toBe("A bot needs a name.");
    mocks.api.remove.mockRejectedValue("bot 1 not found");
    await expect(deleteBot("1")).rejects.toBe("bot 1 not found");
    expect(getBotStore().bots.map((value) => value.name)).toEqual(["Atlas"]);
  });

  it("reads the role templates once", async () => {
    const templates = [{ id: "cto", title: "CTO", description: "Leads.", role: "You are the lead bot.", skills: ["terminalx-cli"], duties: [] }];
    mocks.api.templates.mockResolvedValue(templates);
    expect(await loadBotTemplates()).toEqual(templates);
    expect(await loadBotTemplates()).toEqual(templates);
    expect(mocks.api.templates).toHaveBeenCalledTimes(1);
    expect(getBotStore().templates).toEqual(templates);
  });
});
