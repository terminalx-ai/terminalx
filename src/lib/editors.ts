import { useSyncExternalStore } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import mediaTypes from "./mediaTypes.json";
import { extOf, fileName } from "@/lib/paths";
import type { ChangeRange } from "./changes";
import type { PrAssociation } from "./api";
import { discardStashedBuffers } from "@/lib/workspaceFiles";
import { clearSelectedReview, getTerminalState, selectSessionTab } from "@/lib/terminal";

/**
 * Files live beside the transcript; diff and PR tabs fill the centre. Nothing
 * here persists unsaved text. Review tabs restore their locations after restart;
 * files come back from disk and unsaved buffers are guarded on close.
 */
export type ViewMode = "source" | "preview";

export type FileKind = "text" | "image" | "audio" | "video";

/** Decoder support is runtime-dependent; recognized media never enters a text buffer. SVG stays source. */
export function fileKind(rel: string): FileKind {
  const format = mediaTypes[extOf(rel) as keyof typeof mediaTypes];
  return format?.kind === "image" || format?.kind === "audio" || format?.kind === "video" ? format.kind : "text";
}

interface EditorBase {
  id: string;
  created?: string;
  sessionId: string;
  /** Session workspace captured when the file was opened; browser links stay scoped here. */
  workspaceRoot: string;
  /** Absolute project root the relative path hangs off. */
  root: string;
  /**
   * The file source (lib/workspaceFiles) for a cloud workspace's file; the
   * local checkout at `root` when absent.
   */
  source?: string;
  rel: string;
  name: string;
  dirty: boolean;
  /** Text mode only; media surfaces are always read-only. */
  viewMode: ViewMode;
  /** Set to scroll to a place; bumped `nonce` re-fires it on a re-open. */
  jump?: { line: number; col?: number; nonce: number };
}

export interface FileEditorEntry extends EditorBase {
  kind: FileKind;
  /**
   * A file attached to a sent message (PRO-290, screen 03.22): read-only,
   * with Copy and Download in place of Save. `root` is the session's
   * attachments folder, `rel` is `<folder>/<name>`.
   */
  attachment?: AttachmentInfo;
}

export interface AttachmentInfo {
  /** The absolute stored path (`FileRef.path`). */
  path: string;
  /** When the message carrying it was sent (its `messageTs`), for "on your message · HH:MM". */
  sentAt?: string;
}
export type DiffMode = "diff" | "entire" | "preview" | "edit";
export interface DiffEditorEntry extends EditorBase {
  kind: "diff";
  diff: {
    scope: "turn" | "all";
    range: ChangeRange | null;
    oldPath?: string;
    /** A live workspace comparison can be explicitly refreshed. Turn snapshots stay fixed. */
    target?: string | null;
    uncommitted?: boolean;
    /** The fixed snapshot's name in the tab title ("Turn", "Commit 5be01f4"); chips from historical turns must not say "Latest turn". */
    turnLabel?: string;
    mode: DiffMode;
  };
}
export interface PrEditorEntry extends EditorBase { kind: "pr"; pr: PrAssociation }
/** A conflicted file of a merge in progress, resolved one conflict at a time (PRO-293). */
export interface ConflictEditorEntry extends EditorBase {
  kind: "conflict";
  conflict: {
    /** The merge it was opened for: HEAD and the commit being merged. Another merge is not this tab's. */
    head: string;
    mergeHead: string;
    /** Conflicts left in the file at the latest read, for the tab's title. */
    conflicts: number;
  };
}
export type EditorEntry = FileEditorEntry | DiffEditorEntry | PrEditorEntry | ConflictEditorEntry;
export type ReviewEditorEntry = DiffEditorEntry | PrEditorEntry | ConflictEditorEntry;
export function isReviewEditor(entry: EditorEntry): entry is ReviewEditorEntry {
  return entry.kind === "diff" || entry.kind === "pr" || entry.kind === "conflict";
}

const REVIEW_TABS_KEY = "terminalx:review-tabs:v1";

/** Persist only locators, never snapshot contents, PR bodies or unsaved buffers. */
export function serializeReviewTabs(value: Pick<State, "editors" | "active" | "collapsed">): string {
  return JSON.stringify({
    editors: value.editors.filter(isReviewEditor).map((e) => ({ ...e, dirty: false, jump: undefined })),
    active: value.active,
    collapsed: value.collapsed,
  });
}

