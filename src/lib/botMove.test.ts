import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/types/bots";
import { cloudPlace, machinePlace, runsOnPlace } from "@/types/bots";

vi.mock("@/lib/api", () => ({ api: {}, invoke: vi.fn() }));
vi.mock("@/lib/cloudConnections", () => ({ wakeCloudConnection: vi.fn(), waitCloudConnected: vi.fn() }));
vi.mock("@/lib/machineConnections", () => ({ getMachineConnections: vi.fn(), machineConnection: vi.fn() }));

const { bringBotBack, moveBot, parts, PART_CHARS, BOT_IDLE_SUSPEND_MINUTES } = await import("./botMove");

const atlas = { id: "b1", name: "Atlas", runsOn: "thisMac" } as Bot;

function deps(options: { capable?: boolean; failImport?: boolean; failRemove?: boolean; exported?: string } = {}) {
  const steps: [string, Record<string, unknown>][] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const release = vi.fn();
  const setIdleSuspend = vi.fn(async () => undefined);
  const exported = options.exported ?? "x".repeat(PART_CHARS + 10);
  const client = {
    hasCapability: (capability: string) => options.capable !== false && capability === "bots/1",
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push([method, params]);
      if (method === "bots.import" && options.failImport) throw new Error("refused there");
      if (method === "bots.remove" && options.failRemove) throw new Error("gone away");
      if (method === "bots.import") return { bot: { ...atlas, runsOn: "thisMac" }, notes: ["A duty's project is not there."] } as T;
      if (method === "bots.export") return { transfer: "t1", parts: parts(exported).length } as T;
      if (method === "bots.exportPart") return { data: parts(exported)[params.index as number] } as T;
      return null as T;
    },
  };
  return {
    steps, calls, release, setIdleSuspend,
    value: {
      async step(operation: string, params: Record<string, unknown>) {
        steps.push([operation, params]);
        if (operation === "moveExport") return { bundle: "y".repeat(PART_CHARS * 2 + 1) };
        if (operation === "moveImport") return { bot: { ...atlas, runsOn: "thisMac" }, notes: [] };
        return {};
      },
      connect: vi.fn(async () => ({ client: client as never, release })),
      setIdleSuspend,
    },
  };
}

describe("bot places (PRO-482)", () => {
  it("reads runsOn as the runtime does", () => {
    expect(runsOnPlace("thisMac")).toEqual({ kind: "thisMac" });
    expect(runsOnPlace("cloud:org-1:ws-1")).toEqual(cloudPlace("org-1", "ws-1"));
    expect(runsOnPlace("machine:mac-2")).toEqual(machinePlace("mac-2"));
    for (const odd of ["cloud:w1", "cloud:a:b:c", "machine:", "machine:a/b", "otherMac"]) expect(runsOnPlace(odd).kind).toBe("other");
  });

  it("cuts a bundle into parts that each fit a frame", () => {
    expect(parts("")).toEqual([""]);
    const cut = parts("z".repeat(PART_CHARS * 2 + 5));
    expect(cut.map((part) => part.length)).toEqual([PART_CHARS, PART_CHARS, 5]);
  });
});

describe("moving a bot (PRO-482)", () => {
  it("marks it moved, sends it in parts, and lets the workspace sleep after two idle minutes", async () => {
    const d = deps();
    const seen: string[] = [];
    const result = await moveBot(atlas, cloudPlace("org-1", "ws-1"), (step) => seen.push(step), d.value);
    expect(d.steps.map(([op]) => op)).toEqual(["moveExport", "moveOut"]);
    expect(d.steps[1]![1]).toEqual({ id: "b1", to: "cloud:org-1:ws-1" });
    const sent = d.calls.filter(([method]) => method === "bots.importPart");
    expect(sent.map(([, params]) => [params.index, params.parts])).toEqual([[0, 3], [1, 3], [2, 3]]);
    expect(new Set(sent.map(([, params]) => params.transfer)).size).toBe(1);
    expect(d.calls.at(-1)![0]).toBe("bots.import");
    expect(d.setIdleSuspend).toHaveBeenCalledWith("org-1", "ws-1", BOT_IDLE_SUSPEND_MINUTES);
    expect(result.bot.runsOn).toBe("cloud:org-1:ws-1");
    expect(result.notes).toEqual(["A duty's project is not there."]);
    expect(seen).toEqual(["connecting", "reading", "sending", "settling"]);
    expect(d.release).toHaveBeenCalledOnce();
  });

  it("a machine gets no idle setting", async () => {
    const d = deps();
    await moveBot(atlas, machinePlace("mac-2"), undefined, d.value);
    expect(d.setIdleSuspend).not.toHaveBeenCalled();
  });

  it("a move the other side refuses is undone here", async () => {
    const d = deps({ failImport: true });
    await expect(moveBot(atlas, cloudPlace("org-1", "ws-1"), undefined, d.value)).rejects.toThrow("refused there");
    expect(d.steps.map(([op]) => op)).toEqual(["moveExport", "moveOut", "moveBack"]);
    expect(d.release).toHaveBeenCalledOnce();
  });

  it("an older runtime is refused before anything changes", async () => {
    const d = deps({ capable: false });
    await expect(moveBot(atlas, cloudPlace("org-1", "ws-1"), undefined, d.value)).rejects.toThrow("too old to keep a bot");
    expect(d.steps).toEqual([]);
  });

  it("an idle setting that fails is a note, not a failed move", async () => {
    const d = deps();
    d.setIdleSuspend.mockRejectedValueOnce(new Error("not allowed"));
    const result = await moveBot(atlas, cloudPlace("org-1", "ws-1"), undefined, d.value);
    expect(result.notes.at(-1)).toContain("could not be set to 2 minutes");
  });
});

describe("bringing a bot back (PRO-482)", () => {
  const away = { ...atlas, runsOn: "cloud:org-1:ws-1" } as Bot;

  it("reads it there in parts, takes it in here, then lets the copy there go", async () => {
    const exported = "q".repeat(PART_CHARS + 3);
    const d = deps({ exported });
    const result = await bringBotBack(away, undefined, d.value);
    expect(d.calls.map(([method]) => method)).toEqual(["bots.export", "bots.exportPart", "bots.exportPart", "bots.remove"]);
    expect(d.steps).toEqual([["moveImport", { bundle: exported }]]);
    expect(result.bot.runsOn).toBe("thisMac");
  });

  it("a copy there that cannot be let go keeps running there, and this Mac's rests again", async () => {
    const d = deps({ failRemove: true });
    await expect(bringBotBack(away, undefined, d.value)).rejects.toThrow("still runs there");
    expect(d.steps.map(([op]) => op)).toEqual(["moveImport", "moveOut"]);
    expect(d.steps[1]![1]).toEqual({ id: "b1", to: "cloud:org-1:ws-1" });
  });

  it("a bot here needs nothing; a place a newer app wrote is not guessed at", async () => {
    const d = deps();
    expect((await bringBotBack(atlas, undefined, d.value)).bot).toBe(atlas);
    await expect(bringBotBack({ ...atlas, runsOn: "moon" } as Bot, undefined, d.value)).rejects.toThrow("newer version");
    expect(d.value.connect).not.toHaveBeenCalled();
  });
});
