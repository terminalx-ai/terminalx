import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * Files dragged in from outside reach the app through the Tauri window, not
 * the DOM (`dragDropEnabled`), and a webview has one such stream. This is its
 * only subscriber: it finds what is under the pointer and hands the drop to
 * that target alone, so a file dropped on a terminal is never also attached
 * to a composer.
 */
export interface FileDropTarget {
  /** The element a drop has to land on. */
  element: () => Element | null;
  /**
   * Also take drops that land on no other target, while `element` is shown:
   * a composer accepts a file dropped anywhere else in the window.
   */
  anywhere?: boolean;
  /** Something dragged is, or is no longer, headed for this target: files, or (with no paths) text from another app. */
  onDragChange: (over: boolean, kind: "files" | "text") => void;
  /** `paths` is empty when what was dropped is not files. */
  onDrop: (paths: string[]) => void | Promise<void>;
}

type Position = { x: number; y: number };
type DragDropPayload = { type: "enter" | "over" | "drop" | "leave"; paths?: string[]; position?: Position };

const targets = new Set<FileDropTarget>();
let subscription: { stop: () => void } | null = null;
/** Only the start of a drag says what it carries. */
let kind: "files" | "text" = "files";

function elementAt(position: Position | undefined): Element | null {
  if (!position || typeof document.elementFromPoint !== "function") return null;
  // Both are labelled physical, but on macOS the position is in points
  // (which are CSS pixels) and elsewhere in device pixels.
  const scale = /Mac/i.test(navigator.platform) ? 1 : window.devicePixelRatio || 1;
  return document.elementFromPoint(position.x / scale, position.y / scale);
}

function shown(target: FileDropTarget): boolean {
  const el = target.element();
  // jsdom has no checkVisibility; a missing element cannot say it is hidden.
  return !el || typeof el.checkVisibility !== "function" || el.checkVisibility();
}

/** The targets a file at `position` would go to: the one under it, else every shown `anywhere` target. */
function targetsAt(position: Position | undefined): FileDropTarget[] {
  const hit = elementAt(position);
  if (hit) {
    const under = [...targets].filter((target) => target.element()?.contains(hit));
    const exact = under.find((target) => !target.anywhere) ?? under[0];
    if (exact) return [exact];
  }
  return [...targets].filter((target) => target.anywhere && shown(target));
}

async function route(payload: DragDropPayload) {
  if (payload.type === "enter") kind = payload.paths && !payload.paths.length ? "text" : "files";
  if (payload.type === "leave") {
    for (const target of targets) target.onDragChange(false, kind);
    return;
  }
  const receivers = targetsAt(payload.position);
  if (payload.type === "drop") {
    for (const target of targets) target.onDragChange(false, kind);
    await Promise.all(receivers.map((target) => target.onDrop(payload.paths ?? [])));
    return;
  }
  for (const target of targets) target.onDragChange(receivers.includes(target), kind);
}

function subscribe() {
  let off: (() => void) | null = null;
  let disposed = false;
  // Called from two places — the last target leaving and the late-resolving
  // registration — and Tauri throws if a listener is dropped twice.
  const stop = () => {
    const fn = off;
    off = null;
    try {
      fn?.();
    } catch {
      /* already gone */
    }
  };
  void (async () => {
    try {
      const fn = await getCurrentWebview().onDragDropEvent((e) => route(e.payload as DragDropPayload));
      off = fn;
      if (disposed) stop();
    } catch {
      /* outside a webview */
    }
  })();
  return {
    stop: () => {
      disposed = true;
      stop();
    },
  };
}

/** Take file drops for as long as the returned function has not been called. */
export function registerFileDropTarget(target: FileDropTarget): () => void {
  targets.add(target);
  subscription ??= subscribe();
  return () => {
    targets.delete(target);
    if (targets.size) return;
    subscription?.stop();
    subscription = null;
  };
}
