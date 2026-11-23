import { useSyncExternalStore } from "react";

/**
 * An in-app confirmation (design 17.01). The title is the question, the body
 * says what happens, the safe choice is on the left and the action on the right.
 */
export interface ConfirmRequest {
  /** The question, e.g. `Delete "Fix the build"?`. */
  title: string;
  /** What happens. A blank line starts a new paragraph. */
  body?: string;
  /** The action's button, right-most. Return picks it. */
  action: string;
  /** The safe choice's button, left-most. Escape picks it. "Cancel" when absent. */
  cancel?: string;
  /** The action deletes, discards or stops something: its button is red. */
  destructive?: boolean;
  /** A second way forward, between the two (the design's "Quit when idle"). */
  alternative?: string;
}

export type ConfirmAnswer = "action" | "alternative" | "cancel";

export interface PendingConfirm {
  id: number;
  request: ConfirmRequest;
}

let queue: (PendingConfirm & { settle: (answer: ConfirmAnswer) => void })[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

const same = (one: ConfirmRequest, other: ConfirmRequest) =>
  one.title === other.title && one.body === other.body && one.action === other.action && one.cancel === other.cancel
  && one.alternative === other.alternative && !!one.destructive === !!other.destructive;

/**
 * Ask, and resolve to the button pressed. One question is on screen at a time; later ones wait their turn.
 *
 * A system alert held the window; this card does not stop the shortcuts behind it, so the same key pressed again
 * asks the same thing again. A question already waiting is not queued a second time: the repeat is answered
 * "cancel" at once and the first asker alone acts on the answer, so nothing is asked about, or done, twice.
 */
export function chooseInApp(request: ConfirmRequest, signal?: AbortSignal): Promise<ConfirmAnswer> {
  if (signal?.aborted || queue.some((entry) => same(entry.request, request))) return Promise.resolve("cancel");
  return new Promise((resolve) => {
    const id = ++nextId;
    const withdraw = () => answerConfirm(id, "cancel");
    signal?.addEventListener("abort", withdraw, { once: true });
    queue = [...queue, { id, request, settle: (answer) => {
      signal?.removeEventListener("abort", withdraw);
      resolve(answer);
    } }];
    emit();
  });
}

/** Ask, and resolve to whether the action was chosen. */
export async function confirmInApp(request: ConfirmRequest): Promise<boolean> {
  return (await chooseInApp(request)) === "action";
}

/** The dialog's answer. A question already answered is left alone. */
export function answerConfirm(id: number, answer: ConfirmAnswer) {
  const pending = queue.find((entry) => entry.id === id);
  if (!pending) return;
  queue = queue.filter((entry) => entry !== pending);
  emit();
  pending.settle(answer);
}

const current = (): PendingConfirm | null => queue[0] ?? null;

/** The question to draw now, for the one host each window mounts. */
export function usePendingConfirm(): PendingConfirm | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current,
    current,
  );
}

/** What is being asked right now, for tests. */
export function pendingConfirm(): PendingConfirm | null {
  return current();
}