export function restoreReviewTabs(raw: string | null): Pick<State, "editors" | "active" | "collapsed"> {
  const empty = { editors: [], active: {}, collapsed: {} };
  try {
    const saved = JSON.parse(raw ?? "null");
    if (!saved || !Array.isArray(saved.editors)) return empty;
    const editors: EditorEntry[] = [];
    for (const e of saved.editors) {
      if (!e || ![e.id, e.sessionId, e.root, e.workspaceRoot, e.rel, e.name].every((s) => typeof s === "string")) continue;
      if (e.source || !e.root || editors.some((known) => known.id === e.id)) continue;
      if (e.kind === "diff") {
        const d = e.diff;
        if (!d || !["turn", "all"].includes(d.scope) || !["diff", "entire", "preview", "edit"].includes(d.mode)) continue;
        if (!d.range || typeof d.range.base !== "string" || !(d.range.head === null || typeof d.range.head === "string")) continue;
        if (d.oldPath !== undefined && (typeof d.oldPath !== "string" || !reviewPath(e.root, d.oldPath))) continue;
        if (!reviewPath(e.root, e.rel)) continue;
        if (d.target != null && typeof d.target !== "string") continue;
        if (d.turnLabel !== undefined && typeof d.turnLabel !== "string") continue;
        editors.push({ ...e, created: typeof e.created === "string" ? e.created : undefined, dirty: false, jump: undefined, viewMode: "source", diff: { ...d, mode: d.mode === "edit" ? "diff" : d.mode } });
      } else if (e.kind === "pr" && e.pr?.scope?.kind === "local" && typeof e.pr.scope.cwd === "string"
        && typeof e.pr.url === "string" && typeof e.pr.head === "string" && Number.isSafeInteger(e.pr.number) && e.pr.number > 0) {
        editors.push({ ...e, created: typeof e.created === "string" ? e.created : undefined, dirty: false, jump: undefined });
      } else if (e.kind === "conflict" && reviewPath(e.root, e.rel) && e.conflict && isCommit(e.conflict.head) && isCommit(e.conflict.mergeHead)
        && Number.isSafeInteger(e.conflict.conflicts) && e.conflict.conflicts >= 0) {
        const { head, mergeHead, conflicts } = e.conflict;
        editors.push({ ...e, created: typeof e.created === "string" ? e.created : undefined, dirty: false, jump: undefined, viewMode: "source", name: conflictTabName(e.rel, conflicts), conflict: { head, mergeHead, conflicts } });
      }
    }
    const active: State["active"] = {};
    const collapsed: State["collapsed"] = {};
    for (const e of editors) {
      active[e.sessionId] = editors.some((tab) => tab.sessionId === e.sessionId && tab.id === saved.active?.[e.sessionId]) ? saved.active[e.sessionId] : null;
      collapsed[e.sessionId] = saved.collapsed?.[e.sessionId] === true;
    }
    return { editors, active, collapsed };
  } catch { return empty; }
}

const isCommit = (value: unknown) => typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value);

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

