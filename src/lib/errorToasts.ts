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
  /**
   * The toast's own heading, in place of "Something went wrong" (PRO-291):
   * then `action` and `cause` are its body, said apart and not joined.
   */
  title?: string;
  /** What the reader can do about it, beside Copy error: "Try again", "Open settings.json". */
  actions?: ErrorToastAction[];
  /** Raised again under the same key, the toast is updated in place and not stacked. */
  key?: string;
  /**
   * "success": something worked and the reader is told so on the same card
   * (PRO-234 "Thread resolved on GitHub"): a check mark, read out politely,
   * and no Copy error.
   */
  tone?: "success";
}

/**
 * A button on an error toast. `run` doing what failed again closes the toast
 * once it resolves, unless it resolves `false` (it failed again, and said so
 * through the same `key`). `keepOpen` leaves the toast up either way, as
 * opening a file beside it does.
 */
export interface ErrorToastAction {
  label: string;
  icon?: "retry";
  run: () => unknown;
  keepOpen?: boolean;
}

export interface ErrorToastOptions {
  title?: string;
  actions?: ErrorToastAction[];
  key?: string;
  tone?: "success";
}

let toasts: ErrorToast[] = [];
let next = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** The text Copy error puts on the clipboard: the toast's sentence, whole. */
export function errorToastText(toast: Pick<ErrorToast, "action" | "cause" | "title">): string {
  if (toast.title) return [toast.title, toast.action && `${toast.action}.`, toast.cause].filter(Boolean).join("\n");
  return toast.cause ? `${toast.action}: ${toast.cause}` : `${toast.action}.`;
}

/**
 * Raise an error toast. The same action failing the same way again does not
 * stack a copy: the toast already showing counts it and moves to the end.
 * Returns the toast's id.
 */
export function showError(action: string, cause?: unknown, options: ErrorToastOptions = {}): string {
  const what = action.trim().replace(/[.:]+$/, "");
  const why = cause === undefined || cause === null ? "" : errorMessage(cause).trim();
  const { title, actions, key, tone } = options;
  const same = key
    ? toasts.find((toast) => toast.key === key)
    : toasts.find((toast) => !toast.key && toast.action === what && toast.cause === why && toast.title === title);
  if (same) {
    const bumped = { ...same, action: what, cause: why, title, actions, tone, count: same.count + 1, at: Date.now() };
    toasts = [...toasts.filter((toast) => toast.id !== same.id), bumped];
    emit();
    return same.id;
  }
  const id = `error:${++next}`;
  toasts = [...toasts, { id, action: what, cause: why, count: 1, at: Date.now(), ...(title ? { title } : {}), ...(actions?.length ? { actions } : {}), ...(key ? { key } : {}), ...(tone ? { tone } : {}) }];
  emit();
  return id;
}

/** Close the toast raised under `key`, if one is showing: what failed has since worked. */
export function dismissErrorKey(key: string) {
  const toast = toasts.find((candidate) => candidate.key === key);
  if (toast) dismissError(toast.id);
}

/**
 * Run one of a toast's actions. Doing what failed again closes the toast once
 * it worked; a failure leaves it, updated by the action's own report.
 */
export async function runErrorAction(id: string, action: ErrorToastAction): Promise<void> {
  try {
    const worked = await action.run();
    if (!action.keepOpen && worked !== false) dismissError(id);
  } catch (cause) {
    if (action.keepOpen) showError(`Couldn't ${action.label.charAt(0).toLowerCase()}${action.label.slice(1)}`, cause);
    else {
      const toast = toasts.find((candidate) => candidate.id === id);
      if (toast) showError(toast.action, cause, { title: toast.title, actions: toast.actions, key: toast.key, tone: toast.tone });
    }
  }
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
