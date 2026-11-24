import { thisComputer } from "@/lib/platform";
import { api, invoke } from "@/lib/api";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { wakeCloudConnection, waitCloudConnected } from "@/lib/cloudConnections";
import { getMachineConnections, machineConnection } from "@/lib/machineConnections";
import type { Bot } from "@/types/bots";
import { runsOnPlace, type BotPlace } from "@/types/bots";

/**
 * Moving a bot to a cloud workspace or another machine, and bringing it back (PRO-482).
 *
 * The runtime that holds the bot reads it out as one bundle (`bots::moving`): its record, role, memory, items,
 * history and duties. The window hands the bundle to the other runtime over the workspace connection, in parts
 * (`bots/1`), and the bot is marked moved here, so its record stays listed and nothing of it runs on this Mac.
 * Bringing it back reads it from there, puts it in here, and lets the copy there go.
 *
 * Each step that can fail is undone so the bot always lives in exactly one place: a move the other side refuses is
 * marked back here; a return whose copy there cannot be removed is marked moved again here.
 */

/** The idle window a bot's workspace gets: its duties wake it, so it sleeps between them (terminalx-saas PRO-482). */
export const BOT_IDLE_SUSPEND_MINUTES = 2;
/** A part of a bundle, in characters: as the runtime takes it (`remote::bots::PART_CHARS`). */
export const PART_CHARS = 256 * 1024;
const CONNECT_WITHIN_MS = 5 * 60 * 1000;

export type MoveStep = "connecting" | "reading" | "sending" | "settling" | "bringing";

export interface MoveResult {
  bot: Bot;
  /** What the owner should know: a duty whose project is not there, an idle window that could not be set. */
  notes: string[];
}

/** The calls a move makes, as parameters so a test can stand in for them. */
export interface MoveDeps {
  step(operation: "moveExport" | "moveOut" | "moveBack" | "moveImport", params: Record<string, unknown>): Promise<unknown>;
  /** A connected client for `place` and a release; a cloud workspace asleep is woken. */
  connect(place: Exclude<BotPlace, { kind: "thisMac" } | { kind: "other" }>): Promise<{ client: Pick<WorkspaceRpcClient, "call" | "hasCapability">; release(): void }>;
  setIdleSuspend(orgId: string, workspaceId: string, minutes: number): Promise<unknown>;
}

const liveDeps: MoveDeps = {
  step: (operation, params) => invoke("bot_move", { operation, params }),
  async connect(place) {
    if (place.kind === "cloud") {
      const lease = await wakeCloudConnection({ orgId: place.orgId, workspaceId: place.workspaceId });
      try {
        const client = await waitCloudConnected(lease, CONNECT_WITHIN_MS);
        return { client, release: () => lease.release() };
      } catch (error) {
        lease.release();
        throw error;
      }
    }
    const { connection, machine } = machineConnection(getMachineConnections(), place.machineId);
    if (!machine) throw new Error(`That machine is no longer paired with ${thisComputer}.`);
    if (!connection) throw new Error(`${machine.name} is not connected. Connect to it in Machines, then try again.`);
    return { client: connection.client, release: () => undefined };
  },
  setIdleSuspend: (orgId, workspaceId, minutes) => api.cloudWorkspaceSetIdleSuspend(workspaceId, minutes, orgId),
};

/** The bundle cut into parts that each fit a frame. */
export function parts(bundle: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < bundle.length; at += PART_CHARS) out.push(bundle.slice(at, at + PART_CHARS));
  return out.length ? out : [""];
}

function newTransferId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function needsBots(client: Pick<WorkspaceRpcClient, "hasCapability">, where: string) {
  if (!client.hasCapability("bots/1")) throw new Error(`TerminalX on ${where} is too old to keep a bot. Update it, then move the bot again.`);
}

