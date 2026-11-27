/**
 * PRO-154: what a team shares through the server: each member's favourite
 * model slots, organization snippets and the per-action prompts owners and
 * admins set. All of it is behind `team.shared-setups.v1`, off by default.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { getAccount, useAccount } from "@/lib/account";
import type { AccountStatus } from "@/lib/api";
import { phase2Ready } from "@/lib/phase2Readiness";
import { cloudKeyOrgId } from "@/lib/multiOrg";
import { getPrefs, type FavouriteSlot, type PersonalPromptKey } from "@/lib/prefs";

export type ActionPromptKey = PersonalPromptKey | "fixChecks";

/** The six actions, in the order Settings › Prompts lists them. */
export const ACTION_PROMPTS: { key: ActionPromptKey; title: string; personal: string; shared: string }[] = [
  { key: "general", title: "General instructions", personal: "Sent at the start of every new chat.", shared: "Sent at the start of every new chat." },
  { key: "review", title: "Review", personal: "Sent when you ask for a review.", shared: "Sent when someone asks for a review." },
  { key: "createPr", title: "Create pull request", personal: "Sent when you ask the agent to open a pull request.", shared: "Sent when someone asks the agent to open a pull request." },
  { key: "fixChecks", title: "Fix failing checks", personal: "Sent with Fix from the Checks tab.", shared: "Sent with Fix from the Checks tab." },
  { key: "resolveConflicts", title: "Resolve conflicts", personal: "Sent when a merge or rebase stops on conflicts.", shared: "Sent when a merge or rebase stops on conflicts." },
  { key: "branchNames", title: "Branch names", personal: "Sent with a new chat, for the branches the agent names.", shared: "Sent with a new chat, for the branches the agent names." },
];

export interface SharedSlotSet {
  userId: string;
  slots: (FavouriteSlot | null)[];
  updatedAt: string;
}

export interface OrganizationSnippet {
  id: string;
  name: string;
  keyword: string;
  body: string;
  createdBy: string;
  updatedAt: string;
  /** The signed-in person created it: set by the app from the account, not by the server. */
  mine?: boolean;
}

export interface SharedPrompt {
  /** Empty when cleared: the row stays, with who cleared it. */
  body: string;
  updatedBy: string | null;
  updatedAt: string;
  /** What a save sends back; another admin's newer save makes it a conflict. */
  revision: number;
}

export interface SharedPrompts {
  canEdit: boolean;
  prompts: Partial<Record<ActionPromptKey, SharedPrompt>>;
}

type Op =
  | { op: "listSlots" | "stopSharingSlots" | "listSnippets" | "listPrompts" }
  | { op: "shareSlots"; slots: (FavouriteSlot | null)[] }
  | { op: "createSnippet"; snippet: { name: string; keyword: string; body: string } }
  | { op: "updateSnippet"; id: string; snippet: { name: string; keyword: string; body: string } }
  | { op: "deleteSnippet"; id: string }
  | { op: "savePrompt"; action: ActionPromptKey; body: string; revision: number };

const call = <T>(orgId: string, op: Op) => invoke<T>("shared_setups", { orgId, op });

export const sharedSetupsApi = {
  slots: (orgId: string) => call<{ sets: SharedSlotSet[]; shared: boolean }>(orgId, { op: "listSlots" }),
  shareSlots: (orgId: string, slots: (FavouriteSlot | null)[]) => call<SharedSlotSet>(orgId, { op: "shareSlots", slots }),
  stopSharingSlots: (orgId: string) => call<{ shared: false }>(orgId, { op: "stopSharingSlots" }),
  snippets: (orgId: string) => call<{ snippets: OrganizationSnippet[] }>(orgId, { op: "listSnippets" }).then((answer) => answer.snippets),
  createSnippet: (orgId: string, snippet: { name: string; keyword: string; body: string }) => call<OrganizationSnippet>(orgId, { op: "createSnippet", snippet }),
  updateSnippet: (orgId: string, id: string, snippet: { name: string; keyword: string; body: string }) => call<OrganizationSnippet>(orgId, { op: "updateSnippet", id, snippet }),
  deleteSnippet: (orgId: string, id: string) => call<{ deleted: true }>(orgId, { op: "deleteSnippet", id }),
  prompts: (orgId: string) => call<SharedPrompts>(orgId, { op: "listPrompts" }),
  savePrompt: (orgId: string, action: ActionPromptKey, body: string, revision: number) =>
    call<SharedPrompt & { action: ActionPromptKey }>(orgId, { op: "savePrompt", action, body, revision }),
};

