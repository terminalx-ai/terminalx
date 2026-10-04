import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { agent, api } from "@/lib/api";
import { getSessions, patchTab } from "@/lib/sessions";
import { noteStatusChange } from "@/lib/notify";
import { onAppResume } from "@/lib/appResume";
import type { AgentEvent, BlockRef } from "@/types/events";
import type { TabStatus } from "@/types/session";

/**
 * Per-tab event logs and streaming previews, kept in a module store.
 *
 * Committed events go into `events`; deltas go into `stream`, keyed by block,
 * and are dropped when the block's committed event arrives. Tokens arrive many
 * times per frame, so listeners are notified once per animation frame.
 */
export interface StreamBlock {
  ref: BlockRef;
  kind: "text" | "thinking" | "tool_use" | "other";
  text: string;
  partialJson: string;
  done: boolean;
  toolName?: string;
  toolId?: string;
}

export interface TabLog {
  loaded: boolean;
  events: AgentEvent[];
  stream: StreamBlock[];
  status: TabStatus;
  version: number;
}

const EMPTY: TabLog = { loaded: false, events: [], stream: [], status: "idle", version: 0 };
const logs = new Map<string, TabLog>();
const listeners = new Map<string, Set<() => void>>();
const dirty = new Set<string>();
let frame: number | null = null;

function key(sessionId: string, tabId: string) {
  return `${sessionId}/${tabId}`;
}

function flush() {
  frame = null;
  const keys = [...dirty];
  dirty.clear();
  for (const k of keys) {
    const log = logs.get(k);
    if (log) logs.set(k, { ...log, version: log.version + 1 });
    for (const l of listeners.get(k) ?? []) l();
  }
}

function touch(k: string, immediate = false) {
  dirty.add(k);
  if (immediate) {
    if (frame != null) cancelAnimationFrame(frame);
    flush();
    return;
  }
  if (frame == null) frame = requestAnimationFrame(flush);
}

function getLog(k: string): TabLog {
  let l = logs.get(k);
  if (!l) {
    l = { ...EMPTY, events: [], stream: [] };
    logs.set(k, l);
  }
  return l;
}

function sameBlock(a: BlockRef, b: BlockRef) {
  return a.messageId === b.messageId && a.index === b.index;
}

export function applyEvent(ev: AgentEvent) {
  const k = key(ev.sessionId, ev.tabId);
  const log = getLog(k);
  const p = ev.payload;
  // The send reply and the broadcast both carry the reader's own prompt.
  if (p.type !== "delta") {
    for (let i = log.events.length - 1; i >= Math.max(0, log.events.length - 8); i--) {
      if (log.events[i].id === ev.id) return;
    }
  }
  if (p.type === "delta") {
    if (ev.subagent) return; // one preview per tab; subagent output is drawn from committed events
    let b = log.stream.find((s) => sameBlock(s.ref, p.block));
    switch (p.delta) {
      case "block_start": {
        const kind = p.blockType === "text" ? "text" : p.blockType === "thinking" ? "thinking" : p.blockType === "tool_use" ? "tool_use" : "other";
        if (!b) log.stream.push({ ref: p.block, kind, text: "", partialJson: "", done: false });
        else b.kind = kind;
        break;
      }
      case "text_delta":
        if (!b) log.stream.push((b = { ref: p.block, kind: "text", text: "", partialJson: "", done: false }));
        b.text += p.text;
        break;
      case "thinking_delta":
        if (!b) log.stream.push((b = { ref: p.block, kind: "thinking", text: "", partialJson: "", done: false }));
        b.text += p.text;
        break;
      case "input_delta":
        if (!b) log.stream.push((b = { ref: p.block, kind: "tool_use", text: "", partialJson: "", done: false }));
        b.partialJson += p.partialJson;
        break;
      case "block_stop":
        if (b) b.done = true;
        break;
    }
    touch(k);
    return;
  }
  if (p.type === "status" && p.text.startsWith("tool_pending:")) {
    const [, id, name] = p.text.split(":");
    const b = log.stream.find((s) => s.kind === "tool_use" && !s.toolId);
    if (b) {
      b.toolId = id;
      b.toolName = name;
    }
    touch(k);
    return;
  }
  if (p.type === "usage_update" || p.type === "model_request_started") {
    log.events.push(ev);
    touch(k);
    return;
  }
  // A committed event retires the preview of its block.
  if ((p.type === "assistant_text" || p.type === "reasoning") && p.block) {
    log.stream = log.stream.filter((s) => !sameBlock(s.ref, p.block!));
  }
  if (p.type === "tool_call_started") {
    log.stream = log.stream.filter((s) => !(s.kind === "tool_use" && (s.toolId === p.callId || s.done)));
  }
  if (p.type === "turn_completed" || p.type === "user_message") {
    log.stream = [];
  }
  log.events.push(ev);
  if (p.type === "recovery" && p.kind) setTabStatus(ev.sessionId, ev.tabId, "waiting");
  const urgent = p.type === "recovery" || p.type === "permission_requested" || p.type === "questions_asked" || p.type === "turn_completed";
  touch(k, urgent);
}

