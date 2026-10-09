import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ShareRole = "viewer" | "driver";
export interface SharePerson {
  userId: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
}
export interface ShareSettings {
  audience: "anyone" | "people" | "organization";
  role: ShareRole;
  people: { email: string; role: ShareRole }[];
  expiresAt: number;
  approveEachPerson: boolean;
  canApprove: boolean;
  maximumPeople: number;
  singleUse: boolean;
}
export interface ShareLink {
  id: string;
  url: string;
  settings: ShareSettings;
  directOnly: boolean;
  revoked: boolean;
}
export interface ShareState {
  active: boolean;
  links: ShareLink[] | null;
  people: {
    person: SharePerson;
    role: ShareRole;
    canApprove: boolean;
    admitted: boolean;
    connections: number;
    viewing: string[];
    typing: boolean;
    linkIds: string[];
    pendingLinkIds?: string[];
  }[];
  leases: { tabId: string; holder: SharePerson; expiresAt: number }[];
  notes: { id: string; author: SharePerson; text: string; createdAt: number }[];
  activity: { id: string; userId: string; action: string; createdAt: number }[];
  queue: { tabId: string; text: string; author: SharePerson }[];
}
export const EMPTY_SHARE: ShareState = {
  active: false,
  links: [],
  people: [],
  leases: [],
  notes: [],
  activity: [],
  queue: [],
};
const states = new Map<string, ShareState>();
const subscribers = new Set<() => void>();
let dialog: string | null = null;
let boot: Promise<void> | null = null;
function notify() {
  for (const listener of subscribers) listener();
}
const subscribe = (listener: () => void) => {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
};
export function useShareDialog() {
  return useSyncExternalStore(
    subscribe,
    () => dialog,
    () => null,
  );
}
export function openSessionShare(sessionId: string) {
  dialog = sessionId;
  notify();
}
export function closeSessionShare() {
  dialog = null;
  notify();
}
export function useLocalShare(sessionId: string) {
  return useSyncExternalStore(
    subscribe,
    () => states.get(sessionId) ?? EMPTY_SHARE,
    () => EMPTY_SHARE,
  );
}
function apply(sessionId: string, state: ShareState) {
  states.set(sessionId, state);
  notify();
}
export async function bootLocalSharing() {
  return (boot ??= listen<{ sessionId: string; state: ShareState }>("session_share_changed", ({ payload }) =>
    apply(payload.sessionId, payload.state),
  ).then(() => undefined));
}
export async function refreshShare(sessionId: string) {
  await bootLocalSharing();
  apply(sessionId, await invoke<ShareState>("session_share_status", { sessionId }));
}
export async function createShare(sessionId: string, settings: ShareSettings, directOnly: boolean) {
  apply(sessionId, await invoke<ShareState>("session_share_create", { sessionId, settings, directOnly }));
}
export async function changeShare(sessionId: string, action: string, params: Record<string, unknown> = {}) {
  apply(sessionId, await invoke<ShareState>("session_share_change", { sessionId, action, params }));
}
export function defaultShareSettings(): ShareSettings {
  return {
    audience: "anyone",
    role: "driver",
    people: [],
    expiresAt: Date.now() + 3_600_000,
    approveEachPerson: false,
    canApprove: false,
    maximumPeople: 8,
    singleUse: false,
  };
}
