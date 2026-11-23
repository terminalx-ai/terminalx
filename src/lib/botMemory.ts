import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { botsApi, errorMessage, invoke } from "@/lib/api";
import { holdQuit } from "@/lib/quitWarning";
import type { Bot } from "@/types/bots";
import type { BotChange, BotDiffLine, BotRoleMemory } from "@/types/botMemory";

/**
 * A bot's role and memory (PRO-470), as the owner reads and changes them in the app. Every change is recorded in the
 * bot's change log and can be undone; the app announces each recorded change as `bot_memory_changed`.
 */
export const botMemoryApi = {
  /** Everything the screen shows. Edits made to the files outside the app are recorded first. */
  view: (id: string) => invoke<BotRoleMemory>("bot_memory", { operation: "memoryView", params: { id } }),
  /** `place` is `bot`, `personal`, or an organisation the bot works in. */
  add: (id: string, place: string, text: string) => invoke<BotChange[]>("bot_memory", { operation: "memoryAdd", params: { id, place, text } }),
  /** `index` is the line's place in the file, so one of two equal notes is the one forgotten. */
  forget: (id: string, place: string, line: string, index?: number) => invoke<BotChange[]>("bot_memory", { operation: "memoryForget", params: { id, place, line, index } }),
  undo: (id: string, change: string) => invoke<BotChange>("bot_memory", { operation: "memoryUndo", params: { id, change } }),
  /** Put back the role a change left, or the role template's with `null`. */
  restoreRole: (id: string, change: string | null) => invoke<BotChange[]>("bot_memory", { operation: "roleRestore", params: { id, change } }),
  /** A version of the role by its hash; `null` when it is no longer kept. */
  text: (id: string, hash: string) => invoke<string | null>("bot_memory", { operation: "memoryText", params: { id, hash } }),
  /** From the role template's text to the role now; `null` with no template, or too long to compare. */
  roleDiff: (id: string) => invoke<BotDiffLine[] | null>("bot_memory", { operation: "roleDiff", params: { id } }),
  /** Look for edits made outside the app: one bot's files, or every bot's with no id (as the Bots page opens). */
  look: (id?: string) => invoke<{ found: number }>("bot_memory", { operation: "memoryLook", params: id ? { id } : {} }),
  /** `expected` is the hash of the text the editor started from: a role changed since is not written over. */
  writeRole: (id: string, text: string, expected: string) => botsApi.roleWrite(id, text, expected),
};

/** An unsaved edit of a bot's standing instructions: the text, and the role it started from. */
export interface RoleDraft {
  text: string;
  base: string;
  baseHash: string;
}

// Kept for the app's life, by bot: leaving the screen, or a list of the bots that could not be read, loses no edit.
// A bot that a whole list no longer has is deleted, and its draft goes with it (`keepRoleDraftsOf`).
const drafts = new Map<string, RoleDraft>();
// While any draft is unsaved, quitting the app or closing its window asks first (`quitWarning`).
let releaseQuit: (() => void) | null = null;

const UNSAVED_ROLE = "A bot's standing instructions have unsaved changes. If you quit now, they are lost.";

// Whether a draft can be reached: not while Bots is off, when no page shows one.
let reachable = true;

function holdQuitWhileDrafts() {
  const ask = reachable && drafts.size > 0;
  if (ask && !releaseQuit) releaseQuit = holdQuit(UNSAVED_ROLE);
  if (!ask && releaseQuit) {
    releaseQuit();
    releaseQuit = null;
  }
}

export function roleDraft(id: string): RoleDraft | undefined {
  return drafts.get(id);
}

/** Keep an edit, or drop it with `null` (saved or discarded). */
export function keepRoleDraft(id: string, draft: RoleDraft | null) {
  if (draft && draft.text !== draft.base) drafts.set(id, draft);
  else drafts.delete(id);
  holdQuitWhileDrafts();
}

/** Whether a bot's standing instructions have an unsaved edit. */
export function hasRoleDraft(id: string): boolean {
  return drafts.has(id);
}

/**
 * The bots there are, as a whole list of them says (PRO-512): the draft of a bot that is not one of them is dropped,
 * and the quit question with it. A deleted bot's role has nowhere to be saved, and no page shows its draft.
 */
export function keepRoleDraftsOf(ids: Iterable<string>) {
  const there = new Set(ids);
  for (const id of [...drafts.keys()]) if (!there.has(id)) drafts.delete(id);
  holdQuitWhileDrafts();
}

/**
 * Bots was turned off or on (PRO-512). Off, no page shows a draft, so quitting does not ask about one; the drafts
 * are kept, and asked about again once Bots is back on in this run of the app.
 */
export function roleDraftsReachable(on: boolean) {
  reachable = on;
  holdQuitWhileDrafts();
}