let state: State = { ...restoreReviewTabs((() => {
  try { return localStorage.getItem(REVIEW_TABS_KEY); } catch { return null; }
})()), lastFocused: "chat" };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if (patch.editors || patch.active || patch.collapsed) {
    try { localStorage.setItem(REVIEW_TABS_KEY, serializeReviewTabs(state)); } catch { /* Optional persistence. */ }
  }
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
export function openFile(sessionId: string, root: string, rel: string, at?: { line: number; col?: number }, workspaceRoot = root, source?: string) {
  const existing = state.editors.find((e) => !isReviewEditor(e) && !e.attachment && e.sessionId === sessionId && e.root === root && e.rel === rel);
  const selected = getTerminalState().selected[sessionId];
  if (selected?.kind === "review") clearSelectedReview(sessionId, selected.id);
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
    ...(source ? { source } : {}),
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

/**
 * Open (or focus) a file attached to a sent message (PRO-290) in a centre
 * tab of its session. Stored at `…/attachments/<session>/<folder>/<name>`:
 * the tab hangs off the session's attachments folder with `<folder>/<name>`
 * as its path, so two files of one name sent in different messages are two
 * tabs. Images, audio and video open in the media surfaces; markdown in
 * Preview. Opening it again focuses the tab it already has.
 */
export function openAttachment(sessionId: string, file: { path: string; name: string }, sentAt?: string, workspaceRoot?: string) {
  const parts = file.path.split("/");
  if (parts.length < 4 || !file.path.startsWith("/") || parts.includes("..")) throw new Error("This attachment's path is not a stored file.");
  const root = parts.slice(0, -2).join("/");
  const rel = parts.slice(-2).join("/");
  const id = JSON.stringify([sessionId, "attachment", file.path]);
  const selected = getTerminalState().selected[sessionId];
  if (selected?.kind === "review") clearSelectedReview(sessionId, selected.id);
  const collapsed = { ...state.collapsed, [sessionId]: false };
  if (state.editors.some((e) => e.id === id)) {
    set({ active: { ...state.active, [sessionId]: id }, collapsed });
    return id;
  }
  const entry: FileEditorEntry = {
    id,
    sessionId,
    workspaceRoot: workspaceRoot ?? root,
    root,
    rel,
    name: file.name || fileName(rel),
    dirty: false,
    kind: fileKind(rel),
    viewMode: isMarkdown(rel) ? "preview" : "source",
    attachment: { path: file.path, ...(sentAt ? { sentAt } : {}) },
  };
  set({ editors: [...state.editors, entry], active: { ...state.active, [sessionId]: id }, collapsed });
  return id;
}

export function openReview(entry: ReviewEditorEntry) {
  // Reopening a review focuses its existing buffer without resetting its mode or scroll.
  const existing = state.editors.find((e) => e.id === entry.id);
  if (!existing) set({ editors: [...state.editors, { ...entry, created: entry.created ?? new Date().toISOString() }] });
  else if (entry.kind === "diff" && existing.kind === "diff" && entry.diff.scope === "all") {
    updateDiffRange(entry.id, entry.diff.range, entry.diff.oldPath);
  }
  setActiveEditor(entry.sessionId, entry.id);
  setLastFocused("editor");
  return entry.id;
}

/** A repository diff must never read an absolute path outside its checkout. */
export function reviewPath(root: string, path: string): string | null {
  const prefix = `${root.replace(/\/$/, "")}/`;
  const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.includes("\0") || rel.split(/[\\/]/).includes("..")) return null;
  return rel.replace(/^\.\//, "");
}

export function openDiff(sessionId: string, root: string, rel: string, diff: Omit<DiffEditorEntry["diff"], "mode">) {
  const path = reviewPath(root, rel);
  if (!path || (diff.oldPath && !reviewPath(root, diff.oldPath))) throw new Error("This file is outside the repository.");
  rel = path;
  const id = JSON.stringify([sessionId, root, "diff", rel, diff.scope, diff.scope === "turn" ? diff.range : [diff.target, diff.uncommitted]]);
  if (!diff.range) throw new Error("No snapshots are available for this turn.");
  return openReview({ id, sessionId, root, workspaceRoot: root, rel, name: `${fileName(rel)} · ${diff.scope === "turn" ? diff.turnLabel ?? "Latest turn" : diff.uncommitted ? "Uncommitted changes" : "All changes"}`,
    kind: "diff", dirty: false, viewMode: "source", diff: { ...diff, mode: "diff" } });
}

export function openPr(sessionId: string, root: string, pr: PrAssociation) {
  const id = JSON.stringify([sessionId, root, "pr", pr.url.toLowerCase().replace(/\/$/, "")]);
  return openReview({ id, sessionId, root, workspaceRoot: root, rel: pr.url, name: `PR #${pr.number}`, kind: "pr", dirty: false, viewMode: "source", pr });
}

/** A conflict tab's title: the file's name and what is left to resolve in it. */
export function conflictTabName(rel: string, conflicts: number): string {
  return `${fileName(rel)} · ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"}`;
}

/**
 * Open (or focus) a conflicted file of the merge in progress in a centre tab.
 * One tab per file: reopening it for a newer merge points it at that merge.
 */
export function openConflict(sessionId: string, root: string, rel: string, merge: { head: string; mergeHead: string }, conflicts: number) {
  const path = reviewPath(root, rel);
  if (!path) throw new Error("This file is outside the repository.");
  const id = JSON.stringify([sessionId, root, "conflict", path]);
  const conflict = { head: merge.head, mergeHead: merge.mergeHead, conflicts };
  const existing = state.editors.find((e) => e.id === id);
  if (existing?.kind === "conflict" && (existing.conflict.head !== merge.head || existing.conflict.mergeHead !== merge.mergeHead)) {
    set({ editors: state.editors.map((e) => e.id === id && e.kind === "conflict" ? { ...e, name: conflictTabName(path, conflicts), conflict } : e) });
  }
  return openReview({ id, sessionId, root, workspaceRoot: root, rel: path, name: conflictTabName(path, conflicts), kind: "conflict", dirty: false, viewMode: "source", conflict });
}

/** The conflict tab read its file again: its title follows what is left. */
export function setConflictCount(id: string, conflicts: number) {
  const entry = state.editors.find((e) => e.id === id);
  if (entry?.kind !== "conflict" || entry.conflict.conflicts === conflicts) return;
  set({ editors: state.editors.map((e) => e.id === id && e.kind === "conflict" ? { ...e, name: conflictTabName(e.rel, conflicts), conflict: { ...e.conflict, conflicts } } : e) });
}

export async function setDiffMode(id: string, mode: DiffMode) {
  const entry = state.editors.find((e) => e.id === id);
  if (entry?.kind !== "diff" || entry.diff.mode === mode) return;
  if (entry.diff.mode === "edit" && entry.dirty) {
    const leave = await ask(`${fileName(entry.rel)} has unsaved changes. Leave Edit? Your changes stay in this tab until you save or close it.`,
      { title: "Unsaved changes", kind: "warning", okLabel: "Leave Edit", cancelLabel: "Keep editing" }).catch(() => false);
    if (!leave) return;
  }
  set({ editors: state.editors.map((e) => e.id === id && e.kind === "diff" ? { ...e, diff: { ...e.diff, mode } } : e) });
}

export function updateDiffRange(id: string, range: ChangeRange | null, oldPath?: string) {
  set({ editors: state.editors.map((e) => e.id === id && e.kind === "diff" ? { ...e, diff: { ...e.diff, range, oldPath } } : e) });
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
  if (!e) return true;
  if (e.dirty && !(await confirmDiscard([e.name]))) return false;
  discardStashedBuffers([id]);
  const rest = state.editors.filter((x) => x.id !== id);
  const siblings = rest.filter((x) => x.sessionId === e.sessionId && (e.sessionId.startsWith("checkout:") || !isReviewEditor(x)));
  const wasActive = state.active[e.sessionId] === id;
  // The neighbour to the left takes over, like a browser closing a tab.
  const idx = state.editors.filter((x) => x.sessionId === e.sessionId && (e.sessionId.startsWith("checkout:") || !isReviewEditor(x))).findIndex((x) => x.id === id);
  const next = siblings[Math.max(0, Math.min(idx, siblings.length - 1))]?.id ?? null;
  set({
    editors: rest,
    active: wasActive ? { ...state.active, [e.sessionId]: next } : state.active,
  });
  clearSelectedReview(e.sessionId, id);
  return true;
}

/** Close every editor of a session, asking once if any is unsaved. */
export async function closeAllEditors(sessionId: string, filesOnly = false) {
  const mine = state.editors.filter((x) => x.sessionId === sessionId && (!filesOnly || !isReviewEditor(x)));
  if (!mine.length) return;
  if (!(await confirmDiscard(mine.filter((x) => x.dirty).map((x) => x.name)))) return;
  discardStashedBuffers(mine.map((x) => x.id));
  for (const e of mine) clearSelectedReview(e.sessionId, e.id);
  set({
    editors: state.editors.filter((x) => !mine.some((e) => e.id === x.id)),
    active: { ...state.active, [sessionId]: null },
  });
}

/** Drop editors without asking, e.g. a signed-out identity's cloud files. */
export function dropEditors(match: (entry: EditorEntry) => boolean) {
  const gone = state.editors.filter(match);
  if (!gone.length) return;
  discardStashedBuffers(gone.map((e) => e.id));
  for (const e of gone) clearSelectedReview(e.sessionId, e.id);
  const active = { ...state.active };
  for (const e of gone) if (active[e.sessionId] === e.id) active[e.sessionId] = null;
  set({ editors: state.editors.filter((e) => !match(e)), active });
}

export function setActiveEditor(sessionId: string, id: string | null) {
  const entry = state.editors.find((e) => e.id === id && e.sessionId === sessionId);
  if (entry && isReviewEditor(entry)) {
    selectSessionTab(sessionId, { kind: "review", id: entry.id });
    if (!sessionId.startsWith("checkout:")) return;
  }
  set({ active: { ...state.active, [sessionId]: id }, collapsed: { ...state.collapsed, [sessionId]: false } });
}

/** Called only after the backend's complete session list has arrived. */
export function pruneReviewTabs(sessions: readonly { id: string; worktreeRemoved?: boolean }[]) {
  const kept = new Set(sessions.filter((s) => !s.worktreeRemoved).map((s) => s.id));
  dropEditors((e) => isReviewEditor(e) && !e.sessionId.startsWith("checkout:") && !kept.has(e.sessionId));
}

export function setEditorDirty(id: string, dirty: boolean) {
  const e = state.editors.find((x) => x.id === id);
  if (!e || (e.kind !== "text" && e.kind !== "diff") || e.dirty === dirty || (e.kind === "text" && e.attachment && dirty)) return;
  set({ editors: state.editors.map((x) => (x.id === id ? { ...x, dirty } : x)) });
}

export function setViewMode(id: string, viewMode: ViewMode) {
  set({ editors: state.editors.map((x) => (x.id === id && x.kind === "text" ? { ...x, viewMode } : x)) });
}

/** Flip preview and source for a markdown editor; other files stay as source. */
export function toggleViewMode(id: string) {
  const e = state.editors.find((x) => x.id === id);
  if (!e || e.kind !== "text" || !isMarkdown(e.rel)) return;
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
