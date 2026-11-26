import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { CloudApiError, NotSentSignedOutError } from "../cloud/api";
import type { AccountDeletionRead } from "./deletion";
import { rememberPendingDeletion } from "./pending-deletion";

/**
 * A deletion this phone confirmed and has not seen to its end (PRO-584). It is
 * written as the confirm is sent, so leaving the page while running cloud
 * workspaces stop, or the app being closed, does not lose it: on the next
 * start, and each time the app comes to the front, the server is asked how it
 * ended, and a scheduled deletion is settled on the phone as the page would
 * (Settings says the day, the account is forgotten here). Only the account's
 * id and the day are kept.
 */
const KEY = "terminalx:account-deletion-confirmed:v1";
/** How often a confirmation still stopping workspaces is asked about while the app is in front. */
export const SETTLE_POLL_MS = 5_000;

export interface ConfirmedDeletion { userId: string; deleteAfter: number | null }

let pageOpen = false;
const closedListeners = new Set<() => void>();
/** The page follows its own confirmation while it is open; the check here waits until it closes, then runs at once. */
export function setDeletionPageOpen(open: boolean): void {
  const closing = pageOpen && !open;
  pageOpen = open;
  if (closing) for (const listener of [...closedListeners]) listener();
}

export async function rememberConfirmedDeletion(value: ConfirmedDeletion): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(value)).catch(() => undefined);
}

export async function forgetConfirmedDeletion(): Promise<void> {
  await AsyncStorage.removeItem(KEY).catch(() => undefined);
}

export async function readConfirmedDeletion(): Promise<ConfirmedDeletion | null> {
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return null;
    const { userId, deleteAfter } = parsed as { userId?: unknown; deleteAfter?: unknown };
    if (typeof userId !== "string" || !userId) return null;
    return { userId, deleteAfter: typeof deleteAfter === "number" && Number.isFinite(deleteAfter) ? deleteAfter : null };
  } catch {
    return null;
  }
}

export interface SettleDeps {
  api: { accountDeletion(): Promise<AccountDeletionRead> } | null;
  userId: string | null;
  forgetDeletedAccount(): Promise<void>;
}

/** What became of a confirmation left unsettled: `waiting` while the server is still stopping workspaces. */
export type SettleOutcome = "none" | "scheduled" | "waiting" | "ended" | "unknown";

export async function settleConfirmedDeletion({ api, userId, forgetDeletedAccount }: SettleDeps): Promise<SettleOutcome> {
  const confirmed = await readConfirmedDeletion();
  if (!confirmed) return "none";
  // Another account is signed in: that one's confirmation was cancelled by this sign-in, or ended long ago.
  if (userId && confirmed.userId !== userId) {
    await forgetConfirmedDeletion();
    return "ended";
  }
  if (!api || !userId) return "unknown";
  const scheduled = async (deleteAfter: number | null) => {
    await forgetConfirmedDeletion();
    if (deleteAfter !== null) await rememberPendingDeletion(deleteAfter);
    await forgetDeletedAccount();
    return "scheduled" as const;
  };
  let read: AccountDeletionRead;
  try {
    read = await api.accountDeletion();
  } catch (error) {
    // The server signed this session out: the deletion was scheduled. A 401 the phone made up says nothing.
    if (error instanceof CloudApiError && error.status === 401 && !(error instanceof NotSentSignedOutError)) return scheduled(confirmed.deleteAfter);
    return "unknown";
  }
  const attempt = read.deletion;
  const at = Date.parse(attempt?.deleteAfter ?? "");
  const deleteAfter = Number.isFinite(at) ? at : confirmed.deleteAfter;
  if (attempt?.state === "stopping") {
    if (deleteAfter !== confirmed.deleteAfter) await rememberConfirmedDeletion({ userId, deleteAfter });
    return "waiting";
  }
  if (attempt?.state === "scheduled") return scheduled(deleteAfter);
  // Refused, cancelled, already being deleted, or nothing: there is nothing more for the phone to settle.
  await forgetConfirmedDeletion();
  return "ended";
}

/**
 * Settles a confirmation left unsettled, at the app's root: on start, when the app comes to the front, and every
 * few seconds while the server is still stopping workspaces. Nothing is asked while the page is open.
 */
export function useSettleConfirmedDeletion(deps: SettleDeps): void {
  const latest = useRef(deps);
  useEffect(() => { latest.current = deps; });
  const { api, userId } = deps;
  useEffect(() => {
    if (!api || !userId) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    const check = async () => {
      if (!current || running || pageOpen || AppState.currentState !== "active") return;
      running = true;
      const outcome = await settleConfirmedDeletion(latest.current).catch((): SettleOutcome => "unknown");
      running = false;
      if (current && outcome === "waiting") timer = setTimeout(() => void check(), SETTLE_POLL_MS);
    };
    void check();
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") void check(); });
    const onPageClosed = () => void check();
    closedListeners.add(onPageClosed);
    return () => { current = false; if (timer) clearTimeout(timer); subscription.remove(); closedListeners.delete(onPageClosed); };
  }, [api, userId]);
}