/** An organization's name short enough for a tab, a chip or a scope option: “A very long organiz…”. */
export function orgLabel(name: string, max = 24): string {
  const chars = [...name];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : name;
}

/** An organization of this person's, when it is a team one with shared setups switched on. */
export function sharedSetupsOrgFor(status: AccountStatus, orgId: string | null | undefined): { id: string; name: string; isAdmin: boolean } | null {
  if (!status || status.state !== "signed-in" || !orgId || !phase2Ready(status, orgId, "sharedSetups")) return null;
  const org = status.organizations?.find((candidate) => candidate.id === orgId);
  if (!org || org.isPersonal) return null;
  return { id: orgId, name: org.name, isAdmin: org.role === "owner" || org.role === "admin" };
}

/** The active organization, when it is a team one with shared setups switched on. */
export function sharedSetupsOrg(status: AccountStatus): { id: string; name: string; isAdmin: boolean } | null {
  return sharedSetupsOrgFor(status, status?.identity?.organizationId);
}

export function useSharedSetupsOrg() {
  const { status } = useAccount();
  const org = sharedSetupsOrg(status);
  // One object per organization and role, so effects keyed on it run once.
  return useStableOrg(org);
}

let stableOrg: ReturnType<typeof sharedSetupsOrg> = null;
function useStableOrg(org: ReturnType<typeof sharedSetupsOrg>) {
  if (org?.id !== stableOrg?.id || org?.name !== stableOrg?.name || org?.isAdmin !== stableOrg?.isAdmin) stableOrg = org;
  return stableOrg;
}

// ---- cached organization state, per organization: the prompts actions read as they send, and the snippets the composer offers

interface Entry {
  prompts: SharedPrompts | null;
  snippets: OrganizationSnippet[];
  /** When the server last answered; 0 before it has. */
  at: number;
}

/** How old an organization's prompts may be before they are read again (review of #1674). */
export const SHARED_SETUPS_FRESH_MS = 3 * 60_000;

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const loading = new Map<string, Promise<void>>();

function setEntry(orgId: string, entry: Entry) {
  cache.set(orgId, entry);
  for (const listener of listeners) listener();
}

/**
 * Read an organization's prompts and snippets again. When the server cannot
 * answer, what was read before stays: the fallback while offline.
 */
export function refreshSharedSetups(orgId: string): Promise<void> {
  const running = loading.get(orgId);
  if (running) return running;
  const work = Promise.all([sharedSetupsApi.prompts(orgId), sharedSetupsApi.snippets(orgId)])
    .then(([prompts, snippets]) => {
      if (sharedSetupsOrgFor(getAccount().status, orgId)) setEntry(orgId, { prompts, snippets, at: Date.now() });
    })
    .catch(() => {})
    .finally(() => loading.delete(orgId));
  loading.set(orgId, work);
  return work;
}

/** Read again every organization already read whose copy is older than `SHARED_SETUPS_FRESH_MS`, and the active one. */
export function refreshStaleSharedSetups(now = Date.now()): void {
  const status = getAccount().status;
  const active = sharedSetupsOrg(status)?.id;
  const ids = new Set([...cache.keys(), ...(active ? [active] : [])]);
  for (const id of ids) {
    if (!sharedSetupsOrgFor(status, id)) { cache.delete(id); continue; }
    if (now - (cache.get(id)?.at ?? 0) >= SHARED_SETUPS_FRESH_MS) void refreshSharedSetups(id);
  }
}

