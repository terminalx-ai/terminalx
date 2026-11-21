import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/api";
import type { Handoff, HandoffList, TeamBrief } from "@/types/botHandoffs";

/**
 * Hand-offs between bots and the team brief (PRO-475). Read only by the views that show them, which exist only while
 * Settings → Experimental → Bots is on: with it off nothing here listens or asks the app for anything.
 */
export const botHandoffsApi = {
  /** The hand-offs a bot gave or was given, newest first. */
  list: (id: string) => invoke<HandoffList>("bot_handoffs", { id }),
  /** Stop one hand-off: only the receiving bot's work on it stops. */
  stop: (number: number) => invoke<{ handoff: Handoff }>("bot_handoff_stop", { number }),
  /** Hand a bot's item to another bot, with the owner's own note. Needs the window's proof. */
  hand: (id: string, number: number, to: string, note: string, due: string) => invoke<{ handoff: Handoff }>("bot_item_hand", { id, number, to, note, due: due || null }),
  brief: () => invoke<TeamBrief>("bot_brief"),
  /** Needs the window's proof. `expected` is the hash the edit started from. */
  writeBrief: (text: string, expected: string | null) => invoke<TeamBrief>("bot_brief_write", { text, expected }),
};

function reason(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Calls `read` now, whenever `event` arrives, and when the live connection comes back, while mounted. */
function useReadOn<T>(key: string | null, event: string, read: () => Promise<T>): { value: T | null; error: string | null; reload: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const load = () => Promise.resolve().then(read).then((next) => { if (live) { setValue(next); setError(null); } }, (cause) => { if (live) setError(reason(cause)); });
    void load();
    // A listener that cannot be set up (no app behind the page) only means no live updates.
    const quiet = () => undefined;
    const stops: Promise<() => void>[] = [event, "local_runtime_reattached"].map((name) => listen(name, () => void load()).catch(() => quiet));
    return () => {
      live = false;
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
    // `read` follows `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, event, tick]);
  return { value, error, reload: () => setTick((value) => value + 1) };
}

/** Bot `botId`'s hand-offs, read again whenever any changes. */
export function useBotHandoffs(botId: string | null) {
  const { value, error, reload } = useReadOn(botId, "bot_handoffs_changed", () => botHandoffsApi.list(botId ?? ""));
  return { list: value, error, reload };
}

export function useTeamBrief(enabled = true) {
  const { value, error, reload } = useReadOn(enabled ? "brief" : null, "bot_brief_changed", () => botHandoffsApi.brief());
  return { brief: value, error, reload };
}

export function handoffOpen(handoff: Pick<Handoff, "state">): boolean {
  return !["answered", "failed", "stopped"].includes(handoff.state);
}

/** "Working · 40s", "Waiting · Sentry is paused", "Answered", or a state a newer app wrote as itself. */
export function handoffStateLabel(handoff: Handoff, toName: string, now = Date.now()): string {
  switch (handoff.state) {
    case "waiting":
      return `Waiting · ${toName} is paused`;
    case "working":
      return `Working · ${elapsed(handoff.started ?? handoff.created, now)}`;
    case "answered":
      return "Answered";
    case "failed":
      if (handoff.stoppedBy === "deleted") return "Failed · its bot was deleted";
      return handoff.answer?.by === "terminalx" ? "Failed · not started" : "Could not do it";
    case "stopped":
      return handoff.stoppedBy === "owner" ? "Stopped by you" : "Stopped";
    default:
      return handoff.state;
  }
}

function elapsed(from: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(from).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
