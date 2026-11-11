import { useEffect, useSyncExternalStore } from "react";
import { SESSION_STATUSES, combinedSessionStatus, type SessionStatusInput } from "@terminalx/portable/sessionStatus";
import { api } from "./api";
import type { SessionEntry } from "@/types/session";

export type StatusSession = SessionStatusInput & Pick<SessionEntry, "id" | "rowStatus">;

const visible = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: Record<string, SessionStatusInput> = {};
let timer: ReturnType<typeof setTimeout> | undefined;
let reading = false;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

async function refresh() {
  timer = undefined;
  if (reading || !visible.size) return;
  reading = true;
  try {
    if (!document.hidden) {
      const rows = await api.sessionRowStatuses([...visible.keys()]);
      const next = Object.fromEntries(Object.entries(rows).filter(([id]) => visible.has(id)));
      if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
        snapshot = next;
        for (const listener of listeners) listener();
      }
    }
  } catch {
    // An older/disconnected runtime supplies only lifecycle status. Do not
    // keep showing a stale merge-ready or permission verdict after disconnect.
    if (Object.keys(snapshot).length) {
      snapshot = {};
      for (const listener of listeners) listener();
    }
  } finally {
    reading = false;
    if (visible.size) timer = setTimeout(() => void refresh(), 10_000);
  }
}

/** Register rendered rows once, across sidebar, overview and dashboard. */
export function useSessionRowStatus(sessions: readonly StatusSession[]) {
  const key = JSON.stringify(sessions.filter((s) => !s.id.startsWith("cloud:")).map((s) => s.id).sort());
  useEffect(() => {
    const ids: string[] = JSON.parse(key);
    for (const id of ids) visible.set(id, (visible.get(id) ?? 0) + 1);
    if (ids.length && !timer && !reading) timer = setTimeout(() => void refresh(), 0);
    return () => {
      for (const id of ids) {
        const count = (visible.get(id) ?? 1) - 1;
        if (count) visible.set(id, count); else visible.delete(id);
      }
      if (!visible.size) {
        snapshot = {};
        if (timer) { clearTimeout(timer); timer = undefined; }
      }
    };
  }, [key]);
  // Subscribe to this row's selected value: unrelated row changes do not render it.
  const id = useSyncExternalStore(subscribe, () => combinedSessionStatus(sessions.map((session) => snapshot[session.id] ?? session.rowStatus ?? session)).id);
  return SESSION_STATUSES.find((status) => status.id === id)!;
}
