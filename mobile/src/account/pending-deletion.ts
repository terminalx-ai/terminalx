import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

/**
 * The day this phone's account is deleted, after the person confirmed here
 * (PRO-584, board 26.01 screen 7). The signed-out Settings card says it until
 * that day passes, or until someone signs in, which cancels the deletion.
 * Only the time is kept: no address, no name.
 */
const KEY = "terminalx:account-deletion:v1";

let listeners = new Set<(value: number | null) => void>();
let known: number | null | undefined;

function publish(value: number | null) {
  known = value;
  for (const listener of listeners) listener(value);
}

export async function rememberPendingDeletion(deleteAfter: number): Promise<void> {
  publish(deleteAfter);
  await AsyncStorage.setItem(KEY, JSON.stringify({ deleteAfter })).catch(() => undefined);
}

export async function forgetPendingDeletion(): Promise<void> {
  publish(null);
  await AsyncStorage.removeItem(KEY).catch(() => undefined);
}

/** The stored day, or null when there is none or it has passed (then it is removed). */
export async function readPendingDeletion(now = Date.now()): Promise<number | null> {
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  let value: number | null = null;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const at = parsed && typeof parsed === "object" ? (parsed as { deleteAfter?: unknown }).deleteAfter : null;
    value = typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    value = null;
  }
  if (value !== null && value <= now) {
    await forgetPendingDeletion();
    return null;
  }
  return value;
}

/**
 * The day the signed-out account is deleted, for the Settings card; null
 * while signed in (signing in cancelled it, so it is forgotten).
 */
export function usePendingDeletion(signedIn: boolean): number | null {
  const [value, setValue] = useState<number | null>(known ?? null);
  useEffect(() => {
    let current = true;
    const listener = (next: number | null) => { if (current) setValue(next); };
    listeners.add(listener);
    if (signedIn) void forgetPendingDeletion();
    else void readPendingDeletion().then((stored) => { if (current) { known = stored; setValue(stored); } });
    return () => { current = false; listeners.delete(listener); };
  }, [signedIn]);
  return signedIn ? null : value;
}

/** For tests: start with nothing known. */
export function resetPendingDeletionForTests(): void {
  known = undefined;
  listeners = new Set();
}