export function resetRoleDraftsForTests() {
  drafts.clear();
  reachable = true;
  holdQuitWhileDrafts();
}

export const MEMORY_CHANGED_EVENT = "bot_memory_changed";

export interface BotRoleMemoryState {
  view: BotRoleMemory | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * The screen's data for one bot: read when it shows, again whenever the app records a change to this bot's role or
 * memory, and when the window comes back to the front (a file edited in another app is found then). An answer that
 * arrives after a newer one is dropped.
 */
export function useBotRoleMemory(bot: Bot | null): BotRoleMemoryState {
  const id = bot?.id ?? null;
  const [view, setView] = useState<BotRoleMemory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const asked = useRef(0);

  const reload = useCallback(async () => {
    if (!id) return;
    const mine = ++asked.current;
    setLoading(true);
    try {
      const next = await botMemoryApi.view(id);
      if (mine === asked.current) {
        setView(next);
        setError(null);
      }
    } catch (cause) {
      if (mine === asked.current) setError(errorMessage(cause));
    } finally {
      if (mine === asked.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setView(null);
    setError(null);
    if (!id) return;
    void reload();
    let stop: (() => void) | null = null;
    let gone = false;
    listen<{ id?: string }>(MEMORY_CHANGED_EVENT, (event) => {
      if (event.payload?.id === id) void reload();
    }).then(
      (unlisten) => (gone ? unlisten() : (stop = unlisten)),
      () => {
        /* outside a webview */
      },
    );
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => {
      gone = true;
      stop?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [id, reload]);

  // The bot's record changed (its role title, its places, its memory switch): the view depends on it.
  // Only these fields matter: `view` and `reload` are left out on purpose, so a new answer does not ask again.
  const modified = bot?.modified;
  const worksIn = bot?.worksIn.join("\n");
  const off = bot?.memoryOff;
  const shown = view !== null;
  useEffect(() => {
    if (shown) void reload();
  }, [modified, worksIn, off]);

  return { view, error, loading, reload };
}

/** An organisation place's name: its name from the account, or the id the bot's record has when it is not known. */
export function placeName(key: string, orgNames: ReadonlyMap<string, string>): string {
  if (key === "personal") return "Personal";
  return orgNames.get(key) ?? key;
}

/** How a place is named on the screen. */
export function placeLabel(key: string, botName: string, orgNames: ReadonlyMap<string, string> = new Map()): string {
  if (key === "bot") return `Goes with ${botName}`;
  return `Stays in ${placeName(key, orgNames)}`;
}

/** The place's line under its name. */
export function placeNote(key: string, read: boolean, botName: string): string {
  if (key === "bot") return "How you like to work, lessons about the job";
  if (key === "personal") return read ? "Work for you alone" : `Not read while ${botName} works in an organisation`;
  return read ? "Code, people, decisions, anything from its repos" : `Not read while ${botName} works elsewhere`;
}

/** Who made a change, in words. */
export function byLabel(by: string, bots: Bot[]): string {
  if (by === "owner") return "you";
  if (by === "outside") return "outside the app";
  return bots.find((bot) => bot.id === by)?.name ?? "a removed bot";
}

/** The change's first line: what happened. A kind a newer app wrote is shown as itself. */
export function changeHeadline(change: BotChange): string {
  switch (change.kind) {
    case "learned":
      return `Learned: “${change.text}”`;
    case "forgot":
      return `Removed: “${change.text}”`;
    case "archived":
      return change.text;
    // A nightly tidy (PRO-477): its merges and removals, one change one Undo puts back.
    case "tidied":
      return change.text || "Tidied memory";
    case "role":
      return "Changed the standing instructions";
    case "restored":
      return "Put back an earlier role";
    case "outside":
      return `Edited outside the app: ${change.text}`;
    case "undo":
      return `Undid: ${change.text}`;
    default:
      return change.text ? `${change.kind}: ${change.text}` : change.kind;
  }
}

/** Where a change came from, as the line under it. */
export function changeSource(change: BotChange, bots: Bot[]): string {
  const by = byLabel(change.by, bots);
  const source = change.source;
  switch (source.kind) {
    case "chat":
      return `From ${by === "you" ? "your" : `${by}'s`} chat${source.title ? ` · ${source.title}` : ""}`;
    case "duty":
      return `From a duty${source.duty ? ` · ${source.duty}` : ""}`;
    case "app":
      return `By ${by} in the app`;
    case "cli":
      return `By ${by} from the terminal`;
    case "outside":
      return "Edited outside the app";
    case "budget":
      return `Kept within the line budget`;
    case "undo":
      return `Undone by ${by}`;
    default:
      return source.kind;
  }
}
