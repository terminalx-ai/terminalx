import { useSyncExternalStore } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import mediaTypes from "./mediaTypes.json";
import { extOf, fileName } from "@/lib/paths";

/**
 * Open files per session. They live in an editor pane beside the transcript,
 * so reading or editing a file never hides the conversation about it. Nothing
 * here is persisted: the files come back from disk, and an unsaved buffer is
 * guarded on close.
 */
export type ViewMode = "source" | "preview";

export type FileKind = "text" | "image" | "audio" | "video";

/** Decoder support is runtime-dependent; recognized media never enters a text buffer. SVG stays source. */
export function fileKind(rel: string): FileKind {
  const format = mediaTypes[extOf(rel) as keyof typeof mediaTypes];
  return format?.kind === "image" || format?.kind === "audio" || format?.kind === "video" ? format.kind : "text";
}

export interface EditorEntry {
  id: string;
  sessionId: string;
  /** Session workspace captured when the file was opened; browser links stay scoped here. */
  workspaceRoot: string;
  /** Absolute project root the relative path hangs off. */
  root: string;
  rel: string;
  name: string;
  dirty: boolean;
  kind: FileKind;
  /** Text mode only; media surfaces are always read-only. */
  viewMode: ViewMode;
  /** Set to scroll to a place; bumped `nonce` re-fires it on a re-open. */
  jump?: { line: number; col?: number; nonce: number };
}

/** Which region took the last click or focus, so ⌘W closes the right thing. */
export type Region = "chat" | "editor";

interface State {
  editors: EditorEntry[];
  /** session id → the editor shown in the pane */
  active: Record<string, string | null>;
  /** session id → pane hidden while its editors stay open */
  collapsed: Record<string, boolean>;
  lastFocused: Region;
}

let state: State = { editors: [], active: {}, collapsed: {}, lastFocused: "chat" };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useEditors(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

export function getEditors(): State {
  return state;
}

export function isMarkdown(rel: string): boolean {
  const ext = extOf(rel);
  return ext === "md" || ext === "mdx" || ext === "markdown";
}

let nonce = 0;
/**
 * Open (or focus) a file in the session's pane. A jump target implies the
 * reader wants a line, which only source can show, so it forces source mode.
 */
export function openFile(sessionId: string, root: string, rel: string, at?: { line: number; col?: number }, workspaceRoot = root) {
  const existing = state.editors.find((e) => e.sessionId === sessionId && e.root === root && e.rel === rel);
  const kind = fileKind(rel);
  const jump = at && kind === "text" ? { ...at, nonce: ++nonce } : undefined;
  const collapsed = { ...state.collapsed, [sessionId]: false };
  if (existing) {
    set({
      editors: state.editors.map((e) => (e.id === existing.id ? { ...e, workspaceRoot, jump: jump ?? e.jump, viewMode: jump ? "source" : e.viewMode } : e)),
      active: { ...state.active, [sessionId]: existing.id },
      collapsed,
    });
    return existing.id;
  }
  const id = JSON.stringify([sessionId, root, rel]);
  const entry: EditorEntry = {
    id,
    sessionId,
    workspaceRoot,
    root,
    rel,
    name: fileName(rel),
    dirty: false,
    kind,
    viewMode: jump ? "source" : isMarkdown(rel) ? "preview" : "source",
    jump,
  };
  set({ editors: [...state.editors, entry], active: { ...state.active, [sessionId]: id }, collapsed });
  return id;
}

/** Link routing in a Markdown preview uses the document parent for files but the captured session workspace for browser tabs. */
export function editorLinkContext(entry: EditorEntry) {
  const abs = `${entry.root}/${entry.rel}`;
  const separator = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
  return {
    sessionId: entry.sessionId,
    cwd: entry.workspaceRoot,
    basePath: separator > 0 ? abs.slice(0, separator) : entry.root,
  };
}

async function confirmDiscard(names: string[]): Promise<boolean> {
  if (!names.length) return true;
  const what = names.length === 1 ? `${names[0]} has unsaved changes.` : `${names.length} files have unsaved changes.`;
  return ask(`${what} Close and lose them?`, { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep editing" }).catch(() => false);
}

export async function closeEditor(id: string) {
  const e = state.editors.find((x) => x.id === id);
  if (!e) return;
  if (e.dirty && !(await confirmDiscard([e.name]))) return;
  const rest = state.editors.filter((x) => x.id !== id);
  const siblings = rest.filter((x) => x.sessionId === e.sessionId);
  const wasActive = state.active[e.sessionId] === id;
  // The neighbour to the left takes over, like a browser closing a tab.
  const idx = state.editors.filter((x) => x.sessionId === e.sessionId).findIndex((x) => x.id === id);
  const next = siblings[Math.max(0, Math.min(idx, siblings.length - 1))]?.id ?? null;
  set({
    editors: rest,
    active: wasActive ? { ...state.active, [e.sessionId]: next } : state.active,
  });
}

/** Close every editor of a session, asking once if any is unsaved. */
export async function closeAllEditors(sessionId: string) {
  const mine = state.editors.filter((x) => x.sessionId === sessionId);
  if (!mine.length) return;
  if (!(await confirmDiscard(mine.filter((x) => x.dirty).map((x) => x.name)))) return;
  set({
    editors: state.editors.filter((x) => x.sessionId !== sessionId),
    active: { ...state.active, [sessionId]: null },
  });
}

export function setActiveEditor(sessionId: string, id: string | null) {
  set({ active: { ...state.active, [sessionId]: id }, collapsed: { ...state.collapsed, [sessionId]: false } });
}

export function setEditorDirty(id: string, dirty: boolean) {
  const e = state.editors.find((x) => x.id === id);
  if (!e || e.kind !== "text" || e.dirty === dirty) return;
  set({ editors: state.editors.map((x) => (x.id === id ? { ...x, dirty } : x)) });
}

export function setViewMode(id: string, viewMode: ViewMode) {
  set({ editors: state.editors.map((x) => (x.id === id && x.kind === "text" ? { ...x, viewMode } : x)) });
}

/** Flip preview and source for a markdown editor; other files stay as source. */
export function toggleViewMode(id: string) {
  const e = state.editors.find((x) => x.id === id);
  if (!e || !isMarkdown(e.rel)) return;
  setViewMode(id, e.viewMode === "preview" ? "source" : "preview");
}

export function setPaneCollapsed(sessionId: string, collapsed: boolean) {
  set({ collapsed: { ...state.collapsed, [sessionId]: collapsed } });
}

export function setLastFocused(region: Region) {
  if (state.lastFocused !== region) set({ lastFocused: region });
}

export function clearJump(id: string) {
  set({ editors: state.editors.map((x) => (x.id === id ? { ...x, jump: undefined } : x)) });
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
