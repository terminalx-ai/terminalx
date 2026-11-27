/**
 * Favourite model slots (PRO-154): five places for an agent, model, effort
 * and mode. Slot 1 is the default for new chats. Until the slot editor of
 * PRO-219 lands, slots are filled from the current model or by equipping a
 * teammate's set, which replaces all five after a confirmation.
 */
import { getPrefs, setPrefs, type FavouriteSlot } from "@/lib/prefs";
import { modelLabel } from "@/lib/models";

export const SLOT_COUNT = 5;

export function padSlots(slots: readonly (FavouriteSlot | null)[]): (FavouriteSlot | null)[] {
  return Array.from({ length: SLOT_COUNT }, (_, index) => slots[index] ?? null);
}

export function mySlots(): (FavouriteSlot | null)[] {
  return padSlots(getPrefs().favouriteSlots);
}

export function sameSlot(a: FavouriteSlot | null, b: FavouriteSlot | null): boolean {
  return !!a && !!b && a.agent === b.agent && a.model === b.model && a.effort === b.effort && a.mode === b.mode && a.fast === b.fast;
}

/** "Opus 5.5", and the effort beside it when there is one. */
export function slotLabel(slot: FavouriteSlot): { model: string; effort: string | null } {
  const effort = slot.effort ? slot.effort.charAt(0).toUpperCase() + slot.effort.slice(1) : null;
  return { model: modelLabel(slot.agent, slot.model), effort };
}

/** What a new chat starts with now, as a slot. */
export function currentModelSlot(): FavouriteSlot | null {
  const prefs = getPrefs();
  const agent = prefs.lastAgent;
  const model = prefs.lastModel[agent];
  if (!agent || !model) return null;
  return { agent, model, effort: prefs.lastEffort[agent] ?? null, mode: prefs.lastMode || null, fast: false };
}

/** Slot 1 is what new chats start with: its agent, model, effort and mode. */
function applyDefault(slot: FavouriteSlot | null) {
  if (!slot) return;
  const prefs = getPrefs();
  setPrefs({
    lastAgent: slot.agent,
    lastModel: { ...prefs.lastModel, [slot.agent]: slot.model },
    lastEffort: slot.effort ? { ...prefs.lastEffort, [slot.agent]: slot.effort } : prefs.lastEffort,
    ...(slot.mode ? { lastMode: slot.mode } : {}),
  });
}

export interface EquipUndo {
  slots: (FavouriteSlot | null)[];
  lastAgent: string;
  lastModel: Record<string, string>;
  lastEffort: Record<string, string>;
  lastMode: string;
}

/** Replace all five slots with a teammate's; what to restore if the person undoes it. */
export function equipSlots(slots: readonly (FavouriteSlot | null)[]): EquipUndo {
  const prefs = getPrefs();
  const undo: EquipUndo = { slots: mySlots(), lastAgent: prefs.lastAgent, lastModel: prefs.lastModel, lastEffort: prefs.lastEffort, lastMode: prefs.lastMode };
  const next = padSlots(slots);
  setPrefs({ favouriteSlots: next });
  applyDefault(next[0] ?? null);
  return undo;
}

export function undoEquip(undo: EquipUndo) {
  setPrefs({ favouriteSlots: undo.slots, lastAgent: undo.lastAgent, lastModel: undo.lastModel, lastEffort: undo.lastEffort, lastMode: undo.lastMode });
}

export function setSlot(index: number, slot: FavouriteSlot | null) {
  const next = mySlots();
  next[index] = slot;
  setPrefs({ favouriteSlots: next });
  if (index === 0) applyDefault(slot);
}

// ---- terminalx://slots?d=… links

export const SLOTS_LINK_PREFIX = "terminalx://slots?d=";

interface LinkBody {
  v: 1;
  from: string;
  slots: (FavouriteSlot | null)[];
}

const toBase64Url = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (data: string) => {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

export function slotsLink(from: string, slots: readonly (FavouriteSlot | null)[]): string {
  const body: LinkBody = { v: 1, from: from.slice(0, 80), slots: shareableSlots(slots) };
  return `${SLOTS_LINK_PREFIX}${toBase64Url(JSON.stringify(body))}`;
}

// The same values the server takes (PRO-154 review): nothing free-form, no mode that skips approvals.
export const SHARED_AGENTS = ["claude", "codex", "opencode"] as const;
export const SHARED_MODES = ["plan", "manual", "auto", "acceptEdits"] as const;
export const SHARED_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
// A model id, or provider/id: never a URL.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?(\[[a-z0-9]{1,8}\])?$/;
const SLOT_KEYS = new Set(["agent", "model", "effort", "mode", "fast"]);

const oneOf = (values: readonly string[], value: unknown): value is string => typeof value === "string" && values.includes(value);

/** A slot someone else sent, checked as the server checks it; undefined when it is not one. */
export function asSharedSlot(value: unknown): FavouriteSlot | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const slot = value as Record<string, unknown>;
  if (Object.keys(slot).some((key) => !SLOT_KEYS.has(key))) return undefined;
  if (!oneOf(SHARED_AGENTS, slot.agent) || typeof slot.model !== "string" || !MODEL_ID.test(slot.model)) return undefined;
  if (slot.effort != null && !oneOf(SHARED_EFFORTS, slot.effort)) return undefined;
  if (slot.mode != null && !oneOf(SHARED_MODES, slot.mode)) return undefined;
  if (slot.fast !== undefined && typeof slot.fast !== "boolean") return undefined;
  return { agent: slot.agent, model: slot.model, effort: (slot.effort as string | null | undefined) ?? null, mode: (slot.mode as string | null | undefined) ?? null, fast: slot.fast === true };
}

/** Five slots someone else sent, all valid and at least one filled; null otherwise. */
export function asSharedSlots(value: unknown): (FavouriteSlot | null)[] | null {
  if (!Array.isArray(value) || value.length !== SLOT_COUNT) return null;
  const slots = value.map(asSharedSlot);
  if (slots.some((slot) => slot === undefined) || slots.every((slot) => slot === null)) return null;
  return slots as (FavouriteSlot | null)[];
}

/**
 * Your slots as they may be shared: only those fields, and a mode the server
 * takes (a slot in Bypass permissions is shared without its mode). A slot the
 * server would refuse outright is left empty.
 */
export function shareableSlots(slots: readonly (FavouriteSlot | null)[]): (FavouriteSlot | null)[] {
  return padSlots(slots).map((slot) => {
    if (!slot) return null;
    const clean = { agent: slot.agent, model: slot.model, effort: slot.effort, mode: oneOf(SHARED_MODES, slot.mode) ? slot.mode : null, fast: slot.fast };
    return asSharedSlot(clean) ?? null;
  });
}

/** A link's slots and who sent them; null when it has none it can be trusted with (cut off, or not slots at all). */
export function readSlotsLink(data: string): { from: string; slots: (FavouriteSlot | null)[] } | null {
  try {
    const body = JSON.parse(fromBase64Url(data)) as Partial<LinkBody>;
    if (!body || typeof body !== "object" || body.v !== 1) return null;
    if (Object.keys(body).some((key) => !["v", "from", "slots"].includes(key))) return null;
    const slots = asSharedSlots(body.slots);
    if (!slots) return null;
    const from = typeof body.from === "string" && !/[\u0000-\u001F\u007F]/.test(body.from) ? body.from.trim().slice(0, 80) : "";
    return { from: from || "A teammate", slots };
  } catch {
    return null;
  }
}
