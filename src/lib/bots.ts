import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { botsApi } from "@/lib/api";
import type { Bot, BotPatch, BotRoleTemplate } from "@/types/bots";

/**
 * The bots (PRO-466), as every view sees them. Booted only while Settings →
 * Experimental → Bots is on: off, nothing here listens or asks the app for
 * anything, and the store stays empty.
 */
interface State {
  loaded: boolean;
  bots: Bot[];
  /** The bundled role templates, read the first time they are asked for. */
  templates: BotRoleTemplate[] | null;
}

const EMPTY: State = { loaded: false, bots: [], templates: null };
let state: State = EMPTY;
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

/** Counts the boots and shuts so an answer that arrives after the switch went off is dropped. */
let generation = 0;
let booted = false;
let unlisten: (() => void)[] = [];

async function listBots(mine: number) {
  try {
    const bots = await botsApi.list();
    if (mine === generation) set({ bots, loaded: true });
  } catch {
    if (mine === generation) set({ loaded: true });
  }
}

export async function bootBots() {
  if (booted) return;
  booted = true;
  const mine = ++generation;
  try {
    const stops = await Promise.all([
      listen<Bot[]>("bots_changed", (event) => {
        if (mine === generation && Array.isArray(event.payload)) set({ bots: event.payload, loaded: true });
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

function upsert(bot: Bot) {
  const exists = state.bots.some((value) => value.id === bot.id);
  set({ bots: exists ? state.bots.map((value) => (value.id === bot.id ? bot : value)) : [...state.bots, bot] });
  return bot;
}

export async function loadBotTemplates(): Promise<BotRoleTemplate[]> {
  if (state.templates) return state.templates;
  const templates = await botsApi.templates();
  set({ templates });
  return templates;
}

/** Hire a bot: a role and a name are all it asks for. */
export async function createBot(roleTemplateId: string, name: string) {
  return upsert(await botsApi.create(roleTemplateId, name));
}

export async function updateBot(id: string, patch: BotPatch) {
  return upsert(await botsApi.update(id, patch));
}

export async function deleteBot(id: string) {
  await botsApi.remove(id);
  set({ bots: state.bots.filter((value) => value.id !== id) });
}

export async function pauseBot(id: string) {
  return upsert(await botsApi.pause(id));
}

export async function resumeBot(id: string) {
  return upsert(await botsApi.resume(id));
}

export async function pauseAllBots() {
  const bots = await botsApi.pauseAll();
  set({ bots });
  return bots;
}

export async function resumeAllBots() {
  const bots = await botsApi.resumeAll();
  set({ bots });
  return bots;
}

/** For tests: forget everything, listeners included. */
export function resetBotsForTests() {
  shutBots();
  state = EMPTY;
  listeners.clear();
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
