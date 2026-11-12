import { useSyncExternalStore } from "react";
import { errorMessage } from "@/lib/api";

/**
 * Failed actions, said where the reader will see them (PRO-326). Any part of
 * the app calls `showError` with what it could not do and the error it got;
 * the toast area shows it as "Something went wrong" until the reader closes
 * it, with the full text one click from the clipboard for a bug report.
 *
 * Only what the failing call reported is shown: the action, written by the
 * caller, and the error's own message. Nothing else is gathered.
 */
export interface ErrorToast {
  id: string;
  /** What could not be done, to what: "Couldn't remove “web” from TerminalX". */
  action: string;
  /** The underlying error, as the failing call reported it. */
  cause: string;
  /** How many times this same error was raised while it was showing. */
  count: number;
  at: number;
}

let toasts: ErrorToast[] = [];
let next = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** The text Copy error puts on the clipboard: the toast's sentence, whole. */
export function errorToastText(toast: Pick<ErrorToast, "action" | "cause">): string {
  return toast.cause ? `${toast.action}: ${toast.cause}` : `${toast.action}.`;
}

/**
 * Raise an error toast. The same action failing the same way again does not
 * stack a copy: the toast already showing counts it and moves to the end.
 * Returns the toast's id.
 */
export function showError(action: string, cause?: unknown): string {
  const what = action.trim().replace(/[.:]+$/, "");
  const why = cause === undefined || cause === null ? "" : errorMessage(cause).trim();
  const same = toasts.find((toast) => toast.action === what && toast.cause === why);
  if (same) {
    const bumped = { ...same, count: same.count + 1, at: Date.now() };
    toasts = [...toasts.filter((toast) => toast.id !== same.id), bumped];
    emit();
    return same.id;
  }
  const id = `error:${++next}`;
  toasts = [...toasts, { id, action: what, cause: why, count: 1, at: Date.now() }];
  emit();
  return id;
}

export function dismissError(id: string) {
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function getErrorToasts(): ErrorToast[] {
  return toasts;
}

export function subscribeErrorToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useErrorToasts(): ErrorToast[] {
  return useSyncExternalStore(subscribeErrorToasts, getErrorToasts, getErrorToasts);
}

/** A promise's failure as an error toast: `void work().catch(reportError("Couldn't pin “web”"))`. */
export const reportError = (action: string) => (cause: unknown) => { showError(action, cause); };