/** Whether bot `id` lives on the other side now, as its own list there says; `unknown` when that cannot be read. */
async function landedThere(client: Pick<WorkspaceRpcClient, "call">, id: string): Promise<"yes" | "no" | "unknown"> {
  try {
    const list = await client.call<{ bots?: { bots?: { id?: unknown }[] } }>("bots.list");
    const bots = list.bots?.bots;
    if (!Array.isArray(bots)) return "unknown";
    return bots.some((other) => other?.id === id) ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

function notThere(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_found";
}

/** Move `bot` from this Mac to `place`, a cloud workspace or a paired machine, with its role, memory, duties and items. */
export async function moveBot(bot: Bot, place: Exclude<BotPlace, { kind: "thisMac" } | { kind: "other" }>, onStep: (step: MoveStep) => void = () => undefined, deps: MoveDeps = liveDeps): Promise<MoveResult> {
  onStep("connecting");
  const { client, release } = await deps.connect(place);
  try {
    needsBots(client, place.kind === "cloud" ? "that workspace" : "that machine");
    onStep("reading");
    const { bundle } = (await deps.step("moveExport", { id: bot.id })) as { bundle: string };
    // Marked moved before the other side has it, so its duties never run in two places; undone when the move fails.
    await deps.step("moveOut", { id: bot.id, to: place.key });
    let imported: { bot: Bot; notes?: string[] };
    try {
      onStep("sending");
      const transfer = newTransferId();
      const chunks = parts(bundle);
      for (const [index, data] of chunks.entries()) await client.call("bots.importPart", { transfer, index, parts: chunks.length, data });
      imported = await client.call<{ bot: Bot; notes?: string[] }>("bots.import", { transfer });
    } catch (error) {
      // The import may have landed with only its reply lost: undone here, the bot would run in both places.
      const landed = await landedThere(client, bot.id);
      if (landed === "no") {
        await deps.step("moveBack", { id: bot.id }).catch(() => undefined);
        throw error;
      }
      if (landed === "unknown") {
        throw new Error(`It is not known whether ${bot.name} reached ${place.kind === "cloud" ? "the workspace" : "the machine"}, so it rests on ${thisComputer} for now and runs nowhere twice. Bring it back once ${place.kind === "cloud" ? "the workspace" : "the machine"} can be reached: that finds it either way. (${error instanceof Error ? error.message : String(error)})`);
      }
      imported = { bot: { ...bot, runsOn: "thisMac" } };
    }
    onStep("settling");
    const notes = [...(imported.notes ?? [])];
    if (place.kind === "cloud") {
      try {
        await deps.setIdleSuspend(place.orgId, place.workspaceId, BOT_IDLE_SUSPEND_MINUTES);
      } catch (error) {
        notes.push(`The workspace's idle time could not be set to ${BOT_IDLE_SUSPEND_MINUTES} minutes (${error instanceof Error ? error.message : String(error)}). It sleeps on its own setting.`);
      }
    }
    return { bot: { ...bot, runsOn: place.key }, notes };
  } finally {
    release();
  }
}

/** Bring `bot` back from where it lives to this Mac, with what it learned there. */
export async function bringBotBack(bot: Bot, onStep: (step: MoveStep) => void = () => undefined, deps: MoveDeps = liveDeps): Promise<MoveResult> {
  const place = runsOnPlace(bot.runsOn);
  if (place.kind === "thisMac") return { bot, notes: [] };
  if (place.kind === "other") throw new Error("A newer version of TerminalX moved this bot. Update TerminalX to bring it back.");
  onStep("connecting");
  const { client, release } = await deps.connect(place);
  try {
    needsBots(client, place.kind === "cloud" ? "that workspace" : "that machine");
    onStep("reading");
    let held: { transfer: string; parts: number };
    try {
      held = await client.call<{ transfer: string; parts: number }>("bots.export", { id: bot.id });
    } catch (error) {
      // A move whose import never landed there: the bot was only ever here, so it simply works here again.
      if (notThere(error) && (await landedThere(client, bot.id)) === "no") {
        const back = (await deps.step("moveBack", { id: bot.id })) as Bot;
        return { bot: back ?? { ...bot, runsOn: "thisMac" }, notes: [`${bot.name} had not reached it, so nothing came back: it works on ${thisComputer} again as it was.`] };
      }
      throw error;
    }
    const { transfer, parts: count } = held;
    let bundle = "";
    for (let index = 0; index < count; index++) bundle += (await client.call<{ data: string }>("bots.exportPart", { transfer, index })).data;
    onStep("bringing");
    const imported = (await deps.step("moveImport", { bundle })) as { bot: Bot; notes?: string[] };
    onStep("settling");
    try {
      await client.call("bots.remove", { id: bot.id });
    } catch (error) {
      // Its copy there still works: it stays the one that runs, and this Mac's copy rests again.
      await deps.step("moveOut", { id: bot.id, to: place.key }).catch(() => undefined);
      throw new Error(`${bot.name} could not be let go there, so it still runs there: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { bot: imported.bot, notes: imported.notes ?? [] };
  } finally {
    release();
  }
}
