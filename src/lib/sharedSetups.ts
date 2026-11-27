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

/** The active organization, when it is a team one with shared setups switched on. */
export function sharedSetupsOrg(status: AccountStatus): { id: string; name: string; isAdmin: boolean } | null {
  const id = status?.identity?.organizationId;
  if (!status || !id || !phase2Ready(status, id, "sharedSetups")) return null;
  const org = status.organizations?.find((candidate) => candidate.id === id);
  if (!org || org.isPersonal) return null;
  return { id, name: org.name, isAdmin: org.role === "owner" || org.role === "admin" };
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

// ---- cached organization state: the prompts actions read as they send, and the snippets the composer offers

interface Cache {
  orgId: string | null;
  prompts: SharedPrompts | null;
  snippets: OrganizationSnippet[];
}

let cache: Cache = { orgId: null, prompts: null, snippets: [] };
const listeners = new Set<() => void>();
const loading = new Map<string, Promise<void>>();

function setCache(next: Cache) {
  cache = next;
  for (const listener of listeners) listener();
}

/** Read the organization's prompts and snippets again; quietly keeps what it had when the server cannot answer. */
export function refreshSharedSetups(orgId: string): Promise<void> {
  const running = loading.get(orgId);
  if (running) return running;
  const work = Promise.all([sharedSetupsApi.prompts(orgId), sharedSetupsApi.snippets(orgId)])
    .then(([prompts, snippets]) => {
      if (sharedSetupsOrg(getAccount().status)?.id === orgId) setCache({ orgId, prompts, snippets });
    })
    .catch(() => {})
    .finally(() => loading.delete(orgId));
  loading.set(orgId, work);
  return work;
}

export function setCachedPrompts(orgId: string, prompts: SharedPrompts) {
  if (cache.orgId === orgId) setCache({ ...cache, prompts });
}

export function setCachedSnippets(orgId: string, snippets: OrganizationSnippet[]) {
  if (cache.orgId === orgId) setCache({ ...cache, snippets });
}

const EMPTY: Cache = { orgId: null, prompts: null, snippets: [] };

function current(): Cache {
  const org = sharedSetupsOrg(getAccount().status);
  return org && cache.orgId === org.id ? cache : EMPTY;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

let lastCurrent: Cache = EMPTY;
const snapshot = () => {
  const next = current();
  if (next.orgId !== lastCurrent.orgId || next.prompts !== lastCurrent.prompts || next.snippets !== lastCurrent.snippets) lastCurrent = next;
  return lastCurrent;
};

/** The active organization's snippets, loaded on first use. */
export function useOrganizationSnippets(): OrganizationSnippet[] {
  const org = useSharedSetupsOrg();
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (org) void refreshSharedSetups(org.id);
  }, [org]);
  return org ? state.snippets : [];
}

/** The person's own prompt for an action, kept on this computer. */
export function personalPrompt(action: ActionPromptKey): string {
  const prefs = getPrefs();
  return (action === "fixChecks" ? prefs.fixErrorsInstructions : prefs.actionPrompts[action] ?? "").trim();
}

/**
 * The instructions an action carries: the organization's first, then the
 * person's own (owner decision, 2026-11-26). Empty when neither has any.
 */
export function actionInstructions(action: ActionPromptKey): string {
  const org = sharedSetupsOrg(getAccount().status);
  if (org && cache.orgId !== org.id) void refreshSharedSetups(org.id);
  const shared = current().prompts?.prompts[action]?.body.trim() ?? "";
  return [shared, personalPrompt(action)].filter(Boolean).join("\n\n");
}

/** `prompt` with the action's instructions after it, or as it was when there are none. */
export function withActionPrompt(prompt: string, action: ActionPromptKey): string {
  const instructions = actionInstructions(action);
  return instructions ? `${prompt}\n\nAdditional instructions:\n${instructions}` : prompt;
}

/** What a new chat's first message carries: general instructions, then branch names. */
export function withNewChatPrompts(prompt: string): string {
  const general = actionInstructions("general");
  const branches = actionInstructions("branchNames");
  const parts = [general, branches && `When you name a branch:\n${branches}`].filter(Boolean);
  return parts.length ? `${prompt}\n\nAdditional instructions:\n${parts.join("\n\n")}` : prompt;
}
