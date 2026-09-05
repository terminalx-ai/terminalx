import type { EditorView } from "@codemirror/view";

/**
 * The live CodeMirror views behind open editor tabs, by absolute path. A
 * project-wide replacement must go through these rather than the disk:
 * writing a file under an open buffer would either be lost on the next save
 * or silently discard what the reader typed. One path can be open in more
 * than one session, so each path holds a set.
 */
export interface LiveEditor {
  view: EditorView;
  /** Whether the buffer differs from the file on disk. */
  isDirty(): boolean;
  /** Write the buffer to disk, as ⌘S would. */
  save(): Promise<void>;
}

const live = new Map<string, Set<LiveEditor>>();

export function registerLiveEditor(abs: string, editor: LiveEditor): () => void {
  let set = live.get(abs);
  if (!set) {
    set = new Set();
    live.set(abs, set);
  }
  set.add(editor);
  return () => {
    const s = live.get(abs);
    if (!s) return;
    s.delete(editor);
    if (!s.size) live.delete(abs);
  };
}

export function liveEditorsFor(abs: string): LiveEditor[] {
  return [...(live.get(abs) ?? [])];
}

/** Every absolute path with an open buffer under `root`. */
export function liveEditorPathsUnder(root: string): string[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return [...live.keys()].filter((p) => p.startsWith(prefix));
}
