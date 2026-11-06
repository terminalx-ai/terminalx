import { useSyncExternalStore } from "react";
import { invoke } from "@/lib/api";
import { listen } from "@tauri-apps/api/event";
import { copyText } from "@/lib/clipboard";

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
/** The session whose Share dialog is open, if one is. */
export function shownShareDialog(): string | null {
  return dialog;
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
type ShareGuest = ShareState["people"][number];
/** A guest the host has yet to admit, to the session or to one more of its links: what the dialog offers Admit for. */
export function isWaitingGuest(guest: ShareGuest): boolean {
  return !guest.admitted || !!guest.pendingLinkIds?.length;
}
/** Someone asked to join a shared session and waits for the host (each link approves people by default, PRO-162). */
export interface JoinRequest {
  sessionId: string;
  person: SharePerson;
}
const joinListeners = new Set<(request: JoinRequest) => void>();
/** Hear each person who starts waiting to be admitted: once per wait, not for every update while they wait. */
export function onJoinRequest(listener: (request: JoinRequest) => void): () => void {
  joinListeners.add(listener);
  return () => joinListeners.delete(listener);
}
function apply(sessionId: string, state: ShareState) {
  const waitedBefore = new Set((states.get(sessionId)?.people ?? []).filter(isWaitingGuest).map((guest) => guest.person.userId));
  states.set(sessionId, state);
  notify();
  for (const guest of state.people) {
    if (!isWaitingGuest(guest) || waitedBefore.has(guest.person.userId)) continue;
    for (const listener of joinListeners) listener({ sessionId, person: guest.person });
  }
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
/** Copy the session's live share link; with none, open Share to make one, since a link is never made without asking. */
export async function copyShareLink(sessionId: string) {
  await refreshShare(sessionId);
  const link = states.get(sessionId)?.links?.find((candidate) => !candidate.revoked && candidate.settings.expiresAt > Date.now());
  if (link) await copyText(link.url);
  else openSessionShare(sessionId);
}
/**
 * A new link's settings (PRO-162): guests read only, and each one waits for the
 * host to admit them. Driving the session, or joining unseen, is for the host
 * to turn on for a link, never what a forwarded link does by default.
 */
export function defaultShareSettings(): ShareSettings {
  return {
    audience: "anyone",
    role: "viewer",
    people: [],
    expiresAt: Date.now() + 3_600_000,
    approveEachPerson: true,
    canApprove: false,
    maximumPeople: 8,
    singleUse: false,
  };
}
