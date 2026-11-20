import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { botsApi } from "@/lib/api";
import type { Bot, BotList, BotPatch, BotRoleTemplate } from "@/types/bots";

/**
 * The bots (PRO-466), as every view sees them. Booted only while Settings →
 * Experimental → Bots is on: off, nothing here listens or asks the app for
 * anything, and the store stays empty.
 *
 * Every whole list the app sends (`bots_changed`, a list read at boot or on
 * reattaching, the pause-all answers) carries the store's revision, and the
 * newest one wins: a list read earlier never replaces a newer one.
 */
interface State {
  loaded: boolean;
  bots: Bot[];
  /** The revision `bots` came from; -1 before anything was read. */
  revision: number;
  /** Records the app cannot read (a newer app's). They exist; they are not shown. */
  unreadable: number;
  /** Why the bots could not be read. Not the same as having none: a view must not offer a first hire over it. */
  error: string | null;
  /** The bundled role templates, read the first time they are asked for. */
  templates: BotRoleTemplate[] | null;
}

const EMPTY: State = { loaded: false, bots: [], revision: -1, unreadable: 0, error: null, templates: null };
let state: State = EMPTY;
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function reason(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function isList(value: unknown): value is BotList {
  return !!value && typeof value === "object" && Array.isArray((value as BotList).bots) && typeof (value as BotList).revision === "number";
}

/** Take a whole list unless a newer one is already here. */
function take(list: BotList) {
  if (list.revision < state.revision) return;
  set({ bots: list.bots, revision: list.revision, unreadable: list.unreadable ?? 0, loaded: true, error: null });
}

/** Counts the boots and shuts so an answer that arrives after the switch went off is dropped. */
let generation = 0;
let booted = false;
let unlisten: (() => void)[] = [];

async function listBots(mine: number) {
  try {
    const list = await botsApi.list();
    if (mine === generation && isList(list)) take(list);
  } catch (error) {
    // The bots are unknown, not absent: keep what was read and say why.
    if (mine === generation) set({ loaded: true, error: reason(error) });
  }
}

export async function bootBots() {
  if (booted) return;
  booted = true;
  const mine = ++generation;
  try {
    const stops = await Promise.all([
      listen<BotList>("bots_changed", (event) => {
        if (mine === generation && isList(event.payload)) take(event.payload);
      }),
      // Changes made while the live connection was down were not announced.
      listen("local_runtime_reattached", () => void listBots(mine)),
    ]);
    if (mine === generation) unlisten = stops;
    else for (const stop of stops) stop();
  } catch {
    /* outside a webview */
  }
  await listBots(mine);
}

/** The switch went off: stop listening and forget what was read. */
export function shutBots() {
  if (!booted) return;
  booted = false;
  generation++;
  for (const stop of unlisten) stop();
  unlisten = [];
  set(EMPTY);
}

export function useBotStore(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export function getBotStore(): State {
  return state;
}

/**
 * Run a change and take its answer at once, unless a list arrived while it
 * ran: that list is as new as this change or newer, and this change's own
 * `bots_changed` follows it.
 */
async function changed<T>(request: () => Promise<T>, apply: (answer: T) => void): Promise<T> {
  const before = state.revision;
  const answer = await request();
  if (state.revision === before) apply(answer);
  return answer;
}

function upsert(bot: Bot) {
  const exists = state.bots.some((value) => value.id === bot.id);
  set({ bots: exists ? state.bots.map((value) => (value.id === bot.id ? bot : value)) : [...state.bots, bot] });
}

export async function loadBotTemplates(): Promise<BotRoleTemplate[]> {
  if (state.templates) return state.templates;
  const templates = await botsApi.templates();
  set({ templates });
  return templates;
}

/** Hire a bot: a role and a name are all it asks for. */
export function createBot(roleTemplateId: string, name: string) {
  return changed(() => botsApi.create(roleTemplateId, name), upsert);
}

export function updateBot(id: string, patch: BotPatch) {
  return changed(() => botsApi.update(id, patch), upsert);
}

export async function deleteBot(id: string) {
  await changed(() => botsApi.remove(id), () => set({ bots: state.bots.filter((value) => value.id !== id) }));
}

export function pauseBot(id: string) {
  return changed(() => botsApi.pause(id), upsert);
}

export function resumeBot(id: string) {
  return changed(() => botsApi.resume(id), upsert);
}

export async function pauseAllBots() {
  const list = await botsApi.pauseAll();
  take(list);
  return list.bots;
}

export async function resumeAllBots() {
  const list = await botsApi.resumeAll();
  take(list);
  return list.bots;
}

/** For tests: forget everything, listeners included. */
export function resetBotsForTests() {
  shutBots();
  state = EMPTY;
  listeners.clear();
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
