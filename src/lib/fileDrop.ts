import { getCurrentWebview } from "@tauri-apps/api/webview";
import { files as filesApi } from "@/lib/api";

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
   * Also take drops that land on no target, while `element` is shown: a
   * composer accepts a file dropped anywhere else in the window. One of
   * them gets it, never several.
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
  // Labelled physical everywhere, but only Windows reports device pixels:
  // macOS gives points and GTK logical pixels, which are CSS pixels already.
  const scale = /Win/i.test(navigator.platform) ? window.devicePixelRatio || 1 : 1;
  return document.elementFromPoint(position.x / scale, position.y / scale);
}

function shown(target: FileDropTarget): boolean {
  const el = target.element();
  // jsdom has no checkVisibility; a missing element cannot say it is hidden.
  return !el || typeof el.checkVisibility !== "function" || el.checkVisibility();
}

/**
 * The target a file at `position` would go to: the one under it, else one
 * shown `anywhere` target — the one holding the focus, or the newest.
 */
function targetsAt(position: Position | undefined): FileDropTarget[] {
  const hit = elementAt(position);
  if (hit) {
    const under = [...targets].filter((target) => target.element()?.contains(hit));
    const exact = under.find((target) => !target.anywhere) ?? under[0];
    if (exact) return [exact];
  }
  const open = [...targets].filter((target) => target.anywhere && shown(target));
  const one = open.find((target) => target.element()?.contains(document.activeElement)) ?? open.at(-1);
  return one ? [one] : [];
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
    try {
      await Promise.all(receivers.map((target) => target.onDrop(payload.paths ?? [])));
    } finally {
      // The backend kept the text of a drop with no files for whoever takes
      // it. Whatever nobody took is thrown away now, not left to be read later.
      if (!payload.paths?.length) discardDroppedText();
    }
    return;
  }
  for (const target of targets) target.onDragChange(receivers.includes(target), kind);
}

function discardDroppedText() {
  try {
    void filesApi.droppedText().catch(() => {});
  } catch {
    /* outside a webview */
  }
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