/** Keeps the shared prompts and snippets current: on a schedule, when the window comes back, and when the organization changes. Mounted once, in the app shell. */
export function useSharedSetupsSync(): void {
  const org = useSharedSetupsOrg();
  useEffect(() => {
    if (org) void refreshSharedSetups(org.id);
  }, [org]);
  useEffect(() => {
    const timer = setInterval(() => refreshStaleSharedSetups(), SHARED_SETUPS_FRESH_MS);
    const onFocus = () => refreshStaleSharedSetups();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, []);
}

export function setCachedPrompts(orgId: string, prompts: SharedPrompts) {
  const entry = cache.get(orgId);
  setEntry(orgId, { snippets: entry?.snippets ?? [], prompts, at: entry?.at ?? 0 });
}

export function setCachedSnippets(orgId: string, snippets: OrganizationSnippet[]) {
  const entry = cache.get(orgId);
  setEntry(orgId, { prompts: entry?.prompts ?? null, snippets, at: entry?.at ?? 0 });
}

const NO_SNIPPETS: OrganizationSnippet[] = [];

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const activeSnippets = () => {
  const org = sharedSetupsOrg(getAccount().status);
  return (org && cache.get(org.id)?.snippets) || NO_SNIPPETS;
};

/** The active organization's snippets, loaded on first use. */
export function useOrganizationSnippets(): OrganizationSnippet[] {
  const org = useSharedSetupsOrg();
  const snippets = useSyncExternalStore(subscribe, activeSnippets, activeSnippets);
  useEffect(() => {
    if (org) void refreshSharedSetups(org.id);
  }, [org]);
  return org ? snippets : NO_SNIPPETS;
}

/** The person's own prompt for an action, kept on this computer. */
export function personalPrompt(action: ActionPromptKey): string {
  const prefs = getPrefs();
  return (action === "fixChecks" ? prefs.fixErrorsInstructions : prefs.actionPrompts[action] ?? "").trim();
}

/**
 * Where a message goes: a cloud session, workspace or project key
 * (`cloud:<orgId>:…`) names its organization; anything else (a local or
 * machine session, a personal project) has none.
 */
export type PromptTarget = string | null | undefined;

/** The organization whose shared prompts a message to `target` carries: its own, never the active one. */
export function promptOrg(target: PromptTarget): string | null {
  const id = cloudKeyOrgId(target);
  return id && sharedSetupsOrgFor(getAccount().status, id) ? id : null;
}

/**
 * The instructions an action carries: the target organization's first, then
 * the person's own (owner decision, 2026-11-26). Empty when neither has any.
 * A copy older than a few minutes is read again for next time.
 */
export function actionInstructions(action: ActionPromptKey, target: PromptTarget): string {
  const orgId = promptOrg(target);
  const entry = orgId ? cache.get(orgId) : undefined;
  if (orgId && Date.now() - (entry?.at ?? 0) >= SHARED_SETUPS_FRESH_MS) void refreshSharedSetups(orgId);
  const shared = entry?.prompts?.prompts[action]?.body.trim() ?? "";
  return [shared, personalPrompt(action)].filter(Boolean).join("\n\n");
}

/** How long a send waits for an organization's prompts it has never read, before going without them. */
export const PRIME_TIMEOUT_MS = 1500;

/**
 * Before the first send to an organization this window has not read yet:
 * read its prompts, waiting at most `timeoutMs`. Anything already read (even
 * stale) is used as it is, and refreshed in the background.
 */
export async function primeSharedPrompts(target: PromptTarget, timeoutMs = PRIME_TIMEOUT_MS): Promise<void> {
  const orgId = promptOrg(target);
  if (!orgId || cache.has(orgId)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([refreshSharedSetups(orgId), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  clearTimeout(timer);
}

const cacheHas = (orgId: string | null) => () => !!orgId && cache.has(orgId);

/** For prompts built while rendering (a step's text): reads the target's organization once, and renders again when it arrives. */
export function useSharedPromptsFor(target: PromptTarget): void {
  const orgId = promptOrg(target);
  useSyncExternalStore(subscribe, cacheHas(orgId), cacheHas(orgId));
  useEffect(() => {
    if (orgId && !cache.has(orgId)) void refreshSharedSetups(orgId);
  }, [orgId]);
}

/** `prompt` with the action's instructions after it, or as it was when there are none. */
export function withActionPrompt(prompt: string, action: ActionPromptKey, target: PromptTarget): string {
  const instructions = actionInstructions(action, target);
  return instructions ? `${prompt}\n\nAdditional instructions:\n${instructions}` : prompt;
}

/** What a new chat's first message carries: general instructions, then branch names. Applied once, where the message is sent. */
export function withNewChatPrompts(prompt: string, target: PromptTarget): string {
  if (!prompt.trim()) return prompt;
  const general = actionInstructions("general", target);
  const branches = actionInstructions("branchNames", target);
  const parts = [general, branches && `When you name a branch:\n${branches}`].filter(Boolean);
  return parts.length ? `${prompt}\n\nAdditional instructions:\n${parts.join("\n\n")}` : prompt;
}
