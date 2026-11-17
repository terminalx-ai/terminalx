import { useSyncExternalStore } from "react";
import type { PrCheck } from "./api";
import { checkBucket } from "./checks";

/**
 * What the right panel's tab row says of tabs not on screen (PRO-394): the
 * number of files the Changes view lists, and whether the session's pull
 * request has a failing check (Checks gets a red dot) or one still running.
 * Whoever reads them (the Changes view, the PR panel, the header's Git
 * button) notes them here, by key.
 */
export type ChecksMark = "failed" | "running" | "passed";

const checks = new Map<string, ChecksMark | null>();
const changes = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The worst state among `list`: a failure wins, then a check still running. */
export function checksMarkOf(list: readonly PrCheck[] | null | undefined): ChecksMark | null {
  if (!list?.length) return null;
  const buckets = list.map((check) => checkBucket(check.state));
  return buckets.includes("failed") ? "failed" : buckets.includes("running") ? "running" : "passed";
}

/** Noted by session id. */
export function noteChecksMark(sessionId: string, mark: ChecksMark | null) {
  if ((checks.get(sessionId) ?? null) === mark) return;
  checks.set(sessionId, mark);
  emit();
}

export function useChecksMark(sessionId: string | undefined): ChecksMark | null {
  return useSyncExternalStore(subscribe, () => (sessionId ? checks.get(sessionId) ?? null : null), () => null);
}

/** Noted by the Git source's key: the files the Changes view lists now. */
export function noteChangesCount(sourceKey: string, count: number | null) {
  if (count == null ? !changes.has(sourceKey) : changes.get(sourceKey) === count) return;
  if (count == null) changes.delete(sourceKey);
  else changes.set(sourceKey, count);
  emit();
}

export function useChangesCount(sourceKey: string | undefined): number | null {
  return useSyncExternalStore(subscribe, () => (sourceKey ? changes.get(sourceKey) ?? null : null), () => null);
}

/**
 * Whether the Checks tab's PR draft is on screen for `cwd` with its own Push
 * and create button. Only then is the branch's Push step left out below it:
 * when GitHub can't be read or the draft can't create, Push stays (PRO-394).
 */
const draftPushes = new Set<string>();
export function noteDraftPushes(cwd: string, shown: boolean) {
  if (draftPushes.has(cwd) === shown) return;
  if (shown) draftPushes.add(cwd);
  else draftPushes.delete(cwd);
  emit();
}

export function useDraftPushes(cwd: string): boolean {
  return useSyncExternalStore(subscribe, () => draftPushes.has(cwd), () => false);
}

/** Forget everything (tests). */
export function resetPanelMarks() {
  checks.clear();
  changes.clear();
  draftPushes.clear();
}