export async function loadTab(sessionId: string, tabId: string) {
  const k = key(sessionId, tabId);
  const log = getLog(k);
  if (log.loaded) return;
  const events = await agent.loadEvents(sessionId, tabId);
  const fresh = getLog(k);
  // Events that streamed in while loading are newer than the file; keep them.
  const seen = new Set(events.map((e) => e.id));
  fresh.events = [...events, ...fresh.events.filter((e) => !seen.has(e.id))];
  fresh.loaded = true;
  touch(k, true);
}

/** The tab's log as it stands, outside React. */
export function getTabLog(sessionId: string, tabId: string): TabLog {
  return logs.get(key(sessionId, tabId)) ?? EMPTY;
}

/** Indicators the runtime never saves; their seq may be reused after it restarts. */
function transient(ev: AgentEvent) {
  return ev.payload.type === "usage_update" || ev.payload.type === "model_request_started";
}

/**
 * Merge committed events: a cached or checkpointed transcript, or a replay
 * that may overlap what is already shown. Events are the same event only by
 * id (a newer copy wins). A seq alone proves nothing: a restarted runtime
 * reuses the seqs of indicators it never saved, so a saved event replaces a
 * transient one at its seq instead of being dropped as a duplicate.
 */
export function mergeTabEvents(sessionId: string, tabId: string, events: AgentEvent[]) {
  const k = key(sessionId, tabId);
  const log = getLog(k);
  const committed = events.filter((ev) => ev.payload.type !== "delta");
  if (committed.length) {
    const byId = new Map(log.events.map((ev) => [ev.id, ev]));
    for (const ev of committed) byId.set(ev.id, ev);
    const savedSeqs = new Set([...byId.values()].filter((ev) => !transient(ev)).map((ev) => ev.seq));
    log.events = [...byId.values()]
      .filter((ev) => !(transient(ev) && savedSeqs.has(ev.seq)))
      .sort((a, b) => a.seq - b.seq);
    const last = log.events[log.events.length - 1]?.payload.type;
    if (last === "turn_completed" || last === "user_message") log.stream = [];
  }
  log.loaded = true;
  touch(k, true);
}

/** The newest committed seq of a tab's log (0 when empty). */
export function lastSeq(sessionId: string, tabId: string): number {
  const events = getTabLog(sessionId, tabId).events;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].payload.type !== "delta") return events[i].seq;
  return 0;
}

/** Forget a tab's log, e.g. a cloud tab that was closed. */
export function dropTabLog(sessionId: string, tabId: string) {
  const k = key(sessionId, tabId);
  logs.delete(k);
  touch(k, true);
}

export function setTabStatus(sessionId: string, tabId: string, status: TabStatus) {
  const k = key(sessionId, tabId);
  const log = getLog(k);
  log.status = status;
  const session = getSessions().sessions.find((s) => s.id === sessionId);
  const tab = session?.tabs.find((t) => t.id === tabId);
  const prev = tab?.status ?? "idle";
  patchTab(sessionId, tabId, { status });
  touch(k, true);
  if (session && tab && prev !== status) noteStatusChange(session, { ...tab, status }, prev, status);
}

export function useTabLog(sessionId: string, tabId: string): TabLog {
  const k = key(sessionId, tabId);
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(k);
      if (!set) listeners.set(k, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    () => logs.get(k) ?? EMPTY,
    () => EMPTY,
  );
}

let subscribed = false;
let reconciling = false;

/** Read saved history again after suspension; never send input or restart work. */
export async function reconcileAgentEvents() {
  if (reconciling) return;
  reconciling = true;
  // A frame requested before suspension need not be delivered on resume.
  if (frame !== null) cancelAnimationFrame(frame);
  flush();
  try {
    const before = getSessions().sessions;
    try {
      const sessions = await api.listSessions();
      for (const session of sessions) {
        for (const tab of session.tabs) {
          const old = before.find((s) => s.id === session.id)?.tabs.find((t) => t.id === tab.id);
          const current = getSessions().sessions.find((s) => s.id === session.id)?.tabs.find((t) => t.id === tab.id);
          // A live update during the read wins over its snapshot. Only status
          // is reconciled here; recovery must not close panes or change drafts.
          if (old && old === current && old.status !== tab.status) setTabStatus(session.id, tab.id, tab.status);
        }
      }
    } catch { /* Keep the last verified state when the backend is unavailable. */ }
    for (const session of getSessions().sessions) {
      for (const tab of session.tabs) {
        const k = key(session.id, tab.id);
        if (!logs.get(k)?.loaded || !listeners.get(k)?.size) continue;
        try {
          const events = await agent.loadEvents(session.id, tab.id);
          // Navigation/closure while the read was pending must not resurrect a log.
          if (logs.has(k)) mergeTabEvents(session.id, tab.id, events);
        } catch {
          // Keep the existing conversation; a later resume retries the read.
        }
      }
    }
  } finally {
    reconciling = false;
  }
}

export async function subscribeAgentEvents() {
  if (subscribed) return;
  subscribed = true;
  onAppResume(() => void reconcileAgentEvents());
  try {
    await listen<AgentEvent>("agent_event", (e) => applyEvent(e.payload));
    await listen<{ sessionId: string; tabId: string; status: TabStatus }>("tab_status", (e) =>
      setTabStatus(e.payload.sessionId, e.payload.tabId, e.payload.status),
    );
  } catch {
    /* not in a webview */
  }
}

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
